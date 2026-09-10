// Reconciling the statement against the venue's own curve.
//
// **This file is the point of the example, and its most important property is
// that it does not force agreement.**
//
// Two numbers describe the same period from different directions:
//
//   * the one this app *derived*, by adding up rows — realized P&L on the
//     positions that closed, plus funding, from `/positions/closed` and
//     `/funding`;
//   * the one the venue *published*, as the change in
//     `PortfolioPoint.pnl` between the first and last sample of the window.
//
// They will not match exactly, and a tool that made them match would be lying.
// The spec defines the published series precisely enough to say what the gap
// is *made of*, which is far more useful than a gap of zero:
//
//     PortfolioPoint.pnl  =  Σ realized PnL on close  (incl. liquidation, ADL)
//                         +  Σ funding (signed)
//                         +  current unrealized PnL
//
// Rearranged over a window, the residual this app reports is:
//
//     residual  =  Δpnl  −  (Σ realized in window  +  Σ funding in window)
//
// which the identity says *should* be the change in unrealized P&L across the
// window — a quantity no history endpoint publishes, so it is inferred rather
// than checked. Everything else that can push the residual away from that is
// enumerated in `explain()`, because "here is a number and here is exactly
// what could be in it" is the answer a reconciliation owes you.
//
// The equity curve is reconciled separately and against a different identity.
// `pnl` is **deposit-neutral** by construction; `equity` is not. So
//
//     Δequity  −  Δpnl  =  net wallet flow  ±  definitional differences
//
// which is why a large number there is usually a deposit and not a bug.

import {
  type Dec,
  abs,
  add,
  compare,
  isZero,
  subtract,
  ZERO,
} from "./decimal.js";
import type { MarketLine, Statement } from "./statement.js";
import type { PortfolioSeries } from "./wire.js";

export interface Reconciliation {
  /** Δ of the venue's cumulative-P&L series across the window. */
  readonly publishedPnlDelta: Dec;
  /** Σ realized + Σ funding, from the rows this app read. */
  readonly derivedPnl: Dec;
  /** `publishedPnlDelta − derivedPnl`. The number that is not hidden. */
  readonly residual: Dec;
  /** Δ of the venue's equity series across the window. */
  readonly publishedEquityDelta: Dec;
  /** `publishedEquityDelta − publishedPnlDelta`: wallet flow, mostly. */
  readonly nonTradingFlow: Dec;
  /** Δ of the venue's cumulative-volume series; compared against fills. */
  readonly publishedVolumeDelta: Dec;
  readonly derivedVolume: Dec;
  readonly volumeResidual: Dec;
  /** Sentences naming what the residual can be made of. Always non-empty. */
  readonly explanation: readonly string[];
}

/**
 * Reconcile, or explain why it cannot be done.
 *
 * Returns `null` when the venue's series has fewer than two points: a delta
 * needs two samples, and inventing one from a single point — or from zero —
 * would manufacture the agreement this file exists to avoid.
 */
export function reconcile(statement: Statement): Reconciliation | null {
  const series = statement.portfolio;
  if (series === null) return null;
  const first = series.points.at(0);
  const last = series.points.at(-1);
  if (first === undefined || last === undefined || first === last) return null;

  const totals = statement.totals;
  const publishedPnlDelta = subtract(last.pnl, first.pnl);
  const derivedPnl = add(totals.realizedPnl, totals.fundingNet);
  const residual = subtract(publishedPnlDelta, derivedPnl);

  const publishedEquityDelta = subtract(last.equity, first.equity);
  const nonTradingFlow = subtract(publishedEquityDelta, publishedPnlDelta);

  const publishedVolumeDelta = subtract(last.volume, first.volume);
  const derivedVolume = totals.volume;
  const volumeResidual = subtract(publishedVolumeDelta, derivedVolume);

  return {
    publishedPnlDelta,
    derivedPnl,
    residual,
    publishedEquityDelta,
    nonTradingFlow,
    publishedVolumeDelta,
    derivedVolume,
    volumeResidual,
    explanation: explain(statement, series, residual, totals),
  };
}

/**
 * Name every term the residual can contain, for this particular run.
 *
 * Ordered most-likely-first, and specific to what actually happened: a caveat
 * about the fill cap is only printed when the cap was hit. A generic list of
 * everything that could ever go wrong is noise; a list of what could be in
 * *this* number is a finding.
 */
function explain(
  statement: Statement,
  series: PortfolioSeries,
  residual: Dec,
  totals: MarketLine,
): readonly string[] {
  const out: string[] = [];

  out.push(
    "Change in **unrealized** P&L across the window. The published `pnl` " +
      "series includes it by definition and no history endpoint publishes it " +
      "as a series, so it cannot be subtracted out — it is the term the " +
      "residual is expected to be.",
  );

  out.push(
    "**Whether `ClosedPosition.realized_pnl` is gross or net of fees.** The " +
      "spec does not say, so this statement does not subtract fees from " +
      "realized P&L: if they are already net, subtracting again would " +
      "double-count them. Fees for the period were " +
      `${textOf(totals.fees)} USDX, which is the size of the error this ` +
      "ambiguity can account for.",
  );

  out.push(
    "**Edge effects at the two ends of the window.** The published series is " +
      `downsampled at ${series.cadenceMs} ms, so its first and last samples ` +
      "are snapshots at instants, while the rows were filtered by timestamp " +
      "against those same instants. A fill or settlement landing between a " +
      "sample and the boundary falls on one side of one sum and the other " +
      "side of the other.",
  );

  if (statement.fillsCapped || statement.closedCapped) {
    out.push(
      "**A truncated walk.** One of the paginated reads hit this run's row " +
        "cap, so the derived side is a floor rather than a total and the " +
        "residual is inflated by whatever was not read.",
    );
  }

  if (statement.funding.truncated === true || statement.funding.oldestMs === null) {
    out.push(
      "**Funding rows this endpoint could not reach.** `/funding` is served " +
        "from a bounded in-memory tier; rows older than its floor are stored " +
        "durably and are not returned. The published `pnl` series folded all " +
        "of them in when it was computed.",
    );
  }

  if (statement.fundingSignConflicts > 0) {
    out.push(
      `**${statement.fundingSignConflicts} funding row(s) whose \`direction\` ` +
        "contradicted the sign of `amount`.** The signed `amount` was summed; " +
        "if the sign is the wrong one of the two, the funding term is off by " +
        "twice those rows.",
    );
  }

  const numberFields = statement.watch.divergent();
  if (numberFields.length > 0) {
    out.push(
      "**Float rounding at the server.** " +
        numberFields.map((field) => `\`${field.field}\``).join(", ") +
        " arrived as JSON number(s) where the spec types them as lossless " +
        "decimal strings, so the published side of this comparison has " +
        "already been through an IEEE-754 double and its low digits are not " +
        "the venue's. This is ENG-8439; see the README.",
    );
  }

  if (isZero(residual)) {
    out.push(
      "The residual came out at exactly zero this run. That is a plausible " +
        "outcome for an account with no open position at either end of the " +
        "window, and it is not evidence that the terms above went away.",
    );
  }

  return out;
}

/** Compact exact text, for use inside a sentence. */
function textOf(value: Dec): string {
  return compare(abs(value), ZERO) === 0 ? "0" : trim(value);
}

function trim(value: Dec): string {
  const text = decimalText(value);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function decimalText(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units)
    .toString()
    .padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const frac = value.scale === 0 ? "" : `.${digits.slice(cut)}`;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}${frac}`;
}
