// Exact decimal arithmetic, on BigInt.
//
// The Exchange sends money as decimal *strings* so they survive intact, and the
// SDK types them as `Decimal = string` for the same reason. This module is the
// decimal type a TWAP needs: slicing a parent size into lots, pricing children
// on the tick grid, and summing fills into a VWAP. None of that may touch a
// float. `0.1 + 0.2` is the famous one, but the one that bites an executor is
// quieter. A parent of `0.03` split three ways is `0.01` three times only in
// decimal. In IEEE-754 the third child comes out a hair short, and the lot check
// refuses it.
//
// Extended from the copy in `sdk-ts/dead-mans-switch`. Examples are
// self-contained by design (CONTRIBUTING § 1), so it's copied, not imported.

/** A decimal held as an integer coefficient scaled by 10^`scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/** Ceiling on fractional digits. Far past anything the API produces. */
const MAX_SCALE = 18;

/**
 * Plain decimals only: no exponents, no `NaN`/`Infinity`, no separators.
 *
 * Every one of those has a plausible-looking `Number()` reading, which is why
 * they're refused rather than accepted: this value is about to become an order.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export const ZERO: Dec = { units: 0n, scale: 0 };

/** Parse an exact decimal, or throw with the offending text quoted. */
export function parse(text: string): Dec {
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
    throw new RangeError(`too many decimal places (${fracPart.length} > ${MAX_SCALE}): ${trimmed}`);
  }
  return {
    units: BigInt(`${intPart || "0"}${fracPart}`) * (negative ? -1n : 1n),
    scale: fracPart.length,
  };
}

/**
 * Read a price or size the venue sent as a JSON **number**.
 *
 * The order book is CCXT-shaped, so its levels are `[number, number]` rather
 * than decimal strings. That makes it the one place a float enters this app.
 * `String(n)` gives the shortest decimal that round-trips to the same double.
 * For the few significant digits a venue prints, that's exactly the literal the
 * server wrote. It stops being true past ~15 significant digits, so the caller
 * checks the result against the tick grid and refuses a price that isn't on it.
 * A value that fell off the grid is a value that lost digits.
 */
export function fromJsonNumber(value: number): Dec {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const text = String(value);
  if (/e/i.test(text)) {
    throw new RangeError(`number ${text} is outside the range a plain decimal can be read from`);
  }
  return parse(text);
}

function rescale(value: Dec, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function common(a: Dec, b: Dec): number {
  return Math.max(a.scale, b.scale);
}

/** -1, 0 or 1. Compares by value, so `1.5` and `1.50` are equal. */
export function compare(a: Dec, b: Dec): number {
  const scale = common(a, b);
  const l = rescale(a, scale);
  const r = rescale(b, scale);
  return l < r ? -1 : l > r ? 1 : 0;
}

export function isPositive(value: Dec): boolean {
  return value.units > 0n;
}

export function isZero(value: Dec): boolean {
  return value.units === 0n;
}

export function add(a: Dec, b: Dec): Dec {
  const scale = common(a, b);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

export function sub(a: Dec, b: Dec): Dec {
  const scale = common(a, b);
  return { units: rescale(a, scale) - rescale(b, scale), scale };
}

/** Exact: scales add, nothing is rounded. */
export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function min(a: Dec, b: Dec): Dec {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Dec, b: Dec): Dec {
  return compare(a, b) >= 0 ? a : b;
}

/** `value × count`, for turning a lot count back into a quantity. */
export function times(value: Dec, count: bigint): Dec {
  return { units: value.units * count, scale: value.scale };
}

/**
 * How many whole `step`s fit in `value`, and whether it divides exactly.
 *
 * This is how the parent size becomes an integer number of lots, which is
 * what makes the slice schedule exact: every split below is integer division
 * on lots, never decimal division on sizes.
 */
export function countSteps(value: Dec, step: Dec): { count: bigint; exact: boolean } {
  if (!isPositive(step)) throw new RangeError(`step must be greater than zero, got ${format(step)}`);
  const scale = common(value, step);
  const v = rescale(value, scale);
  const s = rescale(step, scale);
  return { count: v / s, exact: v % s === 0n };
}

/** Is `value` on the grid of `step`? */
export function isMultiple(value: Dec, step: Dec): boolean {
  return countSteps(value, step).exact;
}

/**
 * The largest multiple of `step` that is `<= value`.
 *
 * BigInt division truncates toward zero, so the negative case is corrected
 * explicitly. Prices are positive here, but a floor helper that's wrong for
 * half its domain is the kind of thing that gets copied into somewhere it
 * matters.
 */
export function floorToMultiple(value: Dec, step: Dec): Dec {
  if (!isPositive(step)) throw new RangeError(`step must be greater than zero, got ${format(step)}`);
  const scale = common(value, step);
  const v = rescale(value, scale);
  const s = rescale(step, scale);
  let q = v / s;
  if (v % s !== 0n && v < 0n) q -= 1n;
  return { units: q * s, scale };
}

/** The smallest multiple of `step` that is `>= value`. */
export function ceilToMultiple(value: Dec, step: Dec): Dec {
  const floored = floorToMultiple(value, step);
  return compare(floored, value) === 0 ? floored : add(floored, step);
}

/**
 * `a / b` rounded half-away-from-zero to `digits` fractional places.
 *
 * The only division in the app, and used only for **reporting**: VWAP, the
 * arrival mid, and slippage in bps. Nothing that becomes an order price or
 * size is ever divided. Those are integer lot arithmetic and tick snapping.
 * The rounding mode is named rather than inherited, because an unstated
 * rounding mode in a fill report is how two people get two VWAPs.
 */
export function divRound(a: Dec, b: Dec, digits: number): Dec {
  if (b.units === 0n) throw new RangeError("division by zero");
  // a/b = (a.units / 10^a.scale) / (b.units / 10^b.scale)
  // scaled to `digits`: a.units * 10^(digits + b.scale) / (b.units * 10^a.scale)
  const num = a.units * 10n ** BigInt(digits + b.scale);
  const den = b.units * 10n ** BigInt(a.scale);
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return { units: negative ? -q : q, scale: digits };
}

/** Render as a plain decimal string, never scientific notation. */
export function format(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const frac = value.scale === 0 ? "" : `.${digits.slice(cut)}`;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}${frac}`;
}

/**
 * Render with trailing fractional zeros removed, so `74878.5000000` prints as
 * `74878.5`. Used for display and for the wire value of a price or size that's
 * already on its grid, where the dropped digits are provably zero.
 */
export function formatTrimmed(value: Dec): string {
  const text = format(value);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
