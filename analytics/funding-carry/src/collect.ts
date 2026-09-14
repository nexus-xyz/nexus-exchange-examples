// Reading the four public surfaces, and folding them into one ranking.
//
// The read order matters and is not arbitrary: discovery first, from **both**
// list surfaces, because they disagree (see `wire.ts`'s `Discovery`) and
// picking one silently decides which markets exist. Then per market, the
// settled funding history, the intra-window premium samples, and the margin
// parameters — three separate weight-1 calls, paced by `budget.ts`.
//
// Every failure here is per-market and non-fatal. A market whose `risk-params`
// 404s still gets a carry figure with no return-on-margin column, and says so;
// a market whose funding history is empty is listed as unranked rather than
// dropped. A ranking that quietly omitted whatever it could not read would
// present a partial answer as a complete one.

import {
  type Interval,
  type MarketCarry,
  annualise,
  deriveInterval,
  statistics,
  withinLookback,
} from "./carry.js";
import type { Config } from "./config.js";
import type { Dec } from "./decimal.js";
import { ApiError, type RestClient, headerInteger } from "./rest.js";
import {
  type DiscoveredMarket,
  type RiskParams,
  type SettledWindow,
  TypeWatch,
  crossCheckSigns,
  mergeDiscovery,
  parsePremiumSample,
  parseRiskParams,
  parseSettled,
  parseSummaryIds,
  parseTickerIds,
} from "./wire.js";

/**
 * Settled windows to ask for.
 *
 * The spec's maximum. Worth knowing what the server does with a larger one:
 * `limit=2000` answers `200`, not `400` — it is **clamped, not rejected** — so
 * a client that asked for more than the maximum and assumed it got it would
 * silently shorten its own history. This app asks for the documented maximum
 * and then believes the response.
 */
const FUNDING_LIMIT = 1000;

/** Premium samples to ask for. The spec's maximum: 480 at 60s ≈ 8 hours. */
const PREMIUM_SAMPLE_LIMIT = 480;

/** Everything one run learned, including what it could not learn. */
export interface Report {
  readonly markets: readonly MarketCarry[];
  /** Newest settled window across all markets — the look-back's anchor. */
  readonly anchorMs: number | null;
  /** Local clock at the moment the anchor was chosen, for the drift line. */
  readonly localNowMs: number;
  /** `x-indexer-lag-ms` from the last response that carried it. */
  readonly indexerLagMs: number | null;
  /** Ids that only one of the two list surfaces knew about. */
  readonly discoveryDisagreement: readonly DiscoveredMarket[];
  readonly typeWatch: TypeWatch;
  /** Non-fatal problems, in the order they happened. */
  readonly warnings: readonly string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Discover markets from both list surfaces, and keep the disagreement. */
async function discover(
  client: RestClient,
  warnings: string[],
): Promise<readonly DiscoveredMarket[]> {
  let tickerIds = new Set<string>();
  let summary = new Map<string, string | null>();

  try {
    const answer = await client.get<unknown>({ path: "/api/v1/tickers" });
    tickerIds = parseTickerIds(answer.body);
  } catch (error) {
    warnings.push(`GET /tickers failed: ${errorText(error)}`);
  }

  try {
    const answer = await client.get<unknown>({ path: "/api/v1/markets/summary" });
    summary = parseSummaryIds(answer.body);
  } catch (error) {
    warnings.push(`GET /markets/summary failed: ${errorText(error)}`);
  }

  if (tickerIds.size === 0 && summary.size === 0) {
    throw new Error(
      "neither /tickers nor /markets/summary could be read, so there is no " +
        "market list to rank. Both are public; see the errors above.",
    );
  }
  return mergeDiscovery(tickerIds, summary);
}

/**
 * `GET /markets` is deliberately **not** used for discovery.
 *
 * The spec declares it public — its description says so at length, citing
 * ENG-11484 and the identical `GET /ready` mismatch before it. On the live
 * testnet today it answers `401 UNAUTHORIZED`, which is precisely the
 * fall-through-to-the-authenticated-catch-all behaviour that description says
 * was fixed. So the richest market-parameters surface — the one that carries
 * `funding_rate_cap`, the clamp a carry figure would love to be measured
 * against — is unreadable without credentials on this deployment, and this
 * example takes none.
 *
 * Exported as a constant rather than left as a comment so the README's claim
 * and the code's behaviour cannot drift apart.
 */
export const MARKETS_ENDPOINT_NOTE =
  "GET /api/v1/markets is declared public in the spec and answered 401 on " +
  "the deployment this was written against, so this example discovers " +
  "markets from /tickers and /markets/summary instead. That also costs it " +
  "`funding_rate_cap`, which only /markets carries.";

async function readRiskParams(
  client: RestClient,
  watch: TypeWatch,
  marketId: string,
  warnings: string[],
): Promise<RiskParams | null> {
  try {
    const answer = await client.get<unknown>({
      path: `/api/v1/markets/${marketId}/risk-params`,
    });
    return parseRiskParams(watch, answer.body);
  } catch (error) {
    // A 404 here is a fact about the market, not a failure of the run: the
    // market is listed but has no registered risk parameters. Either way the
    // return-on-margin column is empty for it and says why.
    const detail =
      error instanceof ApiError && error.status === 404
        ? "no risk parameters registered (404)"
        : errorText(error);
    warnings.push(`${marketId}: risk-params unavailable — ${detail}`);
    return null;
  }
}

interface SettledAnswer {
  readonly windows: readonly SettledWindow[];
  /** `x-indexer-lag-ms`, which rides this response. Null when absent. */
  readonly lagMs: number | null;
  /**
   * The page came back full, so there is very likely more history the single
   * request above never saw.
   *
   * `>=` rather than `===` because the endpoint CLAMPS rather than rejects an
   * over-large limit (see `FUNDING_LIMIT`), so a future server that answered
   * more than we asked for would still be truncation from our side.
   */
  readonly truncated: boolean;
}

async function readSettled(
  client: RestClient,
  watch: TypeWatch,
  marketId: string,
): Promise<SettledAnswer> {
  const answer = await client.get<unknown>({
    path: `/api/v1/markets/${marketId}/funding`,
    query: [["limit", String(FUNDING_LIMIT)]],
  });
  if (!Array.isArray(answer.body)) {
    throw new TypeError(`GET /markets/${marketId}/funding: expected an array`);
  }
  const rows = answer.body.map((raw) => parseSettled(watch, raw));
  // The endpoint returns oldest-first, but sorting is cheap and the interval
  // derivation below is meaningless on an unordered series. Believe the data,
  // not the documented order.
  return {
    windows: [...rows].sort((a, b) => a.timestampMs - b.timestampMs),
    lagMs: headerInteger(answer.headers, "x-indexer-lag-ms"),
    truncated: rows.length >= FUNDING_LIMIT,
  };
}

async function readPremiumSamples(
  client: RestClient,
  watch: TypeWatch,
  marketId: string,
  warnings: string[],
): Promise<number> {
  try {
    const answer = await client.get<unknown>({
      path: `/api/v1/markets/${marketId}/funding-samples`,
      query: [["limit", String(PREMIUM_SAMPLE_LIMIT)]],
    });
    if (!Array.isArray(answer.body)) {
      throw new TypeError("expected an array");
    }
    // Parsed, then counted, and deliberately nothing else. Parsing them is
    // the point: `parsePremiumSample` refuses a row carrying `funding_rate`,
    // so this call is what would catch the two schemas converging. Their
    // values are never folded into the carry statistics — they are not
    // settled rates, and treating them as such is the defect this whole
    // example is built around not making.
    return answer.body.map((raw) => parsePremiumSample(watch, raw)).length;
  } catch (error) {
    warnings.push(`${marketId}: funding-samples unavailable — ${errorText(error)}`);
    return 0;
  }
}

/** Read every surface and compute the ranking. */
export async function collect(
  client: RestClient,
  config: Config,
  progress: (message: string) => void,
): Promise<Report> {
  const warnings: string[] = [];
  const watch = new TypeWatch();

  progress("market list from /tickers and /markets/summary");
  const discovered = await discover(client, warnings);
  const candidates =
    config.market === null
      ? discovered
      : discovered.filter((entry) => entry.marketId === config.market);

  if (candidates.length === 0 && config.market !== null) {
    throw new Error(
      `--market ${config.market} was not listed by either /tickers or ` +
        "/markets/summary. Run without --market to see what is.",
    );
  }

  // Pass 1: read every market's settled history, so the look-back anchor can
  // be the newest settlement *across the venue* rather than each market's own.
  // A market that stopped settling three days ago should show three days of
  // missing samples, not a window that quietly slid back to meet it.
  interface Raw {
    readonly entry: DiscoveredMarket;
    readonly settled: readonly SettledWindow[];
    readonly risk: RiskParams | null;
    readonly premiumSamples: number;
    /** See `SettledAnswer.truncated`. Excludes the market from the ranking. */
    readonly truncated: boolean;
  }
  const raws: Raw[] = [];
  let indexerLagMs: number | null = null;

  for (const entry of candidates) {
    progress(`${entry.marketId}: funding, funding-samples, risk-params`);
    let settled: readonly SettledWindow[] = [];
    let truncated = false;
    try {
      const answer = await readSettled(client, watch, entry.marketId);
      settled = answer.windows;
      truncated = answer.truncated;
      if (truncated) {
        warnings.push(
          `${entry.marketId}: funding history came back full at the ` +
            `${FUNDING_LIMIT}-window maximum, so there is history this run did ` +
            "not read. The market is listed but NOT ranked: a carry and a " +
            "dispersion computed here would be labelled with a look-back the " +
            "sample does not cover.",
        );
      }
      // Kept from whichever response last carried it: it is a property of the
      // deployment, not of the market, so the newest reading is the one worth
      // reporting.
      indexerLagMs = answer.lagMs ?? indexerLagMs;
    } catch (error) {
      warnings.push(`${entry.marketId}: funding unavailable — ${errorText(error)}`);
    }
    const premiumSamples = await readPremiumSamples(
      client,
      watch,
      entry.marketId,
      warnings,
    );
    const risk = await readRiskParams(client, watch, entry.marketId, warnings);
    if (risk !== null && risk.inverted) {
      warnings.push(
        `${entry.marketId}: initial margin rate is BELOW the maintenance rate, ` +
          "which should not happen. Return on margin is computed from the " +
          "initial rate anyway and this line is the flag.",
      );
    }
    raws.push({ entry, settled, risk, premiumSamples, truncated });
  }

  const localNowMs = Date.now();
  const anchorMs = raws.reduce<number | null>((newest, raw) => {
    const last = raw.settled.at(-1);
    if (last === undefined) return newest;
    return newest === null || last.timestampMs > newest ? last.timestampMs : newest;
  }, null);

  // Pass 2: filter to the look-back and compute.
  const markets: MarketCarry[] = raws.map((raw): MarketCarry => {
    const inWindow =
      anchorMs === null
        ? []
        : withinLookback(raw.settled, anchorMs, config.windowHours);
    const rates: readonly Dec[] = inWindow.map((window) => window.fundingRate);
    const stats = statistics(rates);
    const interval: Interval | null = deriveInterval(
      inWindow.map((window) => window.timestampMs),
    );
    const crossCheck = crossCheckSigns(inWindow);
    const initialMarginRate = raw.risk?.initialMarginRate ?? null;

    const excluded = excludeReason(
      inWindow.length,
      config.minSamples,
      interval,
      raw.truncated,
    );
    const annualised =
      stats !== null && interval !== null && excluded === null
        ? annualise({ stats, interval, initialMarginRate })
        : null;

    return {
      marketId: raw.entry.marketId,
      discovery: raw.entry.discovery,
      status: raw.entry.status,
      stats,
      interval,
      crossCheck,
      returnedWindows: raw.settled.length,
      truncated: raw.truncated,
      firstMs: inWindow[0]?.timestampMs ?? null,
      lastMs: inWindow.at(-1)?.timestampMs ?? null,
      premiumSamples: raw.premiumSamples,
      initialMarginRate,
      maxLeverage: raw.risk?.maxLeverage ?? null,
      marginInverted: raw.risk?.inverted ?? false,
      periodsPerYear: annualised?.periodsPerYear ?? null,
      carryAnnual: annualised?.carryAnnual ?? null,
      volatilityAnnual: annualised?.volatilityAnnual ?? null,
      ratio: annualised?.ratio ?? null,
      returnOnMargin: annualised?.returnOnMargin ?? null,
      receivingSide: annualised?.receivingSide ?? "flat",
      excluded,
    };
  });

  return {
    markets,
    anchorMs,
    localNowMs,
    indexerLagMs,
    discoveryDisagreement: candidates.filter((entry) => entry.discovery !== "both"),
    typeWatch: watch,
    warnings,
  };
}

/**
 * Why a market is not ranked, or null when it is.
 *
 * Three separate refusals, each with its own sentence, because "not ranked"
 * with no reason is the thing a reader would have to guess at — and the guess
 * ("no data") is wrong for two of the three.
 */
function excludeReason(
  samples: number,
  minSamples: number,
  interval: Interval | null,
  truncated: boolean,
): string | null {
  // FIRST, because it invalidates the series rather than describing it. The
  // three refusals below all reason about what was read; this one is about what
  // was NOT read, and no amount of agreement among the windows we have tells us
  // anything about the ones we do not.
  if (truncated) {
    return (
      `funding history was truncated at the ${FUNDING_LIMIT}-window server ` +
      "maximum, so the look-back this row would be labelled with is longer " +
      "than the sample behind it"
    );
  }
  if (samples === 0) {
    return "no settled funding windows inside the look-back";
  }
  if (samples < minSamples) {
    return (
      `only ${samples} settled window(s) in the look-back, below the ` +
      `${minSamples}-sample floor — a dispersion from this few points has an ` +
      "error bar wider than the differences a ranking would be claiming"
    );
  }
  if (interval === null) {
    return "could not derive a settlement interval";
  }
  if (!interval.confident) {
    return (
      `settlement gaps do not agree on a cadence (only ` +
      `${(interval.share * 100).toFixed(0)}% of ${interval.gaps} gaps share ` +
      "the modal value), so there is no interval to annualise against"
    );
  }
  return null;
}
