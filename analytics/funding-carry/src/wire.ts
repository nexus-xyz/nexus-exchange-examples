// What the venue actually sends, and how to parse it honestly.
//
// This is the interesting half of the app. Every decision about *what a field
// means when it is missing, zero, negative, or the wrong JSON type* lives
// here, and none of it is visible from the schema alone.
//
// The single most important thing in this file is that **the two funding
// endpoints return two different schemas**, and they are parsed by two
// different functions that refuse each other's shapes. See `parseSettled` and
// `parsePremiumSample`.

import { type Dec, type Fidelity, fromWire, isZero, sign } from "./decimal.js";

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TypeError(`${key}: expected a string, got ${typeof value}`);
  }
  return value;
}

function asTimestamp(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${key}: expected a millisecond timestamp`);
  }
  return Math.trunc(value);
}

/** A field whose wire type is being watched. Reported when it disagrees. */
export interface TypeObservation {
  readonly field: string;
  readonly fidelity: Fidelity;
}

/**
 * Records how each decimal-typed field actually arrived.
 *
 * The spec types every field this app computes on as a `Decimal` string. One
 * shape elsewhere in the API disagrees in production (ENG-8439), and rather
 * than assume this one does not, the app *watches* — so the README's claim
 * about wire types is a measurement the tool re-takes on every run rather than
 * a note that goes stale.
 */
export class TypeWatch {
  private readonly seen = new Map<string, Set<Fidelity>>();

  observe(field: string, fidelity: Fidelity): void {
    const set = this.seen.get(field) ?? new Set<Fidelity>();
    set.add(fidelity);
    this.seen.set(field, set);
  }

  /** Fields that arrived as JSON numbers where the spec promised strings. */
  divergent(): readonly TypeObservation[] {
    const out: TypeObservation[] = [];
    for (const [field, fidelities] of this.seen) {
      if (fidelities.has("from-json-number")) {
        out.push({ field, fidelity: "from-json-number" });
      }
    }
    return out.sort((a, b) => a.field.localeCompare(b.field));
  }
}

function decimalField(
  watch: TypeWatch,
  record: Record<string, unknown>,
  key: string,
  field: string,
): Dec {
  const parsed = fromWire(record[key], field);
  watch.observe(field, parsed.fidelity);
  return parsed.value;
}

// ---------------------------------------------------------------------------
// The two funding schemas
//
// The spec is unusually explicit that these are different, and says so in both
// directions:
//
//   FundingSample        — "A settled funding window … This is not the shape
//                           of /markets/{market_id}/funding-samples."
//   FundingPremiumSample — "Carries the premium and its timestamp, and nothing
//                           else. The settled funding rate, mark price and
//                           oracle price are properties of a settled *window*,
//                           not of an intra-window sample."
//
// Conflating them is the exact defect this example exists not to make, so the
// two parsers below are deliberately intolerant of each other: the settled
// parser requires `funding_rate`, and the premium parser refuses a row that
// carries one. That second check is not paranoia about today's server — it is
// what makes a future convergence of the two shapes an error the reader is
// told about, rather than a silent doubling of the sample count with
// intra-window observations that were never rates.
// ---------------------------------------------------------------------------

/** One **settled** funding window, from `GET /markets/{id}/funding`. */
export interface SettledWindow {
  readonly timestampMs: number;
  /**
   * The realized rate for the window, signed.
   *
   * **Positive means longs pay and shorts receive**, which is the convention
   * the engine implements (`primitives/funding-rate`: *"Sign convention:
   * positive rate → long pays, short receives"*, and the settlement path
   * credits the long `-S × r × T`). The spec does not state this on
   * `FundingSample` itself — see the README, where it is flagged as a gap
   * rather than presented as contract.
   */
  readonly fundingRate: Dec;
  /**
   * The premium of the window's **last** observation, not its average.
   *
   * `"0"` here does not mean parity: the spec says the premium index reads
   * zero until the market has traded, because with no trade reference the
   * numerator is identically zero. On the live testnet that is the common
   * case, not the edge one.
   */
  readonly premiumIndex: Dec;
  /**
   * The perp trade reference at that last observation — **not** the mark.
   *
   * The field is named `mark_price` for wire compatibility only; the spec is
   * emphatic that the mark margin and liquidations use is a different, blended
   * quantity from `GET /markets/{id}/mark-price`. It is read here purely to
   * count the windows that settled with no price context at all (`"0"`), and
   * never multiplied into a figure.
   */
  readonly markPrice: Dec;
  readonly oraclePrice: Dec;
}

export function parseSettled(watch: TypeWatch, raw: unknown): SettledWindow {
  const record = asRecord(raw);
  if (record["funding_rate"] === undefined) {
    throw new TypeError(
      "GET /markets/{id}/funding returned a row with no `funding_rate`. That " +
        "is the shape of FundingPremiumSample, which is a different endpoint " +
        "(/funding-samples) and a different quantity — refusing to treat an " +
        "intra-window premium observation as a settled rate.",
    );
  }
  return {
    timestampMs: asTimestamp(record, "timestamp"),
    fundingRate: decimalField(watch, record, "funding_rate", "FundingSample.funding_rate"),
    premiumIndex: decimalField(watch, record, "premium_index", "FundingSample.premium_index"),
    markPrice: decimalField(watch, record, "mark_price", "FundingSample.mark_price"),
    oraclePrice: decimalField(watch, record, "oracle_price", "FundingSample.oracle_price"),
  };
}

/** One intra-window premium observation, from `GET /{id}/funding-samples`. */
export interface PremiumSample {
  readonly timestampMs: number;
  readonly premiumIndex: Dec;
}

export function parsePremiumSample(watch: TypeWatch, raw: unknown): PremiumSample {
  const record = asRecord(raw);
  if (record["funding_rate"] !== undefined) {
    throw new TypeError(
      "GET /markets/{id}/funding-samples returned a row carrying " +
        "`funding_rate`. The spec says this endpoint serves " +
        "FundingPremiumSample — timestamp and premium only — so the two " +
        "schemas have converged and this app's separation of them needs " +
        "revisiting. Refusing rather than guessing which quantity it is.",
    );
  }
  return {
    timestampMs: asTimestamp(record, "timestamp"),
    premiumIndex: decimalField(
      watch,
      record,
      "premium_index",
      "FundingPremiumSample.premium_index",
    ),
  };
}

// ---------------------------------------------------------------------------
// Margin, and the two market lists
// ---------------------------------------------------------------------------

/** Per-market margin, from `GET /markets/{id}/risk-params`. */
export interface RiskParams {
  readonly marketId: string;
  readonly maxLeverage: number;
  /** The fraction of notional a position ties up when it is opened. */
  readonly initialMarginRate: Dec;
  readonly maintenanceMarginRate: Dec;
  /**
   * `true` when `initial < maintenance`, which should not happen.
   *
   * Reported rather than corrected. Measured on the live testnet:
   * `NDQ-USDX-PERP` answers `initial_margin_rate == maintenance_margin_rate ==
   * "0.02"` — equal, not inverted, so it does not trip this — while its
   * `max_leverage` of 50 agrees with the initial rate. The check exists
   * because the margin denominator is what turns a carry into a return, and a
   * denominator nobody sanity-checked is how a ranking gets quietly reordered.
   */
  readonly inverted: boolean;
}

export function parseRiskParams(watch: TypeWatch, raw: unknown): RiskParams {
  const record = asRecord(raw);
  const maxLeverage = record["max_leverage"];
  if (typeof maxLeverage !== "number" || !Number.isFinite(maxLeverage)) {
    throw new TypeError("risk-params: max_leverage must be an integer");
  }
  const initial = decimalField(
    watch,
    record,
    "initial_margin_rate",
    "MarketRiskParams.initial_margin_rate",
  );
  const maintenance = decimalField(
    watch,
    record,
    "maintenance_margin_rate",
    "MarketRiskParams.maintenance_margin_rate",
  );
  return {
    marketId: asString(record, "market_id"),
    maxLeverage: Math.trunc(maxLeverage),
    initialMarginRate: initial,
    maintenanceMarginRate: maintenance,
    inverted: sign(initial) > 0 && compareLess(initial, maintenance),
  };
}

function compareLess(a: Dec, b: Dec): boolean {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * 10n ** BigInt(scale - a.scale);
  const right = b.units * 10n ** BigInt(scale - b.scale);
  return left < right;
}

/**
 * Where a market id was found.
 *
 * Two surfaces list markets and **they do not agree**, measured on the live
 * testnet: `GET /tickers` returned four ids and `GET /markets/summary`
 * returned three, with `NDQ-USDX-PERP` present only in the first — yet
 * `/markets/NDQ-USDX-PERP/funding` serves 174 settled windows and
 * `/markets/NDQ-USDX-PERP/risk-params` answers `200`. So the market is real
 * and tradeable-looking on the funding surfaces while being absent from the
 * registry summary.
 *
 * Neither list is treated as authoritative. The app ranks the **union** and
 * tags each row with where it was found, because a ranking that silently
 * dropped a market with a week of funding history would be wrong, and one that
 * silently included a market the registry does not carry would be wrong in the
 * other direction. Saying which is which is the only honest option.
 */
export type Discovery = "both" | "tickers-only" | "summary-only";

export interface DiscoveredMarket {
  readonly marketId: string;
  readonly discovery: Discovery;
  /** `status` from `/markets/summary`, when that surface listed it. */
  readonly status: string | null;
}

/** `GET /markets/summary` — an array of objects, each with `market_id`. */
export function parseSummaryIds(raw: unknown): Map<string, string | null> {
  if (!Array.isArray(raw)) {
    throw new TypeError("GET /markets/summary: expected a JSON array");
  }
  const out = new Map<string, string | null>();
  for (const entry of raw) {
    const record = asRecord(entry);
    const status = record["status"];
    out.set(
      asString(record, "market_id"),
      typeof status === "string" ? status : null,
    );
  }
  return out;
}

/**
 * `GET /tickers` — an **object keyed by symbol**, not an array.
 *
 * Measured: the response is `{"BTC-USDX-PERP": {...}, ...}`. The spec's
 * `Ticker` schema describes the value; the envelope is a map. Nothing in the
 * ticker body is read here — every numeric field on it is a JSON `number` by
 * declaration, including `quoteVolume`, whose own description calls it "a
 * lossy `f64` conversion" — so this is used for its **keys only**.
 */
export function parseTickerIds(raw: unknown): Set<string> {
  const record = asRecord(raw);
  return new Set(Object.keys(record));
}

/** Merge the two lists into one set of candidates, tagged by provenance. */
export function mergeDiscovery(
  tickerIds: ReadonlySet<string>,
  summary: ReadonlyMap<string, string | null>,
): readonly DiscoveredMarket[] {
  const ids = new Set<string>([...tickerIds, ...summary.keys()]);
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((marketId): DiscoveredMarket => {
      const inTickers = tickerIds.has(marketId);
      const inSummary = summary.has(marketId);
      return {
        marketId,
        discovery: inTickers && inSummary
          ? "both"
          : inTickers
            ? "tickers-only"
            : "summary-only",
        status: summary.get(marketId) ?? null,
      };
    });
}

/**
 * Cross-check one settled window's rate against its premium.
 *
 * The rate is driven by the premium, so the two are redundant statements about
 * the same window and it is worth knowing when they part company — the same
 * discipline `account-statement` applies to `/funding`'s `amount` and
 * `direction`. The three ways they can disagree are **not** the same finding,
 * so they are counted separately rather than summed into one "mismatches"
 * number that would hide the only alarming one:
 *
 *   * `rateWithoutPremium` — a non-zero rate on a zero premium. **Expected,
 *     and not a defect.** It is the baseline interest component: on the live
 *     testnet, 117 of BTC's 173 windows read `premium_index: "0"` while
 *     settling at `funding_rate: "0.0000125"`, which is the standard
 *     0.01%-per-8h baseline pro-rated to the 1-hour window this venue settles
 *     on (0.0001 / 8).
 *   * `premiumWithoutRate` — a non-zero premium that settled at exactly zero.
 *     Worth a look: a clamp at zero, or a window whose samples were dropped.
 *   * `opposedSigns` — a rate and a premium of opposite sign. The one that
 *     would actually contradict the model.
 *
 * None of them changes a number. They are reported.
 */
export interface SignCrossCheck {
  readonly rateWithoutPremium: number;
  readonly premiumWithoutRate: number;
  readonly opposedSigns: number;
  /** Windows that settled with no price context at all (`mark_price` `"0"`). */
  readonly noPriceContext: number;
}

export function crossCheckSigns(
  windows: readonly SettledWindow[],
): SignCrossCheck {
  let rateWithoutPremium = 0;
  let premiumWithoutRate = 0;
  let opposedSigns = 0;
  let noPriceContext = 0;
  for (const window of windows) {
    const rateSign = sign(window.fundingRate);
    const premiumSign = sign(window.premiumIndex);
    if (rateSign !== 0 && premiumSign === 0) rateWithoutPremium += 1;
    if (rateSign === 0 && premiumSign !== 0) premiumWithoutRate += 1;
    if (rateSign !== 0 && premiumSign !== 0 && rateSign !== premiumSign) {
      opposedSigns += 1;
    }
    if (isZero(window.markPrice)) noPriceContext += 1;
  }
  return { rateWithoutPremium, premiumWithoutRate, opposedSigns, noPriceContext };
}
