// Exact decimal arithmetic for money, on BigInt.
//
// Copied from `trading-terminal` / `order-loader` rather than imported
// (CONTRIBUTING.md § 1), then extended for the two things a *statement* needs
// that an order path does not: addition across thousands of rows, and a
// parser that survives a field arriving as a JSON number when the spec
// promised a string.
//
// Why any of this exists: `Decimal` in `openapi.json` is `{"type": "string"}`
// and its description is emphatic — *"Arbitrary-precision decimal serialized
// as a string (lossless). Parse with a decimal type, never a float."* This app
// is a P&L statement, so that instruction is not stylistic. Every monetary
// value read here reaches the total without ever being a `number`.
//
// **Two differences from `order-loader`'s copy, both measured rather than
// assumed:**
//
//  1. **There is no low ceiling on the fraction digits.** `order-loader` caps
//     at 12 places, which is right for values it is about to *send* onto a
//     venue grid whose ticks are coarse. It is wrong for values the venue
//     *produces*: `GET /account/summary` on the live testnet answered with
//     `"total_equity":"5.732096339790068249192319744"` — 27 fractional
//     digits — and `GET /positions` with a `roe` of 28. A parser that
//     rejected those would refuse the venue's own arithmetic, and one that
//     truncated them would be the exact bug this file exists to prevent.
//
//  2. **`fromWire` accepts a JSON number, and says so.** See its comment: one
//     endpoint on this app's read path disagrees with the spec about this,
//     today, in production.

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

/** Exact sum. Empty is zero, which for a statement line is the honest answer. */
export function sum(values: readonly Dec[]): Dec {
  return values.reduce<Dec>(add, ZERO);
}

/**
 * Round to `places` fraction digits, half away from zero, **for display only**.
 *
 * Every caller of this is a formatter. Nothing in the statement's arithmetic
 * goes through it, and the exact value stays available beside every rounded
 * one — `--exact` prints the unrounded strings for precisely this reason. A
 * total rounded on the way *into* a sum is the classic way a statement ends up
 * off by a cent it cannot explain.
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
