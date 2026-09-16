/*
 * Exact decimal arithmetic over the API's decimal strings.
 *
 * Every money field in openapi.json 0.8.1 is a `Decimal` — a *string*, not a
 * number, and deliberately so. A builder fee is a receivable that someone will
 * eventually be paid, so computing it in IEEE-754 and rounding at the end is the
 * wrong kind of approximate: `0.1 * 3` is not `0.3`, and the error accumulates
 * once per fill across the whole ledger.
 *
 * So: parse to a scaled BigInt, multiply exactly, round once at the end, and
 * hand back a string in the same shape the API uses. No dependency — BigInt is
 * a language built-in and this is about forty lines of it.
 */

/** A decimal held exactly: `value` = `units / 10 ** scale`. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/** USDX is quoted to 6 decimal places; that is the ledger's presentation scale. */
export const USDX_SCALE = 6;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parse an API decimal string. Throws on anything that is not one — a silent
 * `NaN` in a fee ledger is worse than a crash, because it survives to a report.
 */
export function parseDec(value: string): Dec {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new TypeError(`not a decimal string: ${JSON.stringify(value)}`);
  }
  const dot = trimmed.indexOf(".");
  if (dot === -1) return { units: BigInt(trimmed), scale: 0 };

  const whole = trimmed.slice(0, dot);
  const frac = trimmed.slice(dot + 1);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const magnitude = BigInt(whole.replace("-", "") + frac);
  return { units: sign * magnitude, scale: frac.length };
}

/** Exact product. Scales add, which is why nothing is lost here. */
export function mulDec(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** Exact sum, at the wider of the two scales. */
export function addDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return {
    units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export const ZERO: Dec = { units: 0n, scale: 0 };

/**
 * Multiply by a basis-point rate. Exact — `bps` is an integer by contract, so
 * this only widens the scale by 4 and defers every rounding decision to
 * `formatDec`.
 */
export function applyBps(value: Dec, bps: number): Dec {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`bps must be a non-negative integer, got ${bps}`);
  }
  return { units: value.units * BigInt(bps), scale: value.scale + 4 };
}

/**
 * Render at `scale` decimal places, rounding half away from zero — the rule a
 * reader expects when they check the arithmetic by hand.
 */
export function formatDec(value: Dec, scale: number = USDX_SCALE): string {
  const shift = value.scale - scale;
  let units = value.units;

  if (shift > 0) {
    const divisor = 10n ** BigInt(shift);
    const negative = units < 0n;
    const magnitude = negative ? -units : units;
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
    units = negative ? -rounded : rounded;
  } else if (shift < 0) {
    units = units * 10n ** BigInt(-shift);
  }

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}
