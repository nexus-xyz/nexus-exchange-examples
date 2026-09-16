// Exact decimal arithmetic on BigInt, plus the two inexact operations
// statistics cannot avoid.
//
// Copied from `account-statement` rather than imported (CONTRIBUTING.md § 1).
// That copy in turn came from `trading-terminal` / `order-loader`, and it is
// the right ancestor to take: it is the one whose parser does **not** cap the
// fraction digits at 12.
//
// Why any of this exists: `Decimal` in `openapi.json` is `{"type": "string"}`
// and its description is emphatic — *"Arbitrary-precision decimal serialized
// as a string (lossless). Parse with a decimal type, never a float."* A
// funding rate is not money, but it is the thing this app multiplies by 8,760
// and then squares, so a `Number()` on the way in is a `Number()` compounded
// 8,760 times on the way out.
//
// **Three differences from `order-loader`'s copy, all measured rather than
// assumed:**
//
//  1. **There is no low ceiling on the fraction digits.** `order-loader` caps
//     at 12 places, which is right for values it is about to *send* onto a
//     venue grid whose ticks are coarse. It is wrong for values the venue
//     *produces*: `GET /markets/BTC-USDX-PERP/funding` on the live testnet
//     answered with `"funding_rate":"0.0000125000000000000000000000"` — 28
//     fractional digits, on every one of the 173 settled windows it returned,
//     and `"-0.0000997258147684889606605368"` on ETH. A parser that rejected
//     those would refuse the venue's own arithmetic, and one that truncated
//     them would be the exact bug this file exists to prevent.
//
//  2. **`fromWire` accepts a JSON number, and says so.** See its comment: the
//     spec and the server disagree about this on one shape (ENG-8439), and
//     several of the fields near this app's read path are JSON numbers by
//     declaration.
//
//  3. **`divide` and `sqrt` exist, and they are the only inexact operations
//     here.** A mean is a division and a standard deviation is a square root,
//     and neither is exact in decimal at any finite scale. So they are the
//     only two functions in this file that round, they round at one stated
//     working scale (`carry.ts`'s `WORKING_SCALE`), and everything upstream of
//     them — the sums and the sums of squares — is still exact integer
//     arithmetic. What this file will not do is launder that through a
//     `number`: an inexact result at a stated scale is a different thing from
//     a double.

/** A decimal held as an integer coefficient scaled by 10^`scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/**
 * Sanity ceiling on fraction digits. Not a precision limit — `units` is a
 * `BigInt` and the arithmetic below is exact at any scale — just a bound that
 * turns a pathological input into an error instead of a memory problem. The
 * widest value measured from this API is 28 places (see the header), so this
 * is more than double the observed maximum.
 */
const MAX_SCALE = 64;

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export const ZERO: Dec = { units: 0n, scale: 0 };

/**
 * Parse a decimal string exactly.
 *
 * Rejects anything that is not a plain decimal — no exponents, no `Infinity`,
 * no `NaN`, no thousands separators. Every one of those has a plausible-looking
 * `Number()` interpretation, which is precisely why they are refused: this
 * value is about to become money.
 *
 * `"-0"` parses, and parses to zero. The venue emits it: `GET /positions`
 * answered with `"funding_paid":"-0"` on testnet. `Number("-0")` is the
 * negative zero that then formats as `"0"` in some places and `"-0"` in
 * others; here the sign is simply dropped, because a zero has no sign.
 */
export function fromString(text: string): Dec {
  const trimmed = text.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new RangeError(`not a plain decimal number: ${JSON.stringify(text)}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  if (fracPart.length > MAX_SCALE) {
    throw new RangeError(
      `too many decimal places (${fracPart.length} > ${MAX_SCALE}): ${trimmed}`,
    );
  }
  const digits = `${intPart || "0"}${fracPart}`;
  const magnitude = BigInt(digits);
  const units = negative && magnitude !== 0n ? -magnitude : magnitude;
  return { units, scale: fracPart.length };
}

/** How a value actually arrived, as opposed to how the spec says it arrives. */
export type Fidelity = "exact" | "from-json-number";

export interface WireValue {
  readonly value: Dec;
  readonly fidelity: Fidelity;
}

/**
 * Parse a monetary field that the spec types as `Decimal` but that a server
 * may serialise as a JSON number.
 *
 * **This is not defensive programming for its own sake — it is a live
 * divergence.** `PortfolioPoint.equity`, `.pnl` and `.volume` are `$ref:
 * Decimal` (strings) in the spec, and the indexer emits them as JSON numbers:
 * `PortfolioPoint` is declared `{ equity: f64, pnl: f64, volume: f64 }` under
 * a plain `#[derive(Serialize)]`, which writes numbers. The Rust SDK, which
 * was generated *correctly* from the spec, could not deserialize the real
 * response at all until it was taught to accept both (ENG-8439, fixed
 * SDK-side in `nexus-exchange-rs#152`; the server half is still open). This
 * app takes the same position: accept both, and never pretend the two are the
 * same thing.
 *
 * A number is **not** silently upgraded to an exact value. A double that
 * reached us as `12345.5` may have been `12345.500000000000001` before the
 * server rounded it, and nothing on this side can recover that. What is
 * recoverable is the shortest decimal text that round-trips the double
 * (`String(value)`, which is what the JS and Rust implementations both
 * produce), so that is what is parsed — and the result is tagged
 * `"from-json-number"` so every total it feeds can be reported as approximate
 * rather than exact. A statement that quietly promoted a float to "lossless"
 * would be worse than one that never claimed precision at all.
 */
export function fromWire(raw: unknown, field: string): WireValue {
  if (typeof raw === "string") {
    return { value: fromString(raw), fidelity: "exact" };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new RangeError(`${field}: not a finite number: ${String(raw)}`);
    }
    return { value: fromString(plainDecimalText(raw)), fidelity: "from-json-number" };
  }
  throw new TypeError(
    `${field}: expected a decimal string (or, per ENG-8439, a JSON number), got ${typeof raw}`,
  );
}

/**
 * Render a double as plain decimal text, expanding exponent notation.
 *
 * `String(1e21)` is `"1e+21"` and `String(1e-7)` is `"1e-7"`; both are the
 * shortest round-tripping form and neither is a plain decimal, so `fromString`
 * would refuse them. Expanding here rather than loosening `DECIMAL_RE` keeps
 * the strict parser strict for the string path, where an exponent really would
 * be a contract violation worth refusing.
 */
function plainDecimalText(value: number): string {
  // `String(-0)` is already `"0"` in JS, so negative zero needs no special
  // case here; `fromString` drops the sign on a zero anyway.
  const text = String(value);
  if (!/e/i.test(text)) return text;

  const parts = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (parts === null) {
    throw new RangeError(`cannot expand to plain decimal: ${text}`);
  }
  const sign = parts[1] === "-" ? "-" : "";
  const intDigits = parts[2] ?? "0";
  const fracDigits = parts[3] ?? "";
  const exponent = Number(parts[4]);
  const digits = `${intDigits}${fracDigits}`;
  const pointAt = intDigits.length + exponent;

  if (pointAt <= 0) return `${sign}0.${"0".repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointAt - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/** Render as a plain decimal string — the wire form for a `Decimal` field. */
export function toString(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units)
    .toString()
    .padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const intPart = digits.slice(0, cut);
  const fracPart = value.scale === 0 ? "" : `.${digits.slice(cut)}`;
  return `${negative ? "-" : ""}${intPart}${fracPart}`;
}

/** Re-express `value` at exactly `scale` digits. Widening only; never lossy. */
function widen(value: Dec, scale: number): bigint {
  if (scale === value.scale) return value.units;
  return value.units * 10n ** BigInt(scale - value.scale);
}

function commonScale(a: Dec, b: Dec): number {
  return Math.max(a.scale, b.scale);
}

export function add(a: Dec, b: Dec): Dec {
  const scale = commonScale(a, b);
  return { units: widen(a, scale) + widen(b, scale), scale };
}

export function subtract(a: Dec, b: Dec): Dec {
  const scale = commonScale(a, b);
  return { units: widen(a, scale) - widen(b, scale), scale };
}

export function negate(value: Dec): Dec {
  return { units: -value.units, scale: value.scale };
}

export function abs(value: Dec): Dec {
  return value.units < 0n ? negate(value) : value;
}

/** Exact product. Scales add, so nothing is lost. */
export function multiply(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function compare(a: Dec, b: Dec): number {
  const scale = commonScale(a, b);
  const left = widen(a, scale);
  const right = widen(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** -1, 0 or 1. The sign is the whole funding convention, so it gets a name. */
export function sign(value: Dec): -1 | 0 | 1 {
  return value.units < 0n ? -1 : value.units > 0n ? 1 : 0;
}

export function isZero(value: Dec): boolean {
  return value.units === 0n;
}

/** Exact sum. Empty is zero — but see `carry.ts`: an empty *sample* is not
 * ranked at all, so no mean is ever taken of this particular zero. */
export function sum(values: readonly Dec[]): Dec {
  return values.reduce<Dec>(add, ZERO);
}

/**
 * Round to `places` fraction digits, half away from zero, **for display only**.
 *
 * Every caller of this is a formatter. None of the ranking arithmetic goes
 * through it, and the unrounded value stays available beside every rounded
 * one — `--exact` prints the full-scale strings for precisely this reason. A
 * rate rounded on the way *into* a sum of squares is how a dispersion figure
 * ends up being a report on the rounding rather than on the market.
 */
export function roundForDisplay(value: Dec, places: number): Dec {
  if (places >= value.scale) return value;
  const divisor = 10n ** BigInt(value.scale - places);
  const negative = value.units < 0n;
  const magnitude = negative ? -value.units : value.units;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return { units: negative ? -rounded : rounded, scale: places };
}

/** Fixed-width decimal text for a column. Display only — see `roundForDisplay`. */
export function toFixed(value: Dec, places: number): string {
  const rounded = roundForDisplay(value, places);
  const widened = { units: widen(rounded, places), scale: places };
  return toString(widened);
}

// ---------------------------------------------------------------------------
// The inexact half
//
// Everything above is exact. Everything below rounds, because a mean is a
// division and a standard deviation is a square root and neither terminates in
// decimal in general. Both take the working scale as an argument rather than
// having one baked in, so a caller cannot silently inherit somebody else's
// idea of how many digits are enough.
// ---------------------------------------------------------------------------

/** Thrown rather than returning a sentinel: a divide by zero is a bug upstream. */
export class DivideByZeroError extends Error {
  constructor(what: string) {
    super(`${what}: divide by zero`);
    this.name = "DivideByZeroError";
  }
}

export function fromInt(value: number | bigint): Dec {
  return { units: BigInt(value), scale: 0 };
}

/**
 * `a / b`, rounded half away from zero at `places` fraction digits.
 *
 * **This is the first operation in the pipeline that loses information**, and
 * it is unavoidable: `1 / 3` has no decimal representation. What is avoidable
 * is doing it more than once, so every statistic in `carry.ts` is arranged as
 * one exact numerator over one exact denominator with a single call to this at
 * the end — never a chain of intermediate quotients, each rounding again.
 *
 * Half away from zero rather than half to even: the values here are signed
 * rates, and banker's rounding on a symmetric distribution of them would bias
 * the magnitude down in a way that is invisible in the output.
 */
export function divide(a: Dec, b: Dec, places: number, what = "divide"): Dec {
  if (b.units === 0n) throw new DivideByZeroError(what);
  // a/b = (a.units / b.units) * 10^(b.scale - a.scale). Fold the requested
  // output scale in first so the integer division below is the only one.
  const shift = places + b.scale - a.scale;
  let numerator = a.units;
  let denominator = b.units;
  if (shift >= 0) {
    numerator *= 10n ** BigInt(shift);
  } else {
    denominator *= 10n ** BigInt(-shift);
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return { units: negative && rounded !== 0n ? -rounded : rounded, scale: places };
}

/** Integer square root by Newton's method. Exact floor, no float anywhere. */
function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("isqrt of a negative value");
  if (value < 2n) return value;
  // A starting point above the root, from the bit length, so Newton descends
  // monotonically and the loop below terminates on the first non-decrease.
  let guess = 1n << (BigInt(value.toString(2).length) / 2n + 1n);
  for (;;) {
    const next = (guess + value / guess) / 2n;
    if (next >= guess) return guess;
    guess = next;
  }
}

/**
 * Square root, truncated at `places` fraction digits.
 *
 * Truncated rather than rounded, deliberately: this is only ever called on a
 * variance, and the result is a dispersion figure that goes on to be a
 * denominator. Truncating makes the standard deviation the smallest value
 * consistent with the data at that scale, which makes any carry-to-variability
 * ratio built on it the *largest* — so the ranking errs toward flattering a
 * noisy market rather than a quiet one. That is the direction a reader can
 * check; the opposite would quietly promote whichever market happened to round
 * up.
 */
/**
 * `sqrt(a / b)`, truncated at `places` fraction digits, in ONE operation.
 *
 * `sqrt(divide(a, b, places))` is two roundings, not one: the quotient is
 * rounded at `places` and the root then truncates that already-rounded value.
 * @nvizble measured the drift on #25 — 366 ulps at the 30th digit on a
 * 167-sample ETH-shaped array — against the promise this file, `carry.ts` and
 * the README all make, that a value is "rounded once, at the single division
 * or square root that produced it". Two roundings is a chain of intermediate
 * quotients, which is the exact thing `divide`'s own docstring forbids.
 *
 * Here the division happens inside the radicand, at full radicand precision,
 * so the only rounding is the final truncation:
 *
 *   sqrt(a/b) * 10^places = sqrt( a.units * 10^(b.scale - a.scale + 2*places)
 *                                 / b.units )
 *
 * Truncating the radicand before `isqrt` is safe and not a second rounding,
 * because `floor(sqrt(floor(x))) === floor(sqrt(x))` for non-negative integer
 * `x` — the identity @nvizble verified over 240,000 cases when reviewing
 * `isqrt` itself.
 *
 * Truncated rather than rounded for the reason `sqrt` gives below: the result
 * is a dispersion that becomes a denominator, and the smallest value
 * consistent with the data makes any ratio built on it the largest, which is
 * the direction a reader can check.
 */
export function sqrtRatio(a: Dec, b: Dec, places: number, what = "sqrt of a ratio"): Dec {
  if (b.units === 0n) throw new DivideByZeroError(what);
  if (a.units < 0n !== b.units < 0n && a.units !== 0n) {
    throw new RangeError(`${what}: sqrt of a negative ratio`);
  }
  const shift = b.scale - a.scale + 2 * places;
  let numerator = a.units < 0n ? -a.units : a.units;
  let denominator = b.units < 0n ? -b.units : b.units;
  if (shift >= 0) {
    numerator *= 10n ** BigInt(shift);
  } else {
    denominator *= 10n ** BigInt(-shift);
  }
  return { units: isqrt(numerator / denominator), scale: places };
}

export function sqrt(value: Dec, places: number): Dec {
  if (value.units < 0n) {
    throw new RangeError(`sqrt of a negative value: ${toString(value)}`);
  }
  // sqrt(units / 10^scale) * 10^places = sqrt(units * 10^(2*places - scale)).
  const shift = 2 * places - value.scale;
  const radicand =
    shift >= 0
      ? value.units * 10n ** BigInt(shift)
      : value.units / 10n ** BigInt(-shift);
  return { units: isqrt(radicand), scale: places };
}
