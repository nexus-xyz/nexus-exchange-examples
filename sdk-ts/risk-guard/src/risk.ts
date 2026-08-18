// The decision: given a snapshot of the account, is any limit breached?
//
// This module is deliberately pure — no network, no clock, no mutable state.
// Everything that decides whether the guard fires lives in one function you can
// read top to bottom, which is the property that makes a guard trustworthy.
//
// The rule that matters
// ---------------------
// A limit has **three** outcomes here, not two: within, breached, and
// *unknown*. That third one is the whole point.
//
// The exchange reports a position's risk fields as nullable, each paired with a
// machine-readable reason it is missing (`notional_value` / `notional_value_error`
// and friends — see the SDK's `PositionFieldError`). The mark price may not be
// mirrored yet; market params may be unavailable. A guard that treats a missing
// notional as zero quietly concludes "exposure is under the limit" at the exact
// moment it has no idea what the exposure is — it would go green during the
// outage that most warrants attention.
//
// So a limit whose inputs are incomplete reports `unknown`, never `within`, and
// the caller is required to treat that as "cannot prove safe" rather than
// "safe". `unknown` does not fire the guard either: acting on data we do not
// trust is its own failure mode. It reports loudly, and it refuses to *clear* a
// breach that already fired.

import type { Position } from "@nexus-xyz/exchange-ts";

import * as dec from "./decimal.js";
import type { Limits } from "./config.js";

/** One limit's outcome. `unknown` carries why its inputs were incomplete. */
export type Finding =
  | { readonly limit: string; readonly state: "within"; readonly detail: string }
  | { readonly limit: string; readonly state: "breached"; readonly detail: string }
  | { readonly limit: string; readonly state: "unknown"; readonly detail: string };

export interface Verdict {
  /** Any limit breached. The only state that fires the guard. */
  readonly breached: boolean;
  /** Any limit whose inputs were incomplete, so it could not be proven within. */
  readonly indeterminate: boolean;
  readonly findings: readonly Finding[];
}

/** The account facts the limits are evaluated against. */
export interface Snapshot {
  readonly positions: readonly Position[];
  /** `available_margin` from the account summary. */
  readonly availableMargin: string;
}

/**
 * Total notional across open positions.
 *
 * Returns `null` — not a partial sum — when any position cannot report its
 * notional. A partial sum is the dangerous answer: it is smaller than the truth
 * and therefore likelier to sit under the limit. Either every position counts
 * or the total is unknown.
 */
function totalNotional(
  positions: readonly Position[],
): { total: dec.Dec } | { missing: string[] } {
  const missing: string[] = [];
  let total = dec.ZERO;
  for (const position of positions) {
    const raw = position.notional_value;
    if (raw === null || raw === undefined) {
      // The paired `*_error` field names the reason; surfacing it is the
      // difference between "the guard is confused" and "the mark price is
      // unavailable for BTC-USDX-PERP".
      const reason = position.notional_value_error ?? "reason not reported";
      missing.push(`${position.market_id} (${reason})`);
      continue;
    }
    total = dec.add(total, dec.parse(raw));
  }
  return missing.length > 0 ? { missing } : { total };
}

/** Total unrealized PnL. Non-nullable in the API, so this is always exact. */
function totalUnrealized(positions: readonly Position[]): dec.Dec {
  let total = dec.ZERO;
  for (const position of positions) {
    total = dec.add(total, dec.parse(position.unrealized_pnl));
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
      const over = dec.compare(notional.total, limits.maxNotional) > 0;
      findings.push({
        limit: "max-notional",
        state: over ? "breached" : "within",
        detail: `notional ${dec.format(notional.total)} vs limit ${dec.format(limits.maxNotional)}`,
      });
    }
  }

  if (limits.maxLoss !== null) {
    const unrealized = totalUnrealized(snapshot.positions);
    // A loss is negative PnL. Compare magnitudes so the limit reads as a
    // positive number in configuration, which is how people think about it.
    const loss = dec.isNegative(unrealized) ? dec.negate(unrealized) : dec.ZERO;
    const over = dec.compare(loss, limits.maxLoss) > 0;
    findings.push({
      limit: "max-loss",
      state: over ? "breached" : "within",
      detail: `unrealized ${dec.format(unrealized)} (loss ${dec.format(loss)}) vs limit ${dec.format(limits.maxLoss)}`,
    });
  }

  if (limits.minAvailableMargin !== null) {
    const available = dec.parse(snapshot.availableMargin);
    const under = dec.compare(available, limits.minAvailableMargin) < 0;
    findings.push({
      limit: "min-available-margin",
      state: under ? "breached" : "within",
      detail: `available ${dec.format(available)} vs floor ${dec.format(limits.minAvailableMargin)}`,
    });
  }

  return {
    breached: findings.some((f) => f.state === "breached"),
    indeterminate: findings.some((f) => f.state === "unknown"),
    findings,
  };
}
