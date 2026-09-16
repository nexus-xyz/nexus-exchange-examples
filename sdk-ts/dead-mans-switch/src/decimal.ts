// Exact decimal arithmetic, on BigInt.
//
// The Exchange sends money as decimal *strings* precisely so they survive
// intact — `Decimal` in the SDK's models is a `string`, and its own docs say to
// parse it with a decimal type and never a float. This module is that decimal
// type, kept to the handful of operations this app actually needs.
//
// Why it matters here specifically: this app computes a limit price from a mark
// price, and that price has to land on the venue's tick grid *and* inside its
// price band. `77998.325 * 0.96` in IEEE-754 is not the number you meant, and
// the two failure modes are both silent-looking — a price off the grid is
// rejected with a message about ticks, and a price a hair outside the band is
// rejected with a message about the band. Neither reads as "your float was
// wrong".
//
// This is a trimmed copy of the same idea in `sdk-ts/risk-guard` and
// `exchange-api/trading-terminal`. Examples are self-contained by design (see
// CONTRIBUTING § 1), so it is copied rather than imported from next door.

/** A decimal held as an integer coefficient scaled by 10^`scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/** Ceiling on fractional digits. Far past anything the API produces. */
const MAX_SCALE = 18;

/** Basis points per whole. 1 bp = 0.01%. */
const BPS_PER_WHOLE = 10_000;

/**
 * Plain decimals only: no exponents, no `NaN`/`Infinity`, no separators.
 *
 * Every one of those has a plausible-looking `Number()` reading, which is why
 * they are refused rather than accepted — this value is about to become an
 * order price.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

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
    throw new RangeError(
      `too many decimal places (${fracPart.length} > ${MAX_SCALE}): ${trimmed}`,
    );
  }
  const digits = `${intPart || "0"}${fracPart}`;
  return {
    units: BigInt(digits) * (negative ? -1n : 1n),
    scale: fracPart.length,
  };
}

/** Re-express at `scale` digits. Only ever widens, so it is always exact. */
function rescale(value: Dec, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function commonScale(a: Dec, b: Dec): number {
  return Math.max(a.scale, b.scale);
}

/** -1, 0 or 1. Compares by value, so `1.5` and `1.50` are equal. */
export function compare(a: Dec, b: Dec): number {
  const scale = commonScale(a, b);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPositive(value: Dec): boolean {
  return value.units > 0n;
}

/**
 * `value × (1 − bps/10000)`, exactly.
 *
 * Exact because dividing by 10,000 is four more digits of scale rather than a
 * division: the coefficient is multiplied by `10000 − bps` and the scale is
 * widened by 4. No rounding happens here at all, which is what lets the caller
 * do the only rounding that exists — onto the tick grid — deliberately.
 */
export function discountBps(value: Dec, bps: number): Dec {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_PER_WHOLE) {
    throw new RangeError(`bps must be a whole number in 0..${BPS_PER_WHOLE}, got ${bps}`);
  }
  return { units: value.units * BigInt(BPS_PER_WHOLE - bps), scale: value.scale + 4 };
}

/**
 * The largest multiple of `step` that is `<= value`.
 *
 * Floor rather than nearest, and that direction is chosen rather than
 * defaulted: this app rounds a *bid* price, so flooring moves it further from
 * the market — away from a fill and further inside the price band. Rounding to
 * nearest could push it back out of the band the caller just checked against.
 *
 * BigInt division truncates toward zero, so the negative case is corrected
 * explicitly. Prices are positive here, but a floor helper that is wrong for
 * half its domain is the kind of thing that gets copied into somewhere it
 * matters.
 */
export function floorToMultiple(value: Dec, step: Dec): Dec {
  if (!isPositive(step)) {
    throw new RangeError(`step must be greater than zero, got ${format(step)}`);
  }
  const scale = commonScale(value, step);
  const v = rescale(value, scale);
  const s = rescale(step, scale);
  let quotient = v / s;
  if (v % s !== 0n && v < 0n) quotient -= 1n;
  return { units: quotient * s, scale };
}

/** Render as a plain decimal string — never scientific notation. */
export function format(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units)
    .toString()
    .padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const frac = value.scale === 0 ? "" : `.${digits.slice(cut)}`;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}${frac}`;
}

/**
 * Render with trailing fractional zeros removed, so a price that came out of
 * `discountBps` at scale 7 prints as `74878.5` rather than `74878.5000000`.
 *
 * Only ever used for display and for the wire value of a price already snapped
 * to the tick grid, where the dropped digits are provably zero.
 */
export function formatTrimmed(value: Dec): string {
  const text = format(value);
  if (!text.includes(".")) return text;
  return text.replace(/\.?0+$/, "");
}
