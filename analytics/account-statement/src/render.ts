// Rendering the statement to a terminal.
//
// One rule runs through this file: **the rounded figure is never the only
// figure**. Columns are padded to two decimal places because a statement has
// to be readable, and `--exact` prints the unrounded decimal string beside
// every total because a statement about money has to be checkable. The
// arithmetic that produced them never went near either — see
// `decimal.roundForDisplay`.

import {
  compare,
  type Dec,
  isZero,
  roundForDisplay,
  sign,
  toFixed,
  toString as exactText,
} from "./decimal.js";
import type { Config } from "./config.js";
import { WINDOW_SPEC } from "./config.js";
import type { Reconciliation } from "./reconcile.js";
import type { MarketLine, Statement } from "./statement.js";

/** Display precision for the money columns. USDX quotes to well under this. */
const PLACES = 2;

const MARKET_WIDTH = 18;
const MONEY_WIDTH = 16;

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function moneyCell(value: Dec): string {
  return padStart(toFixed(value, PLACES), MONEY_WIDTH);
}

/** Right-aligned money for the small label/value blocks outside the table. */
function figure(value: Dec): string {
  return padStart(toFixed(value, PLACES), 10);
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
}

/**
 * `true` when rounding to the column width actually changed the value.
 *
 * Compared by decimal *value*, not by text: `0` and `0.00` are the same
 * number, and a text comparison would call every whole number "rounded".
 */
function isRounded(value: Dec): boolean {
  return compare(value, roundForDisplay(value, PLACES)) !== 0;
}

/** Emit wrapped prose at a fixed indent. Nothing explanatory runs off-screen. */
function prose(write: (line: string) => void, indent: string, text: string): void {
  for (const line of wrap(text, 78 - indent.length)) {
    write(`${indent}${line}`);
  }
}

export function render(
  statement: Statement,
  reconciliation: Reconciliation | null,
  config: Config,
  write: (line: string) => void,
): void {
  const spec = WINDOW_SPEC[config.window];

  write("");
  write(`Account statement — ${config.baseUrl} (${config.funds} funds)`);
  write(
    `period: ${timestamp(statement.periodStartMs)} → ` +
      `${timestamp(statement.periodEndMs)}  ` +
      `(window "${config.window}", nominally ${spec.label}` +
      `${statement.periodFromSeries ? ", taken from the series the venue returned" : ", taken from the clock"})`,
  );
  if (config.market !== null) {
    write(`market filter: ${config.market}`);
  }
  write("");

  renderMarkets(statement, write);
  renderFees(statement, write);
  renderFunding(statement, write);
  renderActivity(statement, write);
  renderReconciliation(reconciliation, write, config.market);
  renderWireTypes(statement, write);
  renderCaveats(statement, write);

  if (config.exact) {
    renderExact(statement, reconciliation, write);
  } else {
    write("");
    prose(
      write,
      "",
      "Figures are rounded to 2 places for the columns only; the sums are " +
        "exact. Re-run with --exact for the unrounded decimal strings.",
    );
  }
  write("");
}

function renderMarkets(statement: Statement, write: (line: string) => void): void {
  write("P&L by market");
  write(
    padEnd("market", MARKET_WIDTH) +
      padStart("realized", MONEY_WIDTH) +
      padStart("fees", MONEY_WIDTH) +
      padStart("funding net", MONEY_WIDTH) +
      padStart("volume", MONEY_WIDTH) +
      padStart("fills", 8),
  );

  if (statement.markets.length === 0) {
    write("  (no fills, funding or position closes in this period)");
    write("");
    return;
  }

  for (const line of statement.markets) {
    write(row(line));
  }
  write("  " + "-".repeat(MARKET_WIDTH + MONEY_WIDTH * 4 + 6));
  write(row(statement.totals));
  write("");
}

function row(line: MarketLine): string {
  return (
    padEnd(line.marketId, MARKET_WIDTH) +
    moneyCell(line.realizedPnl) +
    moneyCell(line.fees) +
    moneyCell(line.fundingNet) +
    moneyCell(line.volume) +
    padStart(String(line.fills), 8)
  );
}

function renderFees(statement: Statement, write: (line: string) => void): void {
  const totals = statement.totals;
  write("Fees");
  write(
    `  charged over the period: ${toFixed(totals.fees, PLACES)} USDX across ` +
      `${totals.fills} fill(s) — ${totals.makerFills} maker, ${totals.takerFills} taker`,
  );
  if (sign(totals.fees) < 0) {
    prose(
      write,
      "  ",
      "the total is NEGATIVE, which is a net rebate: a negative fee is what " +
        "the venue paid you for providing liquidity, not a parse error.",
    );
  }
  if (totals.feeUnknownFills > 0) {
    prose(
      write,
      "  ",
      `${totals.feeUnknownFills} fill(s) stated NO fee at all, and are not in ` +
        'that total. An absent `fee` is not a fee of zero: `"0"` means the ' +
        "venue charged nothing (a liquidation fill is exempt), while an " +
        "absent key means it said nothing. Those fills' fees are unknown, so " +
        "the total above is a floor.",
    );
  }

  const schedule = statement.fees;
  if (schedule === null) {
    write("  (the fee schedule endpoint could not be read — see the notes)");
    write("");
    return;
  }
  write(
    `  schedule: maker ${schedule.makerBps} bps, taker ${schedule.takerBps} bps ` +
      `(tier "${schedule.tier}", scope "${schedule.schedule}")`,
  );
  if (schedule.makerBps < 0) {
    write("  the maker rate is negative — that is a rebate, by design.");
  }
  prose(
    write,
    "  ",
    `rolling 30d volume: ${toFixed(schedule.volume30d, PLACES)}` +
      (schedule.volume30dEstimated
        ? " — flagged ESTIMATED by the venue: its fill buffer was at " +
          "capacity, so this may undercount."
        : ""),
  );
  prose(
    write,
    "  ",
    "This is the forward-looking SCHEDULE rate, not a realized average. The " +
      "realized number is the fee column above, which comes from the fills.",
  );
  write("");
}

function renderFunding(statement: Statement, write: (line: string) => void): void {
  const totals = statement.totals;
  write("Funding");
  write(
    `  paid      ${figure(totals.fundingPaid)}   ` +
      "(negative — the account paid this out)",
  );
  write(
    `  received  ${figure(totals.fundingReceived)}   ` +
      "(positive — the account was credited this)",
  );
  write(`  net       ${figure(totals.fundingNet)}`);
  prose(
    write,
    "  ",
    "Sign convention: `/funding` publishes `amount` SIGNED — negative when " +
      "the account paid, positive when it received — and `direction` states " +
      "the same fact in words. This statement sums the signed `amount` and " +
      "checks each row's `direction` against its sign.",
  );

  const depth = statement.funding;
  if (depth.oldestMs !== null) {
    prose(
      write,
      "  ",
      `depth: this answer reaches back to ${timestamp(depth.oldestMs)} and no ` +
        "further. Older funding exists durably and was not returned.",
    );
  }
  if (depth.truncated !== null) {
    write(
      `  truncated by \`limit\`: ${depth.truncated ? "yes" : "no"}` +
        (depth.truncated ? "" : " (which is not a claim that this is the whole history)"),
    );
  }
  write("");
}

function renderActivity(statement: Statement, write: (line: string) => void): void {
  const activity = statement.activity;
  if (activity === null || activity.total === 0) return;
  const parts = [...activity.byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status} ${count}`);
  write("Order activity");
  write(`  ${activity.total} terminal order(s): ${parts.join(", ")}`);
  if (activity.capped) {
    write("  (the order-history walk hit the row cap; this is a floor)");
  }
  if (activity.unplaceable > 0) {
    // Excluded from the count above rather than folded into it, and said out
    // loud rather than left as a silent subtraction: a row with no timestamp
    // may well belong to this period, so the count is a floor for a second,
    // different reason than the row cap.
    write(
      `  (${activity.unplaceable} order(s) carried neither completed_at_ms nor ` +
        "created_at_ms and could not be placed in the period; they are not " +
        "counted above and may belong to it)",
    );
  }
  write("");
}

function renderReconciliation(
  reconciliation: Reconciliation | null,
  write: (line: string) => void,
  marketFilter: string | null,
): void {
  write("Reconciliation against the venue's own curve");

  // DISCLOSED, because with `--market` the two halves of this block cover a
  // different set of markets from the lines above it. The derived side here is
  // account-wide on purpose -- `/account/portfolio-history` has no market
  // parameter, so an account-wide published delta can only be differenced
  // against an account-wide derived total. Without this line a reader sees a
  // filtered TOTAL above and an unfiltered `derived from rows` below, and the
  // obvious reading is that one of them is wrong.
  if (marketFilter !== null) {
    prose(
      write,
      "  ",
      `This block is ACCOUNT-WIDE, unlike the lines above, which are filtered ` +
        `to ${marketFilter}. The venue's published curve has no market ` +
        "parameter, so reconciling a single market's rows against it would " +
        "book every other market's P&L into the residual.",
    );
    write("");
  }

  if (reconciliation === null) {
    prose(
      write,
      "  ",
      "Not possible: `/account/portfolio-history` returned fewer than two " +
        "points for this window, and a delta needs two samples. Nothing is " +
        "inferred from one point — a reconciliation that invented its own " +
        "baseline would agree with itself.",
    );
    write("");
    return;
  }

  write(
    `  derived from rows   ${moneyCell(reconciliation.derivedPnl)}   ` +
      "(Σ realized on close + Σ funding, signed)",
  );
  write(
    `  venue's pnl delta   ${moneyCell(reconciliation.publishedPnlDelta)}   ` +
      "(PortfolioPoint.pnl, last − first)",
  );
  write(
    `  RESIDUAL            ${moneyCell(reconciliation.residual)}   ` +
      "(venue − derived; reported, not absorbed)",
  );
  write("");
  write("  The residual is made of:");
  for (const item of reconciliation.explanation) {
    for (const line of wrap(`- ${item}`, 74)) {
      write(`    ${line}`);
    }
  }
  write("");
  write(
    `  equity delta        ${moneyCell(reconciliation.publishedEquityDelta)}   ` +
      "(PortfolioPoint.equity, last − first)",
  );
  write(
    `  non-trading flow    ${moneyCell(reconciliation.nonTradingFlow)}   ` +
      "(equity delta − pnl delta)",
  );
  prose(
    write,
    "  ",
    "`pnl` is deposit-neutral by definition and `equity` is not, so that " +
      "second figure is wallet movement — a deposit or a withdrawal — plus " +
      "whatever the two definitions do not share. It is expected to be " +
      "non-zero and is not part of trading performance.",
  );
  write("");
  write(
    `  volume, venue       ${moneyCell(reconciliation.publishedVolumeDelta)}`,
  );
  write(
    `  volume, from fills  ${moneyCell(reconciliation.derivedVolume)}   ` +
      "(Σ price × size, exact)",
  );
  if (!isZero(reconciliation.volumeResidual)) {
    write(`  volume residual     ${moneyCell(reconciliation.volumeResidual)}`);
    prose(
      write,
      "  ",
      "The two count differently on purpose: the venue's series counts a " +
        "self-trade once where a naive fill sum counts it twice, and its " +
        "endpoints are downsampled instants rather than the fill timestamps " +
        "used here. A non-zero figure is expected.",
    );
  }
  write("");
}

function renderWireTypes(statement: Statement, write: (line: string) => void): void {
  const divergent = statement.watch.divergent();
  if (divergent.length === 0) return;
  write("Wire types that disagreed with the spec on this run");
  for (const field of divergent) {
    write(
      `  ${field.field} — arrived as a JSON number; the spec types it as a ` +
        "lossless decimal string",
    );
  }
  prose(
    write,
    "  ",
    "These were parsed from the double's shortest round-tripping text, so " +
      "they are as good as the server made them and no better. Any total " +
      "they feed is approximate. See the README, and ENG-8439.",
  );
  write("");
}

function renderCaveats(statement: Statement, write: (line: string) => void): void {
  if (statement.caveats.length === 0) return;
  write("Notes — what this statement could not establish");
  for (const caveat of statement.caveats) {
    for (const line of wrap(`- ${caveat}`, 74)) {
      write(`  ${line}`);
    }
  }
  write("");
}

function renderExact(
  statement: Statement,
  reconciliation: Reconciliation | null,
  write: (line: string) => void,
): void {
  write("Exact values (unrounded decimal strings, as summed)");
  for (const line of [...statement.markets, statement.totals]) {
    write(`  ${line.marketId}`);
    write(`    realized_pnl  ${exactText(line.realizedPnl)}`);
    write(`    fees          ${exactText(line.fees)}`);
    write(`    funding_net   ${exactText(line.fundingNet)}`);
    write(`    volume        ${exactText(line.volume)}`);
  }
  if (reconciliation !== null) {
    write("  reconciliation");
    write(`    derived       ${exactText(reconciliation.derivedPnl)}`);
    write(`    published     ${exactText(reconciliation.publishedPnlDelta)}`);
    write(`    residual      ${exactText(reconciliation.residual)}`);
  }
  // All four, not the two that happened to be listed. `fundingNet` and
  // `volume` could round while the note stayed silent, so the line "at least
  // one column above was rounded" was a claim about a subset of the columns
  // above it (@nvizble, #22).
  const rounded = [
    statement.totals.realizedPnl,
    statement.totals.fees,
    statement.totals.fundingNet,
    statement.totals.volume,
  ].filter(isRounded);
  if (rounded.length > 0) {
    write(
      "  (at least one column above was rounded for display; these are the " +
        "values the arithmetic used)",
    );
  }
  write("");
}

/** Wrap to `width`, preserving a two-space hanging indent for list items. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = `  ${word}`;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
