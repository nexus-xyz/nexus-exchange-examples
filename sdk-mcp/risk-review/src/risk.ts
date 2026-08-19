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
 * Total notional across open positions.
 *
 * Returns the offending markets — not a partial sum — when any position cannot
 * report its notional. A partial sum is the dangerous answer: it is smaller than
 * the truth and therefore likelier to sit under the limit. Either every position
 * counts or the total is unknown.
 */
function totalNotional(
  positions: readonly PositionView[],
): { total: dec.Dec } | { missing: string[] } {
  const missing: string[] = [];
  let total = dec.ZERO;
  for (const position of positions) {
    if (position.notional === null) {
      missing.push(
        `${position.marketId} (${position.notionalError ?? "reason not reported"})`,
      );
      continue;
    }
    total = dec.add(total, dec.parse(position.notional));
  }
  return missing.length > 0 ? { missing } : { total };
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
    const notional = totalNotional(snapshot.positions);
    if ("missing" in notional) {
      findings.push({
        limit: "max-notional",
        state: "unknown",
        detail:
          `cannot total notional — no mark price for ${notional.missing.join(", ")}. ` +
          "Treating exposure as unproven rather than as zero.",
      });
    } else {
      findings.push({
        limit: "max-notional",
        state:
          dec.compare(notional.total, limits.maxNotional) > 0 ? "breached" : "within",
        detail: `notional ${dec.format(notional.total)} vs limit ${dec.format(limits.maxNotional)}`,
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
