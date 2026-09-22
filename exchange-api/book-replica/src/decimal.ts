// Exact decimals for prices and sizes, on BigInt.
//
// The replica meets numbers in two encodings, and the whole cross-check depends
// on not confusing them:
//
//   * The **stream** sends levels as decimal *strings* (`"62815.50"`) — the
//     engine's own lossless representation, trailing zeros and all.
//   * The **REST** book is CCXT-shaped: `[price, amount]` pairs as JSON
//     *numbers*, i.e. IEEE-754 doubles.
//
// So the replica holds every level as an exact decimal, and a comparison with
// REST is made on REST's terms — see `sameAsDouble`. Nothing in this file does
// floating-point arithmetic.

/** A decimal held as an integer coefficient scaled by 10^`scale`, trailing zeros stripped. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

/** Ceiling on fractional digits. Input with more is refused, not rounded. */
const MAX_SCALE = 18;

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a plain or exponent-form decimal string exactly.
 *
 * Exponent form is accepted because `String(1e-7)` is `"1e-7"` — a REST double
 * rendered by JS can take that shape, and refusing it would make a tiny size on
 * a REST level an error rather than a number. `Infinity`, `NaN`, whitespace and
 * separators are refused: each has a plausible `Number()` reading, which is
 * exactly why none of them may become a price.
 */
export function parse(text: string): Dec {
  const match = DECIMAL_RE.exec(text);
  const intPart = match?.[2] ?? "";
  const fracPart = match?.[3] ?? "";
  if (match === null || (intPart.length === 0 && fracPart.length === 0)) {
    throw new RangeError(`not a decimal number: ${JSON.stringify(text)}`);
  }
  const exponent = Number(match[4] ?? "0");
  let units = BigInt(`${intPart || "0"}${fracPart}`);
  let scale = fracPart.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (match[1] === "-") units = -units;
  return normalise(units, scale);
}

/**
 * Convert a JSON number from the REST book into an exact decimal.
 *
 * `String(n)` is the shortest decimal that round-trips to the same double —
 * the same rule the server's serialiser uses to *write* it — so this recovers
 * the digits that were on the wire, not the double's full binary expansion.
 */
export function fromNumber(value: number): Dec {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${String(value)}`);
  return parse(String(value));
}

/** Strip trailing zeros, so `62815.50` and `62815.5` are the same value *and* the same key. */
function normalise(units: bigint, scale: number): Dec {
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  if (scale > MAX_SCALE) {
    throw new RangeError(`more than ${MAX_SCALE} decimal places`);
  }
  return { units, scale };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.units * 10n ** BigInt(scale - a.scale),
    b.units * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

export function compare(a: Dec, b: Dec): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function equals(a: Dec, b: Dec): boolean {
  // Both sides are normalised, so equal values have identical representations.
  return a.units === b.units && a.scale === b.scale;
}

export function subtract(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return normalise(x - y, scale);
}

export function isPositive(value: Dec): boolean {
  return value.units > 0n;
}

/**
 * Whether an exact decimal is the value a double on the REST route stands for.
 *
 * The REST book cannot carry more precision than a double, so a stream level
 * of, say, 18 significant digits would never compare *digit*-equal to its REST
 * twin even when both came from the same projection. Comparing through
 * `Number()` asks the right question instead: "is this the double the server
 * would have written for this decimal?" Both sides here are rounded once, by
 * the same IEEE-754 round-to-nearest rule, so a match is a match and a
 * mismatch is a real difference, not a representation artefact.
 */
export function sameAsDouble(exact: Dec, double: number): boolean {
  return Number(toString(exact)) === double;
}

/** Render as a plain decimal string. */
export function toString(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units)
    .toString()
    .padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const fraction = value.scale === 0 ? "" : `.${digits.slice(cut)}`;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}${fraction}`;
}
