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
// trust is its own failure mode. It reports loudly and leaves the call to a
// human. (`evaluate` is stateless, so it has no memory of a previous tick and
// no latch to clear — see the note on that in the README.)
//
// `unknown` is not a licence to stop reasoning
// -------------------------------------------
// It is the answer when the missing inputs *could change the outcome*, and only
// then. `notional_value` is `|size| × mark price`, so it is never negative,
// which makes a partial sum a **lower bound** on the true total. If that bound
// already exceeds the limit, no missing value can bring it back under, and the
// breach is proven — reporting `unknown` there would be the mirror image of the
// bug this module exists to avoid: refusing to act on a fact the app already
// has, at exactly the moment it matters. A flat position is the same argument
// run the other way: at `size == 0` the notional is provably zero whatever the
// mark price is, so a missing mark on a flat position says nothing at all.

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
 * When every position reports, the answer is exact. When some do not, the
 * caller gets the sum of the ones that did — labelled `atLeast`, because that
 * is what it is — together with the markets that are missing. It is never a
 * partial sum passed off as a total: that is the dangerous answer, since it is
 * smaller than the truth and therefore likelier to sit under a limit.
 *
 * A lower bound is still worth having, though, and `atLeast` is genuinely one:
 * `notional_value` is `|size| × mark price` and so is never negative, so no
 * missing position can *reduce* the total. `evaluate` uses that to prove a
 * breach it would otherwise have to call unknown.
 *
 * Positions with zero size are skipped rather than counted as missing. Their
 * notional is `|0| × mark price = 0` whatever the mark price is, so a flat or
 * dust position in a market the indexer has stopped mirroring tells us nothing
 * about exposure — and treating it as missing would make `max-notional`
 * unprovable on every tick from then on, which is a limit that never checks
 * anything.
 */
function totalNotional(
  positions: readonly Position[],
): { total: dec.Dec } | { atLeast: dec.Dec; missing: string[] } {
  const missing: string[] = [];
  let total = dec.ZERO;
  for (const position of positions) {
    if (dec.compare(dec.parse(position.size), dec.ZERO) === 0) continue;
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
  return missing.length > 0 ? { atLeast: total, missing } : { total };
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
      const cap = limits.maxNotional;
      const absent = notional.missing.join(", ");
      // The bound is a real fact even though the total is not. Over the limit
      // already means the breach cannot be undone by whatever is missing, so
      // this is `breached` — the guard should act on what it can prove. Under
      // the limit is the genuine `unknown`: the missing values could still land
      // either side of it, and this app does not act on data it cannot trust.
      findings.push(
        dec.compare(notional.atLeast, cap) > 0
          ? {
              limit: "max-notional",
              state: "breached",
              detail:
                `notional is at least ${dec.format(notional.atLeast)} vs limit ` +
                `${dec.format(cap)} — already over on the positions that do ` +
                `report, so no mark price for ${absent} can bring it back under.`,
            }
          : {
              limit: "max-notional",
              state: "unknown",
              detail:
                `cannot total notional — no mark price for ${absent}. Counted ` +
                `${dec.format(notional.atLeast)} so far, which is not over the ` +
                `limit of ${dec.format(cap)}, so the true total could fall either ` +
                "side. Treating exposure as unproven rather than as zero.",
            },
      );
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
