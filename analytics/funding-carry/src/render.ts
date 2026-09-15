// Rendering the ranking to a terminal.
//
// Two rules run through this file.
//
// **The rounded figure is never the only figure.** Columns are padded to a
// readable number of places because a ranking has to be scannable, and
// `--exact` prints the full-scale value behind every one because a
// quantitative claim has to be checkable. None of the arithmetic went through
// either — see `decimal.roundForDisplay`.
//
// **Every convention is printed, not just applied.** The interval, the
// annualisation, the variance window, the sample floor and the side that
// receives the carry all appear in the output, because an annualised number
// with an unstated convention is worse than no number: it looks like an
// answer.

import {
  WORKING_SCALE,
  type MarketCarry,
  rankBy,
} from "./carry.js";
import type { Report } from "./collect.js";
import { DEFAULT_MIN_SAMPLES_VALUE, type Config } from "./config.js";
import {
  type Dec,
  multiply,
  roundForDisplay,
  toFixed,
  toString as exactText,
} from "./decimal.js";

/** Display precision for a percentage column. */
const PCT_PLACES = 2;
/** Display precision for a per-window rate, which is very small. */
const RATE_PLACES = 8;

const MARKET_WIDTH = 16;
const NUM_WIDTH = 14;

const HUNDRED: Dec = { units: 100n, scale: 0 };

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** A ratio rendered as a percentage. Multiplication is exact; only the pad rounds. */
function percent(value: Dec | null, places = PCT_PLACES): string {
  return value === null ? "—" : `${toFixed(multiply(value, HUNDRED), places)}%`;
}

function cell(text: string): string {
  return padStart(text, NUM_WIDTH);
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function hours(ms: number): string {
  const value = ms / 3600_000;
  return Number.isInteger(value) ? `${value}h` : `${value.toFixed(2)}h`;
}

/** Emit wrapped prose at a fixed indent. Nothing explanatory runs off-screen. */
function prose(write: (line: string) => void, indent: string, text: string): void {
  for (const line of wrap(text, 78 - indent.length)) {
    write(`${indent}${line}`);
  }
}

function wrap(text: string, width: number): readonly string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

export function render(
  report: Report,
  config: Config,
  write: (line: string) => void,
): void {
  const ranked = report.markets.filter((row) => row.excluded === null);
  const unranked = report.markets.filter((row) => row.excluded !== null);
  const ordered = rankBy(ranked, config.sortBy);

  write("");
  write(`Funding carry — ${config.baseUrl} (${config.funds} funds)`);
  renderWindow(report, config, write);
  write("");

  renderConventions(ordered, config, write);
  renderTable(ordered, config, write);
  renderUnranked(unranked, write);
  renderCrossCheck(report, write);
  renderDiscovery(report, write);
  renderWireTypes(report, write);
  renderWarnings(report, write);

  if (config.exact) {
    renderExact(ordered, write);
  } else {
    write("");
    prose(
      write,
      "",
      "Columns are rounded for width only; the statistics behind them are " +
        `computed at ${WORKING_SCALE} decimal places and never pass through a ` +
        "float. Re-run with --exact for the full-scale values.",
    );
  }
  write("");
}

function renderWindow(
  report: Report,
  config: Config,
  write: (line: string) => void,
): void {
  if (report.anchorMs === null) {
    write("look-back: no settled funding windows were returned by any market");
    return;
  }
  const floor = report.anchorMs - config.windowHours * 3600_000;
  write(
    `look-back: ${config.windowHours}h, ${timestamp(floor)} → ` +
      `${timestamp(report.anchorMs)}`,
  );
  const driftMs = report.localNowMs - report.anchorMs;
  write(
    `  anchored on the newest settled window in the data, not the local ` +
      `clock (which is ${hours(Math.abs(driftMs))} ` +
      `${driftMs >= 0 ? "ahead of" : "behind"} it)` +
      (report.indexerLagMs === null
        ? ""
        : `; the deployment reported x-indexer-lag-ms ${report.indexerLagMs} ` +
          `(${hours(report.indexerLagMs)})`),
  );
}

function renderConventions(
  ranked: readonly MarketCarry[],
  config: Config,
  write: (line: string) => void,
): void {
  write("Conventions");
  const intervals = new Set(
    ranked.map((row) => row.interval?.modeMs).filter((ms): ms is number => ms !== undefined),
  );
  const intervalText =
    intervals.size === 0
      ? "not derived (nothing ranked)"
      : intervals.size === 1
        ? `${hours([...intervals][0] as number)} (derived: modal gap between settled windows)`
        : `${[...intervals].map(hours).join(", ")} — markets differ; each row annualised against its own`;
  write(`  settlement interval   ${intervalText}`);

  // THE SET, not `ranked[0]`. The interval line directly above already says
  // "markets differ; each row annualised against its own" when they do — and
  // this line then printed the TOP row's figure as though it were the global
  // one, contradicting it two lines later. Only state a number when every
  // ranked market actually shares it.
  //
  // Keyed on the RENDERED string, because `Dec` is an object: a `Set<Dec>` of
  // two structurally equal values has size 2, which would report "differs per
  // market" for markets that agree.
  const periodValues = ranked
    .map((row) => row.periodsPerYear)
    .filter((p): p is Dec => p !== null && p !== undefined);
  const periodKeys = new Set(periodValues.map((p) => toFixed(p, 0)));
  const periodsText =
    periodKeys.size === 1
      ? ` (= ${[...periodKeys][0] as string} here)`
      : periodKeys.size > 1
        ? " (differs per market — see each row)"
        : "";
  write(
    `  annualisation         simple: annual = mean per-window rate × ` +
      `periods/year${periodsText}`,
  );
  prose(
    write,
    "                        ",
    "NOT compounded. 365-day year. Compounding would assume every payment " +
      "is redeployed at the same notional, which a ranking does not assume.",
  );
  write(
    `  dispersion            sample stdev (n−1) of the per-window rate, ` +
      "annualised by √(periods/year)",
  );
  prose(
    write,
    "                        ",
    "The √t scaling assumes successive windows are independent. Funding is " +
      "autocorrelated, so this understates the annualised dispersion of a " +
      "persistent premium. Stated, not corrected.",
  );
  write(
    `  variance window       the ${config.windowHours}h look-back above; ` +
      `minimum ${config.minSamples} settled windows to be ranked` +
      (config.minSamples < DEFAULT_MIN_SAMPLES_VALUE
        ? `  ← LOWERED from the default ${DEFAULT_MIN_SAMPLES_VALUE}`
        : ""),
  );
  write(
    "  sign                  positive rate → longs pay, shorts receive; the " +
      "`receives` column names the side",
  );
  write(`  ranked by             ${sortLabel(config.sortBy)}`);
  write("");
}

function sortLabel(key: Config["sortBy"]): string {
  switch (key) {
    case "ratio":
      return "|annualised carry ÷ annualised dispersion|, largest first";
    case "carry":
      return "|annualised carry|, largest first";
    case "margin":
      return "|annualised carry ÷ initial margin rate|, largest first";
  }
}

function renderTable(
  ordered: readonly MarketCarry[],
  config: Config,
  write: (line: string) => void,
): void {
  write(`Ranked markets (${ordered.length})`);
  write(
    padEnd("market", MARKET_WIDTH) +
      cell("carry /yr") +
      cell("disp /yr") +
      cell("carry/disp") +
      cell("on margin") +
      padStart("n", 6) +
      padStart("receives", 10),
  );

  if (ordered.length === 0) {
    write("  (nothing met the sample floor — see below)");
    write("");
    return;
  }

  for (const row of ordered) {
    write(
      padEnd(row.marketId, MARKET_WIDTH) +
        cell(percent(row.carryAnnual)) +
        cell(percent(row.volatilityAnnual)) +
        // "flat" only when it is: `below-scale` is a rate that moved too
        // little to measure, and labelling it flat in the table was the same
        // overclaim as in the detail block (@nvizble, #25).
        cell(
          row.dispersion === "flat"
            ? "flat"
            : row.ratio === null
              ? "<scale"
              : toFixed(row.ratio, 2),
        ) +
        cell(percent(row.returnOnMargin, 1)) +
        padStart(String(row.stats?.n ?? 0), 6) +
        padStart(row.receivingSide, 10),
    );
  }
  write("");
  prose(
    write,
    "  ",
    '"on margin" is the annualised carry divided by the initial margin rate ' +
      "— the carry a position would earn on the capital it ties up, at the " +
      "maximum leverage the venue's own margin rate permits. It is a " +
      "comparison figure, NOT a realisable return: it assumes the position " +
      "is held for a year at maximum leverage through whatever the price " +
      "does, and at 50× a 2% adverse move is a liquidation. Nothing here " +
      "models that.",
  );
  write("");

  for (const row of ordered) {
    renderRowDetail(row, config, write);
  }
}

function renderRowDetail(
  row: MarketCarry,
  config: Config,
  write: (line: string) => void,
): void {
  const stats = row.stats;
  const interval = row.interval;
  if (stats === null || interval === null) return;

  write(`${row.marketId}`);
  write(
    `  per-window rate  mean ${toFixed(stats.mean, RATE_PLACES)}  ` +
      `stdev ${toFixed(stats.stdev, RATE_PLACES)}  ` +
      `min ${toFixed(stats.min, RATE_PLACES)}  max ${toFixed(stats.max, RATE_PLACES)}`,
  );
  write(
    `  sample           n = ${stats.n} settled windows over ` +
      `${row.firstMs === null || row.lastMs === null ? "?" : hours(row.lastMs - row.firstMs)}` +
      `, interval ${hours(interval.modeMs)}` +
      (interval.irregular === 0
        ? " (every gap agreed)"
        : ` (${interval.irregular} of ${interval.gaps} gaps differed; ` +
          `range ${hours(interval.minMs)}–${hours(interval.maxMs)})`),
  );
  if (row.dispersion === "flat") {
    write(
      "  dispersion       exactly zero — the rate did not move across the " +
        "look-back, so carry/disp is undefined, not infinite",
    );
  } else if (row.dispersion === "below-scale") {
    // The rate DID move; the variance rounded to zero at WORKING_SCALE. Saying
    // "did not move" here was the wrong half of a real distinction (@nvizble,
    // #25) — same output, different fact about the market.
    write(
      "  dispersion       moved, but by less than the working scale can " +
        "represent — carry/disp is undefined rather than very large, and " +
        "this is NOT a flat rate",
    );
  } else {
    write(
      `  dispersion error ±${percent(stats.stdevRelativeError, 1)} on the stdev ` +
        `at n = ${stats.n} (normal-theory 1/√(2(n−1)))`,
    );
  }

  // Piling-up at the extremes. Reported before the margin line because it
  // qualifies both of the numbers above it.
  //
  // BOTH ends are reported, and neither is labelled as the clamp, because
  // this app cannot tell which is which: the cap lives on `GET /markets`,
  // which this deployment answers `401` to. Measured, the two ends mean
  // different things and the counts alone do not separate them — ETH piles up
  // 75 windows on `-0.001` (the clamp) and 79 on `+0.0000125` (the baseline
  // interest component, which is not a clamp at all). Asserting "clamp" from
  // whichever count is larger would have called the baseline a clamp on both
  // of the venue's two active markets.
  const piled = Math.max(stats.atMin, stats.atMax);
  if (piled > 1 && row.ratio !== null) {
    write(
      `  repeated values  ${stats.atMin} window(s) at the minimum ` +
        `${toFixed(stats.min, RATE_PLACES)}, ${stats.atMax} at the maximum ` +
        `${toFixed(stats.max, RATE_PLACES)}, of ${stats.n}`,
    );
    if ((piled / stats.n) * 100 >= 10) {
      prose(
        write,
        "                   ",
        "A large pile-up on one value means this row's dispersion is measured " +
          "over a sample that is not free to spread. Two causes look " +
          "identical from here and have opposite implications: the engine's " +
          "funding-rate CLAMP censors the outer tail, which understates the " +
          "variability and flatters carry/disp; the BASELINE interest " +
          "component is simply what an untraded market settles at every hour, " +
          "which makes the steadiness real. `GET /markets` carries " +
          "`funding_rate_cap` and would separate them — it answers 401 here. " +
          "Check the value against the cap before trusting this row's ratio.",
      );
    }
  }
  if (row.initialMarginRate === null) {
    write("  margin           unknown — risk-params could not be read");
  } else {
    write(
      `  margin           initial ${percent(row.initialMarginRate)} of notional` +
        (row.maxLeverage === null ? "" : `, max leverage ${row.maxLeverage}×`) +
        (row.marginInverted ? "  ← below the maintenance rate, see warnings" : ""),
    );
  }
  if (row.premiumSamples > 0) {
    write(
      `  premium samples  ${row.premiumSamples} intra-window observations from ` +
        "/funding-samples — counted, NOT part of the statistics above",
    );
  } else {
    write(
      "  premium samples  none returned by /funding-samples (a different " +
        "endpoint and a different quantity; see the README)",
    );
  }
  if (row.discovery !== "both") {
    write(`  discovery        listed by ${row.discovery.replace("-only", " only")}`);
  }
  if (config.exact) {
    write(`  exact mean       ${exactText(stats.mean)}`);
  }
  write("");
}

function renderUnranked(
  unranked: readonly MarketCarry[],
  write: (line: string) => void,
): void {
  if (unranked.length === 0) return;
  write(`Not ranked (${unranked.length})`);
  for (const row of unranked) {
    write(`  ${padEnd(row.marketId, MARKET_WIDTH)}${row.excluded ?? ""}`);
    if (row.returnedWindows > 0 && (row.stats?.n ?? 0) === 0) {
      write(
        `  ${" ".repeat(MARKET_WIDTH)}the endpoint returned ` +
          `${row.returnedWindows} window(s), all older than the look-back`,
      );
    }
  }
  prose(
    write,
    "  ",
    "These are listed rather than dropped. A ranking that silently omitted a " +
      "market would present a partial answer as a complete one — and the " +
      "reason a market is missing is usually the more useful fact.",
  );
  write("");
}

function renderCrossCheck(report: Report, write: (line: string) => void): void {
  const totals = report.markets.reduce(
    (acc, row) => ({
      rateWithoutPremium: acc.rateWithoutPremium + row.crossCheck.rateWithoutPremium,
      premiumWithoutRate: acc.premiumWithoutRate + row.crossCheck.premiumWithoutRate,
      opposedSigns: acc.opposedSigns + row.crossCheck.opposedSigns,
      noPriceContext: acc.noPriceContext + row.crossCheck.noPriceContext,
    }),
    { rateWithoutPremium: 0, premiumWithoutRate: 0, opposedSigns: 0, noPriceContext: 0 },
  );
  const windows = report.markets.reduce((sum, row) => sum + (row.stats?.n ?? 0), 0);
  if (windows === 0) return;

  write("Rate against premium (counted, never averaged away)");
  write(
    `  ${totals.rateWithoutPremium} of ${windows} window(s) settled at a ` +
      "non-zero rate on a zero premium",
  );
  prose(
    write,
    "    ",
    "Expected, not a defect: the baseline interest component. The spec says " +
      "the premium index reads exactly zero until the market has traded, " +
      "because the trade reference falls back to the oracle and the " +
      "numerator vanishes — so a market with no trades still settles at the " +
      "baseline.",
  );
  write(
    `  ${totals.premiumWithoutRate} window(s) had a non-zero premium and ` +
      "settled at exactly zero",
  );
  write(
    `  ${totals.opposedSigns} window(s) had a rate and a premium of OPPOSITE ` +
      "sign",
  );
  if (totals.opposedSigns > 0) {
    prose(
      write,
      "    ",
      "This is the one that would contradict the model. It changes no number " +
        "here — the settled rate is the settled rate — but it is worth " +
        "understanding before trading on the ranking.",
    );
  }
  write(
    `  ${totals.noPriceContext} window(s) settled with mark_price "0" — no ` +
      "price context at all",
  );
  prose(
    write,
    "    ",
    "Those windows still carry a real rate and are still in the statistics. " +
      "Nothing here multiplies a rate by a price, which is why: this ranking " +
      "lives in rate space, so a missing price costs it context, not a number.",
  );
  write("");
}

function renderDiscovery(report: Report, write: (line: string) => void): void {
  if (report.discoveryDisagreement.length === 0) return;
  write("Market discovery disagreed");
  for (const entry of report.discoveryDisagreement) {
    write(
      `  ${padEnd(entry.marketId, MARKET_WIDTH)}listed by ` +
        `${entry.discovery.replace("-only", " only")}`,
    );
  }
  prose(
    write,
    "  ",
    "/tickers and /markets/summary do not return the same set of markets. " +
      "This app ranks the union and tags the difference, because dropping a " +
      "market with a week of funding history and including one the registry " +
      "does not carry are both wrong, in opposite directions.",
  );
  write("");
}

function renderWireTypes(report: Report, write: (line: string) => void): void {
  const divergent = report.typeWatch.divergent();
  if (divergent.length === 0) return;
  write("Wire types that disagreed with the spec");
  for (const observation of divergent) {
    write(`  ${observation.field}: arrived as a JSON number, spec says string`);
  }
  prose(
    write,
    "  ",
    "Parsed from the double's shortest round-tripping text, which is the " +
      "most that can be recovered — the low digits were gone before they " +
      "reached this process. Any figure downstream of one of these is " +
      "approximate, not lossless. See ENG-8439.",
  );
  write("");
}

function renderWarnings(report: Report, write: (line: string) => void): void {
  if (report.warnings.length === 0) return;
  write("Notes from this run");
  for (const warning of report.warnings) {
    prose(write, "  ", `- ${warning}`);
  }
  write("");
}

/**
 * A value derived by multiplying two already-rounded scale-30 figures.
 *
 * Exact as arithmetic and misleading as output: the product carries scale 60
 * and about 30 digits of information. Goes through `roundForDisplay` like
 * every other formatter here — this is a display decision, and the unrounded
 * value is untouched in the ranking arithmetic.
 */
function derivedText(value: Dec): string {
  return value.scale <= WORKING_SCALE
    ? exactText(value)
    : exactText(roundForDisplay(value, WORKING_SCALE));
}

function renderExact(
  ordered: readonly MarketCarry[],
  write: (line: string) => void,
): void {
  write("Exact values (unrounded, at the working scale)");
  for (const row of ordered) {
    if (row.stats === null) continue;
    write(`  ${row.marketId}`);
    write(`    Σ rate (exact)      ${exactText(row.stats.sum)}`);
    write(`    mean                ${exactText(row.stats.mean)}`);
    write(`    variance            ${exactText(row.stats.variance)}`);
    write(`    stdev               ${exactText(row.stats.stdev)}`);
    // The three below are PRODUCTS of two already-rounded scale-30 values, so
    // they land at scale 60 and the trailing 30 digits are an artefact of
    // exact multiplication, not information (@nvizble, #25 — a derived
    // interval of 3,599,000 ms printed 60 fraction digits). `decimal.ts` is
    // emphatic about never printing precision that is not there, so they are
    // shown at the working scale, where the information actually stops.
    if (row.periodsPerYear !== null) {
      write(`    periods/year        ${derivedText(row.periodsPerYear)}`);
    }
    if (row.carryAnnual !== null) {
      write(`    carry /yr           ${derivedText(row.carryAnnual)}`);
    }
    if (row.volatilityAnnual !== null) {
      write(`    dispersion /yr      ${derivedText(row.volatilityAnnual)}`);
    }
    if (row.ratio !== null) {
      write(`    carry/dispersion    ${exactText(row.ratio)}`);
    }
    if (row.returnOnMargin !== null) {
      write(`    on margin           ${exactText(row.returnOnMargin)}`);
    }
  }
  write("");
  prose(
    write,
    "",
    "Σ rate is exact integer arithmetic. mean, variance and stdev are rounded " +
      `once, at ${WORKING_SCALE} places, at the single division or square root ` +
      "that produced them — a mean and a standard deviation are not exact in " +
      "decimal at any finite scale, and this file would rather say so than " +
      "imply otherwise by printing 30 digits without a caveat. periods/year, " +
      "carry /yr and dispersion /yr are exact products of two such values, so " +
      `they are arithmetically exact at scale 60 and informative to about ` +
      `${WORKING_SCALE}; they are printed at ${WORKING_SCALE}, because the ` +
      "digits past it describe the rounding rather than the market.",
  );
}
