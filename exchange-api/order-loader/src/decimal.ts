// Exact decimal arithmetic for money, on BigInt.
//
// The same module `trading-terminal` carries, trimmed to what a loader needs
// and copied rather than imported: CONTRIBUTING.md § 1 asks every example to
// stand alone, so a reader can download this one directory and have it work.
//
// Why it exists at all: the Exchange API is deliberately two-faced about
// numbers. Anything you **send** that is money — `price`, `quantity` — is a
// `Decimal`, an arbitrary-precision decimal serialised as a JSON *string*.
// Anything CCXT-shaped that you **read** — `engine_mark_price` on
// `/markets/summary`, the book's `[price, amount]` pairs — is a JSON *number*,
// an IEEE-754 double.
//
// So a price crosses from a double to an exact decimal, and the rule this file
// enforces is: **snap to the tick/lot grid at the crossing, and stay on
// integers afterwards.** For a bulk loader that matters more than it does for a
// single order, because the failure is per-order and silent: one badly rounded
// price in a batch of forty comes back as a rejected entry in an array nobody
// reads to the end.

/** A decimal held as an integer coefficient scaled by 10^`scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/**
 * Largest number of fractional digits accepted anywhere in this app.
 *
 * The venue's tick sizes are coarse (`0.5` for BTC) and lot sizes are at most 3
 * decimal places, so 12 is far past anything the API produces. It is a ceiling,
 * not a target: input with more precision is *rejected* rather than rounded,
 * because silently dropping digits off a price is how a loader places an order
 * nobody wrote in the file.
 */
const MAX_SCALE = 12;

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string exactly.
 *
 * Rejects anything that is not a plain decimal — no exponents, no `Infinity`,
 * no `NaN`, no thousands separators. Every one of those has a plausible-looking
 * `Number()` interpretation, which is precisely why they are refused: this
 * value is about to become money.
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
 * **This is the one place a double becomes money.** `toFixed(scale)` renders
 * the double's decimal expansion rounded to `scale` places, and callers pass
 * the scale of the market's tick or lot size — so the result is exact on the
 * venue's own grid, which is the only grid the venue accepts anyway.
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

/** Exact product. Scales add, so nothing is lost. */
export function multiply(a: Dec, b: Dec): Dec {
  const scale = a.scale + b.scale;
  if (scale > MAX_SCALE) {
    // Only reachable if both operands are already near the ceiling, which the
    // venue's grids never are. Refusing beats returning a rounded product from
    // a function whose whole contract is exactness.
    throw new RangeError(`product would need ${scale} decimal places`);
  }
  return { units: a.units * b.units, scale };
}

/** True when `value` is an exact integer multiple of `step`. */
export function isMultipleOf(value: Dec, step: Dec): boolean {
  if (!isPositive(step)) {
    throw new RangeError(`step must be positive, got ${toString(step)}`);
  }
  const scale = commonScale(value, step);
  return rescale(value, scale) % rescale(step, scale) === 0n;
}

/**
 * Snap `value` down (`"floor"`) or up (`"ceil"`) to the nearest multiple of
 * `step`, exactly.
 *
 * The direction is never "nearest", and that is deliberate. Rounding a price to
 * the *nearest* tick can move it across the spread and turn a resting maker
 * order into a taker. This loader does not silently snap prices it was given —
 * an off-grid price in the file is an error, not something to fix behind the
 * author's back — but it uses this to report the two nearest legal prices when
 * it refuses one.
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
  const snapped = quotient * stepUnits;
  return {
    units: rescale({ units: snapped, scale }, step.scale),
    scale: step.scale,
  };
}
