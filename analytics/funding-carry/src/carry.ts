// The arithmetic, and the conventions it depends on.
//
// This file is where the example earns its keep, because "carry, and how
// variable it is" is a quantitative claim and a quantitative claim with an
// unstated convention is not an answer — it is a number that looks like one.
// Every convention is named here, in one place, and printed in the output.
//
// ## The four conventions
//
// **1. The settlement interval is derived, never assumed.** Perpetual venues
// settle funding on wildly different cadences and 8h is the folklore default,
// so annualising by 1,095 because "everyone uses 8h" is how a carry figure
// ends up eight times wrong. This app takes the *modal* gap between
// consecutive settled windows and reports it, along with how many gaps
// disagreed. Measured on the live testnet: the mode is **3,600,000 ms — one
// hour**, on all four markets, with one 2-hour gap on BTC and one on ETH out
// of 172 each and none on SOL. The repo's own documents disagree with each
// other about this, which is the best possible argument for deriving it:
// `eng/apps/exchange/01-architecture.md` says "every 8 hours (per market,
// configurable)" and `FUNDING-IMPLEMENTATION-MAP.md` says "hourly
// settlement". The wire says hourly.
//
// **2. Annualisation is simple, not compounded.** `annualised = r̄ × P`,
// where `P = 365 days / interval` — 8,760 at hourly settlement. Not
// `(1 + r̄)^P − 1`. Compounding would assume every payment is immediately
// re-deployed at the same notional, which a carry *ranking* does not assume
// and a reader comparing two markets does not want; it also explodes near the
// rate cap, where the compounded figure describes an arithmetic identity
// rather than a trade. A 365-day year, not 365.25: the settlement cadence is a
// clock cadence, and the 0.07% the choice moves every figure by is smaller
// than anything this ranking resolves — but it is stated because an
// unstated one is exactly the problem.
//
// **3. Dispersion is the *sample* standard deviation of the per-window rate**
// — Bessel's `n − 1` — annualised by `√P`, the square-root-of-time scaling
// that assumes successive windows are independent. **That assumption is the
// weakest thing in this file** and the output says so: funding rates are
// visibly autocorrelated (a premium that persists across an hour settles twice
// in the same direction), so √P understates the true annualised dispersion of
// a trend-following rate. It is used anyway because it is the convention a
// reader will expect, and it is named so nobody has to reverse-engineer it.
//
// **4. Nothing is ranked on too few points.** See `config.ts`'s
// `DEFAULT_MIN_SAMPLES` for the arithmetic; the short version is that the
// standard error of a standard deviation is about `1/√(2(n−1))`, which at
// n = 3 is ±50% — larger than the differences a ranking would be claiming to
// resolve. Markets below the floor are listed, with their `n`, and not ranked.
//
// ## What is exact and what is not
//
// The sums and sums of squares are exact integer arithmetic on `BigInt`. The
// mean, the variance, the standard deviation and every ratio are not — a mean
// is a division — so each is computed as **one** exact numerator over **one**
// exact denominator with a single rounding at `WORKING_SCALE`, rather than as
// a chain of intermediate quotients that round repeatedly. No value ever
// passes through a JS `number`.

import {
  type Dec,
  ZERO,
  add,
  compare,
  divide,
  fromInt,
  isZero,
  multiply,
  sign,
  sqrt,
  subtract,
} from "./decimal.js";
import type { SettledWindow, SignCrossCheck } from "./wire.js";

/**
 * Working scale for every inexact operation.
 *
 * 30 digits, chosen against the data rather than by taste: the venue emits
 * funding rates with **28** fraction digits, so a working scale below that
 * would round the inputs before the statistics ever saw them. Two spare digits
 * absorb the division.
 */
export const WORKING_SCALE = 30;

/** Milliseconds in the 365-day year this app annualises against. */
export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Below this share of gaps agreeing on one value, the cadence is not a
 * cadence and the app refuses to annualise from it.
 *
 * Annualising means multiplying by "how many of these windows fit in a year",
 * and that question has no answer for a market whose windows are of no
 * particular length. Refusing is the honest outcome; the market is still
 * listed, with its irregularity named.
 */
const INTERVAL_CONFIDENCE = 0.6;

/** What the gaps between settled windows say about the settlement cadence. */
export interface Interval {
  /** The modal gap, in ms. The interval this app annualises against. */
  readonly modeMs: number;
  /** Fraction of gaps equal to the mode, in [0, 1]. */
  readonly share: number;
  /** Gaps observed in total, i.e. `samples - 1`. */
  readonly gaps: number;
  /** Gaps that were not the mode. Named, never averaged in. */
  readonly irregular: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** False when the gaps do not agree well enough to annualise from. */
  readonly confident: boolean;
}

/**
 * Derive the settlement cadence from the timestamps.
 *
 * The **mode**, not the mean and not the median. A mean gap is dragged by a
 * single missed settlement — measured: BTC has one 7,200,000 ms gap among 171
 * of 3,600,000 ms, and the mean of those is 3,621,052 ms, an interval no
 * window on this venue has ever had. The mode is the cadence; the outliers are
 * missed settlements, and they are counted and reported as such.
 */
export function deriveInterval(timestampsMs: readonly number[]): Interval | null {
  if (timestampsMs.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < timestampsMs.length; i += 1) {
    const gap = (timestampsMs[i] as number) - (timestampsMs[i - 1] as number);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;

  const counts = new Map<number, number>();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  let modeMs = gaps[0] as number;
  let best = 0;
  for (const [gap, count] of counts) {
    // Ties break toward the shorter gap: it is the one more likely to be the
    // true cadence, since a missed settlement can only ever lengthen a gap.
    if (count > best || (count === best && gap < modeMs)) {
      modeMs = gap;
      best = count;
    }
  }
  const share = best / gaps.length;
  return {
    modeMs,
    share,
    gaps: gaps.length,
    irregular: gaps.length - best,
    minMs: Math.min(...gaps),
    maxMs: Math.max(...gaps),
    confident: share >= INTERVAL_CONFIDENCE,
  };
}

/** Sample statistics of the per-window rate, and the error bar on them. */
export interface Stats {
  readonly n: number;
  /** Exact. The one figure in here that has not been rounded. */
  readonly sum: Dec;
  readonly mean: Dec;
  /** Sample variance, Bessel-corrected (`n − 1`). */
  readonly variance: Dec;
  readonly stdev: Dec;
  readonly min: Dec;
  readonly max: Dec;
  /**
   * How many windows settled at exactly `min`, and at exactly `max`.
   *
   * **This is the censoring detector, and on this venue it fires.** The engine
   * clamps the realized rate to `±funding_rate_cap`, so a market whose premium
   * persists past the cap settles at the cap over and over. Measured on the
   * live testnet: **75 of ETH's 173 settled windows are exactly `-0.001`**,
   * and 23 of BTC's are exactly `+0.001`.
   *
   * That matters more here than anywhere else in the app, because a
   * *dispersion* computed over a censored sample is not the dispersion of the
   * underlying process — clamping removes precisely the observations that
   * would have widened it. So a heavily-clamped market looks *steadier* than
   * it is, and a ranking by carry-per-unit-variability flatters it twice: once
   * in the numerator, which sits at the cap, and once in the denominator,
   * which the cap has trimmed. The counts are reported so the reader can
   * discount the row rather than being quietly handed a favourable number.
   *
   * It is a count of the extremes, not a comparison against the cap: the cap
   * lives on `GET /markets`, which this deployment answers `401` to (see
   * `collect.ts`). Deriving the signal from the sample keeps it working
   * without that surface.
   */
  readonly atMin: number;
  readonly atMax: number;
  /**
   * Approximate relative standard error of `stdev`, i.e. `1/√(2(n−1))`.
   *
   * Printed beside the dispersion so the reader sees the error bar on the
   * statistic rather than being asked to trust a sample-size cutoff. It is a
   * normal-theory approximation and is labelled as such in the output.
   */
  readonly stdevRelativeError: Dec;
}

/**
 * Compute the sample statistics exactly up to the final division.
 *
 * The variance uses the algebraic identity
 *
 * ```
 *   s² = (n·Σr² − (Σr)²) / (n(n−1))
 * ```
 *
 * rather than `Σ(r − r̄)²/(n−1)`. In floating point that identity is the
 * classic catastrophic-cancellation trap and the two-pass form is the correct
 * choice — but here `Σr` and `Σr²` are exact `BigInt`s, so the numerator is
 * computed with no error at all and there is nothing to cancel catastrophically.
 * What it buys is that the *only* rounding in the whole statistic is the one
 * division at the end, where the two-pass form would round `r̄` first and then
 * square the rounding error `n` times.
 */
export function statistics(rates: readonly Dec[]): Stats | null {
  const n = rates.length;
  if (n < 2) return null;

  let sum = ZERO;
  let sumSquares = ZERO;
  let min = rates[0] as Dec;
  let max = rates[0] as Dec;
  for (const rate of rates) {
    sum = add(sum, rate);
    sumSquares = add(sumSquares, multiply(rate, rate));
    if (compare(rate, min) < 0) min = rate;
    if (compare(rate, max) > 0) max = rate;
  }

  const nDec = fromInt(n);
  const mean = divide(sum, nDec, WORKING_SCALE, "mean");
  // Exact numerator: n·Σr² − (Σr)². Non-negative by Cauchy–Schwarz, so the
  // sqrt below cannot be handed a negative value.
  const numerator = subtract(multiply(nDec, sumSquares), multiply(sum, sum));
  const denominator = multiply(nDec, fromInt(n - 1));
  const variance = divide(numerator, denominator, WORKING_SCALE, "variance");
  const stdev = sqrt(variance, WORKING_SCALE);

  let atMin = 0;
  let atMax = 0;
  for (const rate of rates) {
    if (compare(rate, min) === 0) atMin += 1;
    if (compare(rate, max) === 0) atMax += 1;
  }

  return {
    n,
    sum,
    mean,
    variance,
    stdev,
    min,
    max,
    atMin,
    atMax,
    stdevRelativeError: divide(
      fromInt(1),
      sqrt(fromInt(2 * (n - 1)), WORKING_SCALE),
      6,
      "stdev relative error",
    ),
  };
}

/** Which side of the trade receives the carry, on average, over the window. */
export type ReceivingSide = "short" | "long" | "flat";

/** Everything computed for one market, ranked or not. */
export interface MarketCarry {
  readonly marketId: string;
  readonly discovery: string;
  readonly status: string | null;
  /** Settled windows inside the look-back. */
  readonly stats: Stats | null;
  readonly interval: Interval | null;
  readonly crossCheck: SignCrossCheck;
  /** Windows the endpoint returned in total, before the look-back filter. */
  readonly returnedWindows: number;
  /**
   * The funding page came back full, so history is missing. Such a market is
   * always excluded from the ranking — see `excludeReason`.
   */
  readonly truncated: boolean;
  /** Oldest and newest settled window inside the look-back. */
  readonly firstMs: number | null;
  readonly lastMs: number | null;
  /** Intra-window premium observations, counted and never mixed in. */
  readonly premiumSamples: number;
  readonly initialMarginRate: Dec | null;
  readonly maxLeverage: number | null;
  readonly marginInverted: boolean;
  /** Null when the interval was not confident enough to annualise. */
  readonly periodsPerYear: Dec | null;
  readonly carryAnnual: Dec | null;
  readonly volatilityAnnual: Dec | null;
  /** Annualised carry per unit of annualised dispersion. Null when flat. */
  readonly ratio: Dec | null;
  /** Annualised carry divided by the initial margin rate. Null when unknown. */
  readonly returnOnMargin: Dec | null;
  readonly receivingSide: ReceivingSide;
  /** Why this market is not in the ranking, or null when it is. */
  readonly excluded: string | null;
}

export interface AnnualisedInputs {
  readonly stats: Stats;
  readonly interval: Interval;
  readonly initialMarginRate: Dec | null;
}

export interface Annualised {
  readonly periodsPerYear: Dec;
  readonly carryAnnual: Dec;
  readonly volatilityAnnual: Dec;
  readonly ratio: Dec | null;
  readonly returnOnMargin: Dec | null;
  readonly receivingSide: ReceivingSide;
}

/**
 * Scale the per-window statistics up to a year.
 *
 * Both scalings in one place so the two cannot drift apart: the mean scales
 * **linearly** in the number of periods and the standard deviation scales as
 * its **square root**. Getting that backwards, or applying `P` to both, is the
 * single most common way an annualised Sharpe-shaped number comes out wrong,
 * and it comes out wrong by a factor of `√P` — 94× at hourly settlement, which
 * is large enough to reorder any ranking completely.
 */
export function annualise({
  stats,
  interval,
  initialMarginRate,
}: AnnualisedInputs): Annualised | null {
  if (!interval.confident) return null;

  const periodsPerYear = divide(
    fromInt(YEAR_MS),
    fromInt(interval.modeMs),
    WORKING_SCALE,
    "periods per year",
  );
  const carryAnnual = multiply(stats.mean, periodsPerYear);
  const volatilityAnnual = multiply(
    stats.stdev,
    sqrt(periodsPerYear, WORKING_SCALE),
  );

  // A market whose rate never moved has no dispersion, so the ratio is
  // undefined rather than infinite. Reported as "flat"; never rendered as a
  // very large number, which is what dividing by an epsilon would produce and
  // which would put the least informative market at the top of the ranking.
  const ratio = isZero(volatilityAnnual)
    ? null
    : divide(carryAnnual, volatilityAnnual, 6, "carry-to-variability ratio");

  const returnOnMargin =
    initialMarginRate === null || isZero(initialMarginRate)
      ? null
      : divide(carryAnnual, initialMarginRate, 8, "return on margin");

  const meanSign = sign(stats.mean);
  return {
    periodsPerYear,
    carryAnnual,
    volatilityAnnual,
    ratio,
    returnOnMargin,
    // Positive rate → longs pay, shorts receive. See `wire.ts`'s
    // `SettledWindow.fundingRate`, and the README's note that the spec does
    // not state this and the engine does.
    receivingSide: meanSign > 0 ? "short" : meanSign < 0 ? "long" : "flat",
  };
}

/** Absolute value, for sorting by magnitude without dropping the sign. */
function magnitude(value: Dec): Dec {
  return value.units < 0n ? { units: -value.units, scale: value.scale } : value;
}

/**
 * Order the ranked markets.
 *
 * By **magnitude**, in every mode. A carry of −40%/yr is as large an
 * opportunity as +40%/yr — it is simply the other side of the trade, which the
 * `receives` column names — so ranking on the signed value would sort the
 * short-side opportunities to the bottom and call them the worst.
 *
 * A market with no ratio (zero dispersion) sorts last in `ratio` mode rather
 * than first. It has not earned the top of a risk-adjusted ranking by having
 * no measurable risk over a week; it has earned a line saying its rate did not
 * move.
 */
export function rankBy(
  rows: readonly MarketCarry[],
  key: "ratio" | "carry" | "margin",
): readonly MarketCarry[] {
  const pick = (row: MarketCarry): Dec | null =>
    key === "ratio"
      ? row.ratio
      : key === "carry"
        ? row.carryAnnual
        : row.returnOnMargin;
  return [...rows].sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    if (left === null && right === null) {
      // Both unrankable on the chosen key. Fall back to the size of the carry
      // itself rather than the alphabet: a flat market paying 10.95%/yr and a
      // flat market paying nothing are not equivalent, and sorting them by
      // name would put the empty one first for no reason a reader could infer.
      const byCarry =
        a.carryAnnual !== null && b.carryAnnual !== null
          ? compare(magnitude(b.carryAnnual), magnitude(a.carryAnnual))
          : 0;
      return byCarry !== 0 ? byCarry : a.marketId.localeCompare(b.marketId);
    }
    if (left === null) return 1;
    if (right === null) return -1;
    const byMagnitude = compare(magnitude(right), magnitude(left));
    return byMagnitude !== 0 ? byMagnitude : a.marketId.localeCompare(b.marketId);
  });
}

/**
 * Keep only the settled windows inside the look-back.
 *
 * **Anchored on the newest settled window in the data, not on the local
 * clock.** Two measurements say why. The venue's newest settled window was 21
 * minutes old when this was written, while the same response carried
 * `x-indexer-lag-ms: 13209865` — 3.7 hours — so the deployment's own staleness
 * signal and its data disagree, and neither is a safe anchor for a filter that
 * decides which samples exist. Anchoring on the data's own newest point makes
 * the window mean "the last N hours *of settlements*", which is the quantity a
 * carry figure is actually about, and makes the tool's answer reproducible
 * from the same response tomorrow.
 */
export function withinLookback(
  windows: readonly SettledWindow[],
  anchorMs: number,
  windowHours: number,
): readonly SettledWindow[] {
  const floor = anchorMs - windowHours * 3600_000;
  return windows.filter((window) => window.timestampMs > floor);
}
