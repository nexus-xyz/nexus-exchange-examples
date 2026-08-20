// Exact decimal arithmetic for money, on BigInt.
//
// Why this file exists at all
// ---------------------------
// The Exchange API is deliberately two-faced about numbers, and the split is
// the single easiest thing to get wrong when you write a client by hand:
//
//   * Anything you **send** that is money — `price`, `quantity` — is a
//     `Decimal`: an arbitrary-precision decimal serialised as a JSON *string*,
//     lossless by construction.
//   * Anything CCXT-shaped that you **read** — the order book's
//     `[price, amount]` pairs, the ticker's `bid`/`ask`/`last` — is a JSON
//     *number*, i.e. an IEEE-754 double, matching what CCXT consumers expect.
//
// So a price makes a round trip through a double on the way in and must be an
// exact decimal on the way out. `62815.5` survives that trip; `0.1 + 0.2` does
// not. The rule this file enforces is: **snap to the tick/lot grid the instant
// a number crosses from the read side to the write side, and stay on integers
// from there.** Once a value is an integer count of ticks, every subsequent
// operation is exact and the string you send back is exactly the value you
// computed.
//
// Everything here is integer maths on BigInt. There is no float arithmetic in
// this module beyond the one documented crossing point, `fromNumber`.

/** A decimal held as an integer coefficient scaled by 10^`scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/**
 * Largest number of fractional digits accepted anywhere in this app.
 *
 * The venue's tick sizes are coarse (`0.5` for BTC, `0.10` for ETH) and lot
 * sizes are at most 3 decimal places, so 12 is far past anything the API
 * produces. It exists as a ceiling, not a target: input with more precision is
 * *rejected* rather than rounded, because silently dropping digits off a price
 * is how a client places an order it did not mean to place.
 */
const MAX_SCALE = 12;

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string exactly.
 *
 * Rejects anything that is not a plain decimal — no exponents, no `Infinity`,
 * no `NaN`, no thousands separators, no whitespace. Every one of those has a
 * plausible-looking `Number()` interpretation, which is precisely why they are
 * refused here: this value is about to become money.
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
  const units = BigInt(digits) * (negative ? -1n : 1n);
  return { units, scale: fracPart.length };
}

/**
 * Convert a JSON number from the API into an exact decimal.
 *
 * **This is the one place a double becomes money**, so it is the one place the
 * imprecision has to be pinned down. `toFixed(scale)` renders the double's
 * decimal expansion rounded to `scale` places, and callers pass the scale of
 * the market's tick or lot size — so the result is exact *on the venue's own
 * grid*, which is the only grid the venue will accept anyway.
 *
 * Non-finite input is refused rather than coerced. A `NaN` price that reaches
 * an order request is a filled order at a price nobody chose.
 */
export function fromNumber(value: number, scale: number): Dec {
  if (!Number.isFinite(value)) {
    throw new RangeError(`not a finite number: ${String(value)}`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`scale out of range: ${scale}`);
  }
  return fromString(value.toFixed(scale));
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

/**
 * Approximate as a JS number, for display only.
 *
 * Never feed the result back into an order: it is a double again, with all the
 * imprecision that implies. It exists so the dashboard can format a price.
 */
export function toNumber(value: Dec): number {
  return Number(toString(value));
}

/** Re-express `value` at exactly `scale` digits. Throws if that would lose data. */
function rescale(value: Dec, scale: number): bigint {
  if (scale === value.scale) return value.units;
  if (scale > value.scale) {
    return value.units * 10n ** BigInt(scale - value.scale);
  }
  const divisor = 10n ** BigInt(value.scale - scale);
  if (value.units % divisor !== 0n) {
    throw new RangeError(
      `cannot represent ${toString(value)} at ${scale} decimal places without loss`,
    );
  }
  return value.units / divisor;
}

/** The common scale two values can both be expressed at without loss. */
function commonScale(a: Dec, b: Dec): number {
  return Math.max(a.scale, b.scale);
}

export function compare(a: Dec, b: Dec): number {
  const scale = commonScale(a, b);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPositive(value: Dec): boolean {
  return value.units > 0n;
}

export function isZero(value: Dec): boolean {
  return value.units === 0n;
}

/**
 * Snap `value` down (`"floor"`) or up (`"ceil"`) to the nearest multiple of
 * `step`, exactly.
 *
 * The direction is never "nearest", and that is deliberate. Rounding a price to
 * the *nearest* tick can move it across the spread and turn a resting maker
 * order into a taker; rounding a quantity up can breach a size cap. Callers
 * pick the direction that keeps them on the safe side of whatever bound they
 * are respecting, so the rounding error always lands in the venue's favour
 * rather than surprising the trader.
 */
export function quantise(value: Dec, step: Dec, mode: "floor" | "ceil"): Dec {
  if (!isPositive(step)) {
    throw new RangeError(`step must be positive, got ${toString(step)}`);
  }
  const scale = commonScale(value, step);
  const units = rescale(value, scale);
  const stepUnits = rescale(step, scale);
  let quotient = units / stepUnits;
  const remainder = units % stepUnits;
  if (remainder !== 0n) {
    // BigInt division truncates toward zero, so the correction for a negative
    // value is the mirror image of the one for a positive value. Prices and
    // sizes here are always positive, but getting this wrong silently would be
    // worse than the two extra lines.
    if (mode === "floor" && remainder < 0n) quotient -= 1n;
    if (mode === "ceil" && remainder > 0n) quotient += 1n;
  }
  // The result is an exact integer multiple of `step`, so it is representable
  // at the step's own scale — and reporting it there is what keeps a tick of
  // `0.5` printing as `62856.5` rather than `62856.50000`. The wire format for
  // a `Decimal` accepts either, but the trailing zeros are noise on a screen.
  const units2 = quotient * stepUnits;
  return { units: rescale({ units: units2, scale }, step.scale), scale: step.scale };
}

/**
 * `value` scaled by `bps` basis points, i.e. `value × bps / 10_000`.
 *
 * Exact: the multiplication happens before the division, on integers, so there
 * is no intermediate rounding to accumulate.
 */
export function applyBps(value: Dec, bps: number): Dec {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`bps must be a non-negative integer, got ${bps}`);
  }
  // Four extra digits absorb the /10_000 exactly, so `quantise` afterwards is
  // the only rounding step in the whole calculation.
  const scale = Math.min(value.scale + 4, MAX_SCALE);
  const units = rescale({ units: value.units, scale: value.scale }, scale);
  return { units: (units * BigInt(bps)) / 10_000n, scale };
}

export function subtract(a: Dec, b: Dec): Dec {
  const scale = commonScale(a, b);
  return { units: rescale(a, scale) - rescale(b, scale), scale };
}

export function add(a: Dec, b: Dec): Dec {
  const scale = commonScale(a, b);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}
