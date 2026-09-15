// Fetching the account's period, and folding it into a statement.
//
// Five surfaces, and the whole file is about not overstating what any of them
// said:
//
//   `/fills`              what you traded, and the fee each fill cost
//   `/funding`            what funding moved, and in which direction
//   `/positions/closed`   realized P&L, per position, at close
//   `/account/fees`       the schedule rate — forward-looking, not realized
//   `/account/portfolio-history`  the venue's own equity and cumulative-P&L curve
//
// The parsers themselves live in `wire.ts`; this file is the fetching, the
// period, and the fold.

import { add, type Dec, multiply, sign, sum, ZERO } from "./decimal.js";
import { HEAVY_READ_WEIGHT } from "./budget.js";
import type { Config } from "./config.js";
import { WINDOW_SPEC } from "./config.js";
import { paginate, type RestClient } from "./rest.js";
import {
  asRecord,
  type ClosedPosition,
  type FeeSchedule,
  type Fill,
  type FundingDepth,
  type FundingRow,
  parseClosed,
  parseFees,
  parseFill,
  parseFunding,
  parsePortfolio,
  type PortfolioSeries,
  TypeWatch,
} from "./wire.js";

/** Page sizes, each at the endpoint's own documented maximum. */
const FILLS_PAGE = 1_000;
const ORDERS_PAGE = 500;
const CLOSED_PAGE = 200;
/** `/funding` takes a `limit` and no cursor: one call, up to 1,000 rows. */
const FUNDING_LIMIT = 1_000;

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export interface MarketLine {
  readonly marketId: string;
  readonly realizedPnl: Dec;
  readonly fees: Dec;
  readonly feeUnknownFills: number;
  readonly fundingNet: Dec;
  readonly fundingPaid: Dec;
  readonly fundingReceived: Dec;
  readonly volume: Dec;
  readonly fills: number;
  readonly makerFills: number;
  readonly takerFills: number;
  readonly closes: number;
}

export interface ActivitySummary {
  readonly total: number;
  readonly byStatus: ReadonlyMap<string, number>;
  readonly capped: boolean;
  /**
   * Rows carrying neither `completed_at_ms` nor `created_at_ms`.
   *
   * Excluded from `total` and reported separately: they may well belong to the
   * period, and counting them as if they did was the old behaviour.
   */
  readonly unplaceable: number;
}

export interface Statement {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  /** True when the period came from the returned series rather than the clock. */
  readonly periodFromSeries: boolean;
  readonly markets: readonly MarketLine[];
  readonly totals: MarketLine;
  /**
   * The same fold WITHOUT the `--market` filter, which is the only thing that
   * can honestly be differenced against `/account/portfolio-history` — that
   * endpoint has no market parameter. Equal to `totals` when no filter is set.
   */
  readonly accountWideTotals: MarketLine;
  readonly funding: FundingDepth;
  readonly fundingSignConflicts: number;
  readonly fillsCapped: boolean;
  readonly closedCapped: boolean;
  readonly fees: FeeSchedule | null;
  readonly portfolio: PortfolioSeries | null;
  readonly activity: ActivitySummary | null;
  readonly watch: TypeWatch;
  /** Things the app could not establish. Rendered verbatim; never suppressed. */
  readonly caveats: readonly string[];
}

function emptyLine(marketId: string): MarketLine {
  return {
    marketId,
    realizedPnl: ZERO,
    fees: ZERO,
    feeUnknownFills: 0,
    fundingNet: ZERO,
    fundingPaid: ZERO,
    fundingReceived: ZERO,
    volume: ZERO,
    fills: 0,
    makerFills: 0,
    takerFills: 0,
    closes: 0,
  };
}

/**
 * HALF-OPEN AT THE START, `(start, end]`, and that is not a style choice.
 *
 * The published side of the reconciliation is `last.pnl - first.pnl`, and
 * `pnl` is CUMULATIVE. A difference of a cumulative series can only ever
 * attribute events to a half-open interval: whatever produced `first.pnl` is
 * already inside it and cancels. A closed-closed row filter therefore adds any
 * row landing exactly on `periodStartMs` to the derived side a second time,
 * and the reconciliation reports that duplicate as residual.
 *
 * Not a corner case: funding settles on the hour and the `day`/`week` cadences
 * are 5 min and 1 h, so a funding row landing exactly on the first sample is
 * routine.
 *
 * Distinct from the "edge effects at the two ends" caveat in `reconcile.ts`,
 * which is about rows falling BETWEEN a sample and the boundary — genuinely
 * unavoidable, and not this.
 */
function inPeriod(timestampMs: number, startMs: number, endMs: number): boolean {
  return timestampMs > startMs && timestampMs <= endMs;
}

/**
 * Build the statement.
 *
 * Ordering is deliberate. The portfolio series is fetched **first**, because
 * it is what defines the period: the endpoint clamps the point count to the
 * window's own capacity, so the range actually returned is the only range the
 * reconciliation can honestly be run over. Everything after it is filtered to
 * that range.
 */
export async function buildStatement(
  client: RestClient,
  config: Config,
  onProgress: (message: string) => void,
): Promise<Statement> {
  const watch = new TypeWatch();
  const caveats: string[] = [];
  const spec = WINDOW_SPEC[config.window];

  onProgress(`portfolio-history (window ${config.window}, weight ${HEAVY_READ_WEIGHT})`);
  const portfolioAnswer = await client.get<unknown>({
    path: "/api/v1/account/portfolio-history",
    query: [
      ["window", config.window],
      ["limit", String(spec.maxPoints)],
    ],
    signed: true,
    weight: HEAVY_READ_WEIGHT,
  });
  const portfolio = parsePortfolio(watch, portfolioAnswer.body, spec.maxPoints);

  if (portfolio.window !== config.window) {
    caveats.push(
      `asked for window "${config.window}" and the server answered ` +
        `"${portfolio.window}" — the period shown above is the one it served.`,
    );
  }
  if (portfolio.cadenceMs !== 0 && portfolio.cadenceMs !== spec.cadenceMs) {
    caveats.push(
      `this deployment downsamples the "${portfolio.window}" window at ` +
        `${portfolio.cadenceMs} ms, not the ${spec.cadenceMs} ms the spec's ` +
        "table gives. The series is used as served.",
    );
  }

  const now = Date.now();
  const first = portfolio.points.at(0);
  const last = portfolio.points.at(-1);
  const periodFromSeries = first !== undefined && last !== undefined && first !== last;
  const periodStartMs = periodFromSeries ? first.timestampMs : now - spec.spanMs;
  const periodEndMs = periodFromSeries ? last.timestampMs : now;

  if (!periodFromSeries) {
    caveats.push(
      `portfolio-history returned ${portfolio.points.length} point(s), so the ` +
        `period shown above is the clock's last ${spec.label} rather than a ` +
        "range the venue confirmed, and no reconciliation against the " +
        "venue's own curve is possible.",
    );
  } else if (portfolio.points.length >= spec.maxPoints) {
    caveats.push(
      `portfolio-history returned ${portfolio.points.length} points, the ` +
        `"${config.window}" window's full capacity — the account's history may ` +
        "reach further back than this statement covers. `window` clamps the " +
        "point count server-side; a larger `limit` does not lift it.",
    );
  }

  onProgress(`fills (weight ${HEAVY_READ_WEIGHT} per page)`);
  const fillsPage = await paginate<unknown>(
    client,
    "/api/v1/fills",
    FILLS_PAGE,
    config.maxRows,
    HEAVY_READ_WEIGHT,
  );
  // TWO SETS, because `--market` filters the derived side and cannot filter the
  // published one: `/account/portfolio-history` takes no market parameter, so
  // `last.pnl - first.pnl` is always account-wide. Differencing a single
  // market's derived total against it books every OTHER market's P&L into the
  // residual, under prose telling the reader the residual is expected to be
  // unrealized P&L. The `*InPeriod` arrays are what the reconciliation uses.
  const fillsInPeriod = fillsPage.rows
    .map((row) => parseFill(watch, row))
    .filter((fill) => inPeriod(fill.timestampMs, periodStartMs, periodEndMs));
  const fills = fillsInPeriod.filter(
    (fill) => config.market === null || fill.marketId === config.market,
  );

  onProgress("funding (weight 1)");
  const fundingAnswer = await client.get<unknown[]>({
    path: "/api/v1/funding",
    query: [["limit", String(Math.min(FUNDING_LIMIT, config.maxRows))]],
    signed: true,
  });
  if (!Array.isArray(fundingAnswer.body)) {
    throw new TypeError("GET /api/v1/funding: expected a JSON array");
  }
  const fundingInPeriod = fundingAnswer.body
    .map((row) => parseFunding(watch, row))
    .filter((row) => inPeriod(row.timestampMs, periodStartMs, periodEndMs));
  const fundingRows = fundingInPeriod.filter(
    (row) => config.market === null || row.marketId === config.market,
  );

  const fundingDepth = readFundingDepth(fundingAnswer.headers);
  describeFundingDepth(fundingDepth, periodStartMs, caveats);

  onProgress("positions/closed (weight 1 per page)");
  const closedPage = await paginate<unknown>(
    client,
    "/api/v1/positions/closed",
    CLOSED_PAGE,
    config.maxRows,
    1,
  );
  const closedInPeriod = closedPage.rows
    .map((row) => parseClosed(watch, row))
    .filter((row) => inPeriod(row.closedAtMs, periodStartMs, periodEndMs));
  const closed = closedInPeriod.filter(
    (row) => config.market === null || row.marketId === config.market,
  );

  onProgress("account/fees (weight 1)");
  let fees: FeeSchedule | null = null;
  try {
    const feesAnswer = await client.get<unknown>({
      path: "/api/v1/account/fees",
      signed: true,
    });
    fees = parseFees(watch, feesAnswer.body);
  } catch (error) {
    caveats.push(
      `the fee schedule could not be read (${(error as Error).message}); the ` +
        "fees above are the ones the fills state, which is the realized " +
        "number anyway.",
    );
  }

  onProgress(`orders/history (weight ${HEAVY_READ_WEIGHT} per page)`);
  const activity = await readActivity(client, config, periodStartMs, periodEndMs);

  const lines = fold(fills, fundingRows, closed);
  // Identical to `lines.totals` when no `--market` is given, so the common case
  // costs one extra fold over rows already in memory and no extra request.
  const accountWideTotals =
    config.market === null
      ? lines.totals
      : fold(fillsInPeriod, fundingInPeriod, closedInPeriod).totals;
  const fundingSignConflicts = fundingRows.filter((row) => !row.directionAgrees).length;

  if (fillsPage.capped) {
    caveats.push(
      `the fill walk stopped at the ${config.maxRows}-row cap, so the fee and ` +
        "volume lines above are a floor, not a total. Raise NEXUS_MAX_ROWS.",
    );
  }
  if (closedPage.capped) {
    caveats.push(
      `the closed-position walk stopped at the ${config.maxRows}-row cap, so ` +
        "realized P&L above is a floor, not a total.",
    );
  }
  if (fundingSignConflicts > 0) {
    caveats.push(
      `${fundingSignConflicts} funding row(s) had a \`direction\` that ` +
        "contradicted the sign of `amount`. The signed `amount` was used; the " +
        "rows are listed above so the disagreement is visible rather than " +
        "averaged away.",
    );
  }

  return {
    periodStartMs,
    periodEndMs,
    periodFromSeries,
    markets: lines.markets,
    totals: lines.totals,
    accountWideTotals,
    funding: fundingDepth,
    fundingSignConflicts,
    fillsCapped: fillsPage.capped,
    closedCapped: closedPage.capped,
    fees,
    portfolio,
    activity,
    watch,
    caveats,
  };
}

/**
 * Read `/funding`'s two depth headers.
 *
 * Both are **additive and newer than the `v0.8.1` tag this example pins**, so
 * a deployment serving that contract sends neither. That is not an error — it
 * is the reason both are typed as nullable rather than defaulted. Absence
 * means *unknown*: never `false`, and never `0`. Substituting a zero for
 * `oldest_ms` would claim funding history back to the epoch.
 */
function readFundingDepth(headers: Headers): FundingDepth {
  const truncated = headers.get("x-nexus-funding-truncated");
  const oldest = headers.get("x-nexus-funding-oldest-ms");
  const oldestMs = oldest === null ? null : Number(oldest);
  return {
    truncated: truncated === "true" ? true : truncated === "false" ? false : null,
    oldestMs: oldestMs !== null && Number.isFinite(oldestMs) ? Math.trunc(oldestMs) : null,
  };
}

/**
 * Turn the depth headers into plain sentences.
 *
 * `/funding` is served from a bounded in-memory tier that never queries the
 * durable store, so a short answer is not evidence that the account paid no
 * funding. This is the single easiest way for a statement like this one to be
 * confidently wrong, which is why it gets its own paragraph in the output
 * rather than a footnote.
 */
function describeFundingDepth(
  depth: FundingDepth,
  periodStartMs: number,
  caveats: string[],
): void {
  if (depth.truncated === null && depth.oldestMs === null) {
    caveats.push(
      "`/funding` sent neither depth header, so how far back its answer " +
        "reaches is unknown. It is served from a bounded in-memory tier, and " +
        "rows older than that tier's floor exist and are not returned — so a " +
        "small funding total here is not proof of a small funding bill.",
    );
    return;
  }
  if (depth.truncated === true) {
    caveats.push(
      "`/funding` reported that `limit` cut rows off its answer, so the " +
        "funding lines above are a floor. Raise NEXUS_MAX_ROWS.",
    );
  }
  if (depth.oldestMs !== null && depth.oldestMs > periodStartMs) {
    caveats.push(
      "`/funding` can only reach back to " +
        `${new Date(depth.oldestMs).toISOString()}, which is AFTER this ` +
        "statement's period begins. Funding settled earlier in the period is " +
        "durably stored and was not returned, so the funding lines are " +
        "incomplete for this window by a known amount of time.",
    );
  }
}

/**
 * Order history, summarised.
 *
 * The cheapest useful thing to do with a weight-5 paginated surface: count
 * terminal statuses. It answers "how much of what I sent actually traded"
 * without claiming anything monetary, which the endpoint is not the right
 * source for anyway — `/fills` is.
 */
async function readActivity(
  client: RestClient,
  config: Config,
  periodStartMs: number,
  periodEndMs: number,
): Promise<ActivitySummary | null> {
  const page = await paginate<unknown>(
    client,
    "/api/v1/orders/history",
    ORDERS_PAGE,
    config.maxRows,
    HEAVY_READ_WEIGHT,
  );
  const byStatus = new Map<string, number>();
  let total = 0;
  let unplaceable = 0;
  for (const row of page.rows) {
    const record = asRecord(row);
    // A row with NEITHER timestamp cannot be placed in the period, and the old
    // condition counted it anyway: `typeof at === "number"` is false, so the
    // guard fell through and the row was included wherever it belonged
    // (@nvizble, #22). That inflates the terminal-order count with orders from
    // outside the window — quietly, since the count carries no caveat saying
    // some of it is unplaced. A row we cannot place is a row we cannot claim.
    const at = record["completed_at_ms"] ?? record["created_at_ms"];
    if (typeof at !== "number" || !Number.isFinite(at)) {
      unplaceable += 1;
      continue;
    }
    if (!inPeriod(Math.trunc(at), periodStartMs, periodEndMs)) continue;
    const marketId = record["market_id"];
    if (config.market !== null && marketId !== config.market) continue;
    const status = typeof record["status"] === "string" ? record["status"] : "unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    total += 1;
  }
  return { total, byStatus, capped: page.capped, unplaceable };
}

/** Fold the three row sets into one line per market, plus a total. */
function fold(
  fills: readonly Fill[],
  funding: readonly FundingRow[],
  closed: readonly ClosedPosition[],
): { markets: readonly MarketLine[]; totals: MarketLine } {
  const lines = new Map<string, MarketLine>();
  const take = (marketId: string): MarketLine =>
    lines.get(marketId) ?? emptyLine(marketId);

  for (const fill of fills) {
    const line = take(fill.marketId);
    lines.set(fill.marketId, {
      ...line,
      // Notional is price × size, exactly: both are decimals, and the product
      // of two decimals is a decimal whose scale is the sum of theirs.
      volume: add(line.volume, multiply(fill.price, fill.size)),
      fees: fill.fee === null ? line.fees : add(line.fees, fill.fee),
      feeUnknownFills: line.feeUnknownFills + (fill.fee === null ? 1 : 0),
      fills: line.fills + 1,
      makerFills: line.makerFills + (fill.role === "maker" ? 1 : 0),
      takerFills: line.takerFills + (fill.role === "taker" ? 1 : 0),
    });
  }

  for (const row of funding) {
    const line = take(row.marketId);
    // The sign convention, in one place: `amount` is negative when the account
    // paid and positive when it received, so the net is a plain sum and the
    // two gross figures are the sum of each sign class. Summing `amount`
    // without regard to sign — or, worse, summing `Math.abs(amount)` and then
    // reading `direction` for a label — reports payments and receipts as the
    // same quantity, which is the trap this endpoint is famous for.
    lines.set(row.marketId, {
      ...line,
      fundingNet: add(line.fundingNet, row.amount),
      fundingPaid: sign(row.amount) < 0 ? add(line.fundingPaid, row.amount) : line.fundingPaid,
      fundingReceived:
        sign(row.amount) > 0 ? add(line.fundingReceived, row.amount) : line.fundingReceived,
    });
  }

  for (const position of closed) {
    const line = take(position.marketId);
    lines.set(position.marketId, {
      ...line,
      realizedPnl: add(line.realizedPnl, position.realizedPnl),
      closes: line.closes + 1,
    });
  }

  const markets = [...lines.values()].sort((a, b) =>
    a.marketId.localeCompare(b.marketId),
  );

  const totals: MarketLine = {
    marketId: "TOTAL",
    realizedPnl: sum(markets.map((line) => line.realizedPnl)),
    fees: sum(markets.map((line) => line.fees)),
    feeUnknownFills: markets.reduce((n, line) => n + line.feeUnknownFills, 0),
    fundingNet: sum(markets.map((line) => line.fundingNet)),
    fundingPaid: sum(markets.map((line) => line.fundingPaid)),
    fundingReceived: sum(markets.map((line) => line.fundingReceived)),
    volume: sum(markets.map((line) => line.volume)),
    fills: markets.reduce((n, line) => n + line.fills, 0),
    makerFills: markets.reduce((n, line) => n + line.makerFills, 0),
    takerFills: markets.reduce((n, line) => n + line.takerFills, 0),
    closes: markets.reduce((n, line) => n + line.closes, 0),
  };

  return { markets, totals };
}
