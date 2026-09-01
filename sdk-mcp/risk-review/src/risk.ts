// The decision: given a snapshot of the account, is any limit breached?
//
// Pure — no network, no clock, no mutable state, and deliberately no knowledge
// of MCP. Everything that decides what the review reports lives in one function
// you can read top to bottom.
//
// The rule that matters
// ---------------------
// A limit has **three** outcomes here, not two: within, breached, and
// *unknown*.
//
// The exchange reports a position's risk fields as nullable, each paired with a
// machine-readable reason it is missing (`notional_value` /
// `notional_value_error`): the mark price may not be mirrored yet, market params
// may be unavailable. A review that treats a missing notional as zero concludes
// "exposure is under the limit" at the exact moment it has no idea what the
// exposure is — it reports all-clear during the outage that most warrants
// attention.
//
// So a limit whose inputs are incomplete reports `unknown`, never `within`.
//
// `unknown` is not a licence to stop reasoning
// --------------------------------------------
// It is the answer when the missing inputs *could change the outcome*, and only
// then. `notional_value` is `|size| × mark price`, so it is never negative,
// which makes a partial sum a **lower bound** on the true total. If that bound
// already exceeds the limit, no missing value can bring it back under and the
// breach is *proven* — reporting `unknown` there would be the mirror image of
// the bug this module exists to avoid: refusing to act on a fact the app already
// has, at exactly the moment it matters.
//
// The same argument run the other way covers flat positions. At `size == 0` the
// notional is provably zero whatever the mark price is, so a missing mark on a
// flat position says nothing at all about exposure — and counting it as missing
// would pin `max-notional` to `unknown` on every run from then on, which is a
// limit that never checks anything.

import * as dec from "./decimal.js";
import type { Limits } from "./config.js";

/**
 * One position, already lifted out of the tool's JSON.
 *
 * Kept as strings: these values arrive as decimal strings precisely so they
 * survive intact, and they stay that way until `decimal.ts` parses them.
 */
export interface PositionView {
  readonly marketId: string;
  /**
   * Position size. Non-nullable in the API, and the reason a flat position can
   * be excluded from the notional total as provably zero rather than counted as
   * unknown.
   */
  readonly size: string;
  /** `null` when the exchange could not compute it. */
  readonly notional: string | null;
  /** Why `notional` is null, when the exchange said. */
  readonly notionalError: string | null;
  readonly unrealizedPnl: string;
}

export type State = "within" | "breached" | "unknown";

export interface Finding {
  readonly limit: string;
  readonly state: State;
  readonly detail: string;
}

export interface Verdict {
  readonly breached: boolean;
  readonly indeterminate: boolean;
  readonly findings: readonly Finding[];
}

export interface Snapshot {
  readonly positions: readonly PositionView[];
  readonly availableMargin: string;
}

/**
 * The notional total, and whether it is the whole story.
 *
 * `total` is exact when `missing` is empty. Otherwise it is a *lower bound*: the
 * sum of the positions that did report, which no absent position can reduce.
 * Never a partial sum passed off as a total — that is the dangerous answer,
 * since it is smaller than the truth and therefore likelier to sit under a
 * limit. Read as a bound it is a fact; read as a total it would be a lie.
 */
interface Notional {
  readonly total: dec.Dec;
  readonly missing: readonly string[];
}

/**
 * Sum notional across open positions, reporting what it could not read.
 *
 * Flat positions are skipped rather than counted as missing — see the header for
 * why that is a proof and not a softening of the rule.
 */
function totalNotional(positions: readonly PositionView[]): Notional {
  const missing: string[] = [];
  let total = dec.ZERO;
  for (const position of positions) {
    if (dec.isZero(dec.parse(position.size))) continue;
    if (position.notional === null) {
      // The paired `*_error` field names the reason; surfacing it is the
      // difference between "the review is confused" and "the mark price is
      // unavailable for BTC-USDX-PERP".
      missing.push(
        `${position.marketId} (${position.notionalError ?? "reason not reported"})`,
      );
      continue;
    }
    total = dec.add(total, dec.parse(position.notional));
  }
  return { total, missing };
}

/** Total unrealized PnL. Non-nullable in the API, so this is always exact. */
function totalUnrealized(positions: readonly PositionView[]): dec.Dec {
  let total = dec.ZERO;
  for (const position of positions) {
    total = dec.add(total, dec.parse(position.unrealizedPnl));
  }
  return total;
}

export function evaluate(snapshot: Snapshot, limits: Limits): Verdict {
  const findings: Finding[] = [];

  if (limits.maxNotional !== null) {
    const cap = limits.maxNotional;
    const notional = totalNotional(snapshot.positions);
    const over = dec.compare(notional.total, cap) > 0;
    if (notional.missing.length === 0) {
      findings.push({
        limit: "max-notional",
        state: over ? "breached" : "within",
        detail: `notional ${dec.format(notional.total)} vs limit ${dec.format(cap)}`,
      });
    } else if (over) {
      // The bound is a real fact even though the total is not. Already over
      // means the breach cannot be undone by whatever is missing, so report what
      // can be proven.
      findings.push({
        limit: "max-notional",
        state: "breached",
        detail:
          `notional is at least ${dec.format(notional.total)} vs limit ${dec.format(cap)} — ` +
          "already over on the positions that do report, so no mark price for " +
          `${notional.missing.join(", ")} can bring it back under`,
      });
    } else {
      // The genuine unknown: the missing values could still land either side of
      // the limit.
      findings.push({
        limit: "max-notional",
        state: "unknown",
        detail:
          `cannot total notional — no mark price for ${notional.missing.join(", ")}. ` +
          `Counted ${dec.format(notional.total)} so far, which is not over the limit of ` +
          `${dec.format(cap)}, so the true total could fall either side. Treating ` +
          "exposure as unproven rather than as zero.",
      });
    }
  }

  if (limits.maxLoss !== null) {
    const unrealized = totalUnrealized(snapshot.positions);
    // A loss is negative PnL. Compare magnitudes so the limit reads as a
    // positive number in configuration, which is how people think about it.
    const loss = dec.isNegative(unrealized) ? dec.negate(unrealized) : dec.ZERO;
    findings.push({
      limit: "max-loss",
      state: dec.compare(loss, limits.maxLoss) > 0 ? "breached" : "within",
      detail: `unrealized ${dec.format(unrealized)} (loss ${dec.format(loss)}) vs limit ${dec.format(limits.maxLoss)}`,
    });
  }

  if (limits.minAvailableMargin !== null) {
    const available = dec.parse(snapshot.availableMargin);
    findings.push({
      limit: "min-available-margin",
      state:
        dec.compare(available, limits.minAvailableMargin) < 0 ? "breached" : "within",
      detail: `available ${dec.format(available)} vs floor ${dec.format(limits.minAvailableMargin)}`,
    });
  }

  return {
    breached: findings.some((f) => f.state === "breached"),
    indeterminate: findings.some((f) => f.state === "unknown"),
    findings,
  };
}
