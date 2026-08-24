// Exact decimal arithmetic, on BigInt.
//
// The Exchange sends money as decimal *strings* precisely so they survive
// intact — `Decimal` in the SDK's models is a `string`, and its own docs say to
// parse it with a decimal type and never a float. This module is that decimal
// type, kept to the four operations this app actually needs.
//
// Why not just `Number(...)`? Because a guard that under-counts exposure is
// worse than no guard. `0.1 + 0.2 !== 0.3` in IEEE-754, and a limit check is
// exactly a comparison against a sum — the one place that error decides
// whether the guard fires.
//
// This is a trimmed copy of the same idea in `exchange-api/trading-terminal`.
// Examples are self-contained by design (see CONTRIBUTING § 1), so it is copied
// rather than imported from next door.

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
 * they are refused rather than accepted — this value is about to become a
 * risk limit.
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

export function add(a: Dec, b: Dec): Dec {
  const scale = commonScale(a, b);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

export function negate(value: Dec): Dec {
  return { units: -value.units, scale: value.scale };
}

/** -1, 0 or 1. Compares by value, so `1.5` and `1.50` are equal. */
export function compare(a: Dec, b: Dec): number {
  const scale = commonScale(a, b);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNegative(value: Dec): boolean {
  return value.units < 0n;
}

/** Exactly zero, at any scale — `0`, `0.0` and `-0.000` are all zero. */
export function isZero(value: Dec): boolean {
  return value.units === 0n;
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
