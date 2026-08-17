/*
 * Usage against the ceiling — the first thing an integrator checks and the first
 * thing that breaks (`docs/WORKSTREAMS.md` §3g).
 *
 * THE UNIT IS PEAK REQUESTS PER SECOND, NOT REQUESTS PER DAY, and that choice is
 * the whole model. A key doing 184,000 requests a day averages 2.1/s against a
 * 50/s ceiling, which reads as 4% utilised and is the number that lets a team
 * ship a change that takes them down at 14:00. Rate limits are enforced on the
 * second, so they have to be reported on the second: the only figure that
 * predicts a 429 is the worst second in the window.
 *
 * WHAT YOU CAN AND CANNOT OBSERVE. Accepted traffic is capped by the limiter, so
 * a key that wanted 70/s against a 50/s ceiling shows a flat 50 — the excess is
 * not in the accepted series at all, it is in the refusals. That is why this
 * model carries two series per key rather than one, and why the chart draws the
 * ceiling as a rule instead of scaling to the data: a bar that touches the rule
 * means demand was *clipped*, and the refusal count beside it is how much.
 *
 * THE REFUSAL TOTAL RECONCILES with the venue-level error table on Analytics
 * (`RATE_LIMITED` in `apiAnalytics().errorCodes`). Two counts of the same event
 * that disagree by page teach an operator to trust neither, so the total is
 * passed in and distributed across the hours that were actually clipped rather
 * than generated independently here.
 *
 * Seeded and deterministic off the console clock, like every other series here,
 * so a per-key window agrees with the venue-wide one beside it.
 */

import type { ApiKey } from "@/lib/venue/team-model";

import { HOUR_MS, hourStarts, prng, seedFrom } from "./clock";

export interface KeyUsage {
  key: ApiKey;
  /** Start of each hour, oldest first. */
  hoursMs: number[];
  /** Peak ACCEPTED requests/second in each hour. Clipped at the ceiling. */
  acceptedPeak: number[];
  /** Requests refused with 429 in each hour. Non-zero only where clipped. */
  refused: number[];
  /** The worst accepted second in the window. */
  peakPerSec: number;
  /** Sustained rate — requests over the window, spread evenly. */
  meanPerSec: number;
  /** Unused budget at the peak second. 0 when the limiter engaged. */
  headroom: number;
  refusedTotal: number;
  /** The hour the peak happened in, so the table can name it. */
  peakAtMs: number;
  /** Hours in which the limiter engaged at least once. */
  clippedHours: number;
}

/**
 * The diurnal shape. Trading traffic is not flat and a flat series would hide
 * the only thing this pane exists to show — that the ceiling is a problem for
 * two hours a day and invisible for the other twenty-two.
 */
function burstAt(hourOfDay: number, spikiness: number): number {
  const centred = ((hourOfDay - 14 + 36) % 24) - 12;
  const diurnal = Math.exp(-(centred * centred) / 26);
  return 1 + spikiness * diurnal;
}

/**
 * Per-key usage for the last 24 hours.
 *
 * `refusedTotal` is the venue's 24h `RATE_LIMITED` count, distributed across
 * whatever was clipped. Pass 0 and the pane correctly reports that nothing was
 * refused rather than inventing a plausible handful.
 */
export function keyUsage(keys: ApiKey[], ceilingPerSec: number, refusedTotal: number): KeyUsage[] {
  const hoursMs = hourStarts(24);

  /* Two passes: shape first, then the refusals — because a refusal count can
     only be split once every key's excess demand is known. */
  const shaped = keys.map((key) => {
    const random = prng(seedFrom(key.id));
    const meanPerSec = key.requests24h / 86_400;
    /* A production proxy fans out to one venue; CI and a laptop do not. The
       live key is the spiky one because it is the one carrying a UI. */
    const spikiness = key.env === "live" ? 26 : 7;

    const demand = hoursMs.map((ms) => {
      const hourOfDay = new Date(ms).getUTCHours();
      return meanPerSec * burstAt(hourOfDay, spikiness) * (0.72 + random() * 0.62);
    });

    /* Two decimals, not one. A development key doing 302 requests a day peaks at
       0.04/s, and rounding that to 0.0 renders a key that is in daily use as one
       that has never been called. */
    const acceptedPeak = demand.map((d) => Math.min(ceilingPerSec, Math.round(d * 100) / 100));
    const excess = demand.map((d) => Math.max(0, d - ceilingPerSec));
    return { key, meanPerSec, acceptedPeak, excess };
  });

  const excessTotal = shaped.reduce((sum, s) => sum + s.excess.reduce((a, b) => a + b, 0), 0);

  return shaped.map(({ key, meanPerSec, acceptedPeak, excess }) => {
    const refused =
      excessTotal === 0
        ? excess.map(() => 0)
        : excess.map((e) => Math.round((e / excessTotal) * refusedTotal));

    const peakPerSec = Math.max(...acceptedPeak);
    const peakIndex = acceptedPeak.indexOf(peakPerSec);

    return {
      key,
      hoursMs,
      acceptedPeak,
      refused,
      peakPerSec,
      meanPerSec,
      /* Headroom is measured at the peak, not at the mean. A key whose average
         leaves 96% of the budget free and whose worst second leaves none has no
         headroom — it has an average. */
      headroom: Math.max(0, 1 - peakPerSec / ceilingPerSec),
      refusedTotal: refused.reduce((a, b) => a + b, 0),
      peakAtMs: hoursMs[peakIndex] ?? hoursMs[hoursMs.length - 1] ?? 0,
      clippedHours: excess.filter((e) => e > 0).length,
    };
  });
}

/** The end of the window a `KeyUsage` describes, for a chart's right-hand label. */
export const windowEndMs = (usage: KeyUsage): number =>
  (usage.hoursMs[usage.hoursMs.length - 1] ?? 0) + HOUR_MS;
