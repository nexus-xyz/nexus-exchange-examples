/*
 * The market universe — now sourced from the real registry.
 *
 * One canonical record per market, keyed by symbol. Every screen reads from here
 * — the markets table, the market-header strip, the switcher, and the order
 * ticket — so a market's price scale, asset class, and glyph are defined once.
 *
 * WHAT CHANGED WHEN THIS BECAME CONTRACT-BACKED
 *   • Symbols are the real `{BASE}-USDX-PERP` ids, not `{BASE}-USDX`.
 *   • The universe is the real 32-market registry (lib/api/markets.ts, transcribed
 *     from exchange.toml), not a hand-picked 14. The recognisable majors are
 *     ordered first and also exported as `FEATURED`.
 *   • `tickSize` / `lotSize` / margin rates / `maxLev` come from the registry.
 *   • Price and size precision DERIVE FROM tick_size / lot_size. The old rule
 *     guessed decimals from price magnitude, which is wrong at both ends of the
 *     real spread: MKR ticks in whole dollars at a ~$1,400 price (0 decimals,
 *     the old rule said 1) and JPY ticks at 0.000001 on a ~0.00625 price
 *     (6 decimals, the old rule said 4).
 *   • `groupings` are decade multiples of the real tick, so no book level can sit
 *     at a price the venue would reject.
 *
 * Everything that is presentation — `name`, `glyph`, `cls`, `tier`, and the `ref`
 * / `chg24` seeds the mock walks around — is authored HERE and is not part of the
 * API. Those five fields are the mock's, and are marked as such below.
 */

import { comma, rng, seedOf } from "./format";
import {
  REGISTRY,
  baseAssetOf,
  groupingsFor,
  marketIdFor,
  priceDecimalsOf,
  registryMarket,
  sizeDecimalsOf,
  type RegistryMarket,
} from "./api/markets";
import { MARKET_SUFFIX, QUOTE_ASSET } from "./api/enums";
import type { MarketId } from "./api/types";

export type AssetClass = "Crypto" | "Index" | "FX" | "Commodity";

export type Market = {
  /** Real wire symbol / `market_id`, e.g. "BTC-USDX-PERP". */
  sym: MarketId;
  /** Base asset ticker used for size labels, e.g. "BTC". */
  base: string;
  /** Quote + collateral asset. "USDX" on every market. */
  quote: string;
  /** Full instrument name, shown under the symbol in the market header. MOCK. */
  name: string;
  /** Single-glyph mark shown in the switcher and tables. MOCK. */
  glyph: string;
  /** Asset class. MOCK grouping — the API has no asset-class field. */
  cls: AssetClass;
  /** Reference last price — the PRNG walks around this. MOCK. */
  ref: number;
  /** 24h change, percent. MOCK. */
  chg24: number;
  /** Liquidity tier, 1 (majors) to 4 (long tail). MOCK; drives mock volumes. */
  tier: 1 | 2 | 3 | 4;

  // ── Real registry values (== `GET /markets`) ───────────────────────────────
  /** `max_leverage`. Integer, and equal to floor(1 / initial_margin_rate). */
  maxLev: number;
  /** `tick_size` as a number. The minimum price increment. */
  tickSize: number;
  /** `lot_size` as a number. The minimum size increment. */
  lotSize: number;
  /** `min_order_size`. Equal to `lot_size` across the whole registry. */
  minOrderSize: number;
  /** `max_order_size`. */
  maxOrderSize: number;
  /** `initial_margin_rate` as a ratio, e.g. 0.02. */
  imr: number;
  /** `maintenance_margin_rate` as a ratio. */
  mmr: number;
  /** Price decimals, derived from `tick_size`. */
  priceDp: number;
  /** Size decimals, derived from `lot_size`. */
  sizeDp: number;

  // ── Registry values that exist in exchange.toml but NOT in `GET /markets` ──
  /** Maker fee, bps. Negative = rebate. Fixture-only: not served by the API. */
  makerRebateBps: number;
  /** Taker fee, bps. Fixture-only: not served by the API. */
  takerFeeBps: number;
  /** Order-vs-mark collar, bps. Fixture-only. */
  priceBandBps: number;
  /** Funding interval, seconds. 3600 on every market. Fixture-only. */
  fundingIntervalS: number;

  /** Tick sizes offered in the order-book grouping control. Derived from tick. */
  groupings: number[];
  /** The untouched registry entry, i.e. the wire payload plus TOML extras. */
  wire: RegistryMarket;
};

/*
 * Presentation metadata, per base asset. MOCK DATA — none of this comes from the
 * API, which knows only ids, sizes, and margin rates.
 *
 *   [base, display name, glyph, class, ref price, 24h %, liquidity tier]
 *
 * `ref` prices are plausible marks, snapped to each market's real tick on
 * construction below. The first fourteen rows are the terminal's original
 * universe, carried over so the app still reads as the same product.
 */
type MetaRow = [string, string, string, AssetClass, number, number, 1 | 2 | 3 | 4];

const META: MetaRow[] = [
  // ── The original fourteen, re-symboled and re-based on real markets ────────
  ["BTC", "Bitcoin", "₿", "Crypto", 64020, 1.46, 1],
  ["ETH", "Ethereum", "Ξ", "Crypto", 3531, 2.1, 1],
  ["SOL", "Solana", "◎", "Crypto", 162.1, -1.15, 2],
  ["SPX", "S&P 500 Index", "✦", "Index", 5540, 0.42, 2],
  // Was XAU-USDX. The registry spells gold GOLD, not XAU.
  ["GOLD", "Gold · troy ounce", "❖", "Commodity", 2412, 0.31, 2],
  // Was NDX-USDX. The registry spells the Nasdaq index NDQ.
  ["NDQ", "Nasdaq 100 Index", "▲", "Index", 19820, 0.88, 3],
  // Stands in for the retired HYPE-USDX — not a listed market on this venue.
  ["TIA", "Celestia", "◆", "Crypto", 6.24, 11.21, 3],
  // Stands in for the retired TAO-USDX — not a listed market on this venue.
  ["INJ", "Injective", "τ", "Crypto", 21.4, 4.4, 3],
  ["EUR", "Euro · US Dollar", "€", "FX", 1.0842, 0.12, 2],
  // Was WTI-USDX. The registry spells crude OIL.
  ["OIL", "Crude Oil · WTI", "◉", "Commodity", 78.4, -0.92, 3],
  ["SUI", "Sui", "◇", "Crypto", 3.41, 1.25, 3],
  ["AAVE", "Aave", "Ⓐ", "Crypto", 312.4, 3.63, 3],
  // Stands in for the retired XAG-USDX (silver) — no silver market on this venue.
  ["LINK", "Chainlink", "◐", "Crypto", 14.62, 0.55, 2],
  // Stands in for the retired DJI-USDX — no Dow market on this venue.
  ["DOGE", "Dogecoin", "▣", "Crypto", 0.12412, 0.2, 2],

  // ── The rest of the real registry ─────────────────────────────────────────
  ["AVAX", "Avalanche", "▽", "Crypto", 27.4, 1.82, 3],
  ["DOT", "Polkadot", "●", "Crypto", 6.124, -0.64, 3],
  ["ADA", "Cardano", "₳", "Crypto", 0.4412, 0.94, 3],
  ["ATOM", "Cosmos", "⚛", "Crypto", 8.16, -1.42, 3],
  ["NEAR", "NEAR Protocol", "◫", "Crypto", 5.424, 2.71, 3],
  ["APT", "Aptos", "◈", "Crypto", 7.88, -2.14, 3],
  ["SEI", "Sei", "◭", "Crypto", 0.4128, 5.12, 4],
  ["UNI", "Uniswap", "🦄", "Crypto", 8.94, 1.08, 3],
  ["MKR", "Maker", "Ⓜ", "Crypto", 1428, -0.38, 4],
  ["SNX", "Synthetix", "⟠", "Crypto", 2.184, 3.02, 4],
  ["CRV", "Curve DAO", "◠", "Crypto", 0.3124, -3.41, 4],
  ["FIL", "Filecoin", "⌬", "Crypto", 4.128, 0.71, 4],
  ["WIF", "dogwifhat", "◕", "Crypto", 2.4128, 8.42, 4],
  ["ARB", "Arbitrum", "◬", "Crypto", 0.7124, -1.86, 3],
  ["OP", "Optimism", "◯", "Crypto", 1.842, 2.24, 3],
  ["POL", "Polygon", "⬡", "Crypto", 0.4812, -0.52, 3],
  ["GBP", "Pound Sterling · US Dollar", "£", "FX", 1.2714, -0.08, 3],
  // JPY is quoted INVERTED from USDJPY: ~160 USDJPY → ~0.00625 here.
  ["JPY", "Japanese Yen · US Dollar", "¥", "FX", 0.006254, 0.21, 3],
];

/** Fallbacks for a registry market with no META row, so 32 always render. */
const DEFAULT_META = { glyph: "◆", cls: "Crypto" as AssetClass, tier: 3 as const };

function buildMarket(reg: RegistryMarket, meta: MetaRow | undefined): Market {
  const priceDp = priceDecimalsOf(reg);
  const sizeDp = sizeDecimalsOf(reg);
  const tickSize = Number(reg.tick_size);
  // Snap the authored reference price onto the real tick grid. An off-tick ref
  // would make every derived book level off-tick too.
  const rawRef = meta ? meta[4] : 1;
  const ref = Number((Math.round(rawRef / tickSize) * tickSize).toFixed(Math.min(12, priceDp)));
  return {
    sym: reg.market_id,
    base: reg.base_asset,
    quote: reg.quote_asset,
    name: meta ? meta[1] : reg.base_asset,
    glyph: meta ? meta[2] : DEFAULT_META.glyph,
    cls: meta ? meta[3] : DEFAULT_META.cls,
    ref,
    chg24: meta ? meta[5] : 0,
    tier: meta ? meta[6] : DEFAULT_META.tier,
    maxLev: reg.max_leverage,
    tickSize,
    lotSize: Number(reg.lot_size),
    minOrderSize: Number(reg.min_order_size),
    maxOrderSize: Number(reg.max_order_size),
    imr: Number(reg.initial_margin_rate),
    mmr: Number(reg.maintenance_margin_rate),
    priceDp,
    sizeDp,
    makerRebateBps: reg.extra.maker_rebate_bps,
    takerFeeBps: reg.extra.taker_fee_bps,
    priceBandBps: reg.extra.price_band_bps,
    fundingIntervalS: reg.extra.funding_interval_s,
    groupings: groupingsFor(reg),
    wire: reg,
  };
}

const META_BY_BASE = new Map(META.map((r) => [r[0], r]));

/**
 * All 32 markets, META order first (so the recognisable majors lead every table)
 * then any registry market without a META row.
 */
export const MARKETS: Market[] = (() => {
  const out: Market[] = [];
  const seen = new Set<string>();
  for (const row of META) {
    const reg = REGISTRY.find((m) => m.base_asset === row[0]);
    // A META row with no registry market is a typo, not a market. Skipping it
    // silently is right: the registry is the authority on what is listed.
    if (!reg) continue;
    out.push(buildMarket(reg, row));
    seen.add(reg.base_asset);
  }
  for (const reg of REGISTRY) {
    if (seen.has(reg.base_asset)) continue;
    out.push(buildMarket(reg, META_BY_BASE.get(reg.base_asset)));
  }
  return out;
})();

/**
 * The fourteen the terminal was built around — the original universe, re-mapped
 * onto real listings. Use for a curated ticker strip or a "top markets" cut.
 */
export const FEATURED: Market[] = MARKETS.slice(0, 14);

const BY_SYM = new Map(MARKETS.map((m) => [m.sym, m]));
const BY_BASE = new Map(MARKETS.map((m) => [m.base, m]));

export const DEFAULT_MARKET: MarketId = marketIdFor("BTC");

/**
 * Pre-contract symbols → real market ids.
 *
 * Two kinds of entry, and the difference matters:
 *   • RENAMES — same instrument, different id in the real registry.
 *   • RETIRED — the old mock listed something this venue does not trade. Those
 *     point at the nearest real market so an old deep link still lands
 *     somewhere sensible instead of silently snapping to BTC.
 */
export const LEGACY_SYMBOLS: Readonly<Record<string, MarketId>> = {
  // Renames / re-symbols
  "BTC-USDX": marketIdFor("BTC"),
  "ETH-USDX": marketIdFor("ETH"),
  "SOL-USDX": marketIdFor("SOL"),
  "SPX-USDX": marketIdFor("SPX"),
  "EUR-USDX": marketIdFor("EUR"),
  "SUI-USDX": marketIdFor("SUI"),
  "AAVE-USDX": marketIdFor("AAVE"),
  "XAU-USDX": marketIdFor("GOLD"),
  "NDX-USDX": marketIdFor("NDQ"),
  "WTI-USDX": marketIdFor("OIL"),
  // Retired: not listed on this venue (see the META comments)
  "HYPE-USDX": marketIdFor("TIA"),
  "TAO-USDX": marketIdFor("INJ"),
  "XAG-USDX": marketIdFor("LINK"),
  "DJI-USDX": marketIdFor("DOGE"),
};

/**
 * Resolve any symbol shape to a market. Tolerant in four steps so old links,
 * bare tickers, and real ids all work:
 *   exact id → legacy alias → bare base ("BTC") → default.
 */
export function getMarket(sym: string): Market {
  const exact = BY_SYM.get(sym);
  if (exact) return exact;

  const legacy = LEGACY_SYMBOLS[sym];
  if (legacy) return BY_SYM.get(legacy)!;

  const byBase = BY_BASE.get(baseAssetOf(sym).toUpperCase());
  if (byBase) return byBase;

  return BY_SYM.get(DEFAULT_MARKET)!;
}

/** Canonicalize a possibly-legacy symbol to a real market id. */
export const resolveSymbol = (sym: string): MarketId => getMarket(sym).sym;

export const ASSET_CLASSES: ("All" | AssetClass)[] = ["All", "Crypto", "Index", "FX", "Commodity"];

// ---------------------------------------------------------------- static stats
/**
 * Per-market 24h stats. Derived from the symbol seed, so they are stable across
 * renders and across navigations — a market's volume doesn't change when you
 * leave and come back.
 *
 * MOCK. The real equivalents are `GET /markets/summary` (volume_24h,
 * trade_count) and `GET /markets/{id}/ticker` (high, low, quoteVolume). Open
 * interest has no API surface at all today.
 */
export type MarketStats = {
  vol24: number;
  oi: number;
  fills24: number;
  funding: number;
  high24: number;
  low24: number;
  /** Sparkline seed for the 7D trend. */
  spark: number;
};

/**
 * Typical |funding| as a fraction of a market's cap.
 *
 * MEASURED, not chosen: it is the stationary magnitude of the mean-reverting walk in
 * `feed.wireFundingSamples` (step ±0.11·cap, pull 0.22), whose median over 40 seeds
 * settles at 0.033·cap. Exported so the per-market fixture below and the live series
 * are scaled by one number rather than by two independent guesses — they disagreed by
 * a factor of nineteen until the switcher put them on the same screen.
 *
 * At the crypto cap of 0.1%/h this is ~0.0033%/h, or ~29% annualised: an elevated but
 * real perp funding regime, where the previous fixture implied 559%.
 */
export const FUNDING_TYPICAL_FRACTION = 0.033;

/** Tier → 24h notional volume band, in dollars. Roughly an order of magnitude apart. */
const TIER_VOL: Record<1 | 2 | 3 | 4, [number, number]> = {
  1: [620e6, 1.5e9],
  2: [90e6, 260e6],
  3: [18e6, 70e6],
  4: [3e6, 16e6],
};

const STATS = new Map<string, MarketStats>(
  MARKETS.map((m) => {
    const R = rng(seedOf(m.sym));
    const spread24 = Math.abs(m.chg24) / 100 + 0.006 + R() * 0.012;
    const [vLo, vHi] = TIER_VOL[m.tier];
    const vol24 = vLo + R() * (vHi - vLo);
    // Funding is a per-interval RATE in percent here, and the registry caps the
    // underlying ratio (funding_rate_cap: 0.001 crypto / 0.0005 FX+commodities).
    // Respect that cap so the mock cannot show a rate the engine would clamp.
    const capPct = Number(m.wire.extra.funding_rate_cap) * 100;
    return [
      m.sym,
      {
        vol24,
        // Open interest runs a fraction of daily volume — perps turn over fast.
        oi: vol24 * (0.28 + R() * 0.34),
        // Average fill size shrinks as you go down the tiers, so fill counts don't
        // simply track volume.
        fills24: Math.floor(vol24 / (900 + R() * 2200) / m.tier),
        /*
         * Scaled to the FEED's distribution, not to the cap.
         *
         * This sampled uniformly across ±1.6× the cap, which put a typical market at
         * 0.064%/h. The market switcher now shows an annualised column beside it and
         * that read **+559%**, which is not a funding rate, it is a bug with a
         * percent sign. The cap is a clamp the engine applies, not a typical value,
         * and sampling across the whole of it makes every market look like a
         * once-a-year squeeze.
         *
         * Worse, it disagreed with the live series: `wireFundingSamples` mean-reverts
         * to ~3.3% of cap, so the market header read -0.0003% while the switcher said
         * 0.0639% for the SAME market on the SAME screen. That is a direct breach of
         * this project's own rule that panels agree with each other, and it survived
         * because nothing had ever put the two figures side by side.
         */
        funding: (R() - 0.5) * capPct * FUNDING_TYPICAL_FRACTION * 2,
        high24: m.ref * (1 + spread24 * 0.6),
        low24: m.ref * (1 - spread24 * 0.5),
        spark: seedOf(m.sym + ":7d"),
      },
    ];
  }),
);

export function getStats(sym: string): MarketStats {
  return STATS.get(resolveSymbol(sym)) ?? STATS.get(DEFAULT_MARKET)!;
}

// -------------------------------------------------------------- precision API
/**
 * Price decimals for a market — from `tick_size`.
 *
 * This is the replacement for the old magnitude heuristic. Same name and
 * signature so callers did not have to change, entirely different rule.
 */
export const decimalsFor = (m: Market) => m.priceDp;

/** Size decimals for a market — from `lot_size`. */
export const sizeDecimalsFor = (m: Market) => m.sizeDp;

/** Formatted price at the market's native tick precision. */
export const fmtPrice = (m: Market, n: number) => comma(n, m.priceDp);

/** Formatted size at the market's native lot precision. */
export const fmtSize = (m: Market, n: number) => comma(n, m.sizeDp);

/** Snap a price to the market's tick grid. */
export const snapPrice = (m: Market, n: number) =>
  Number((Math.round(n / m.tickSize) * m.tickSize).toFixed(Math.min(12, m.priceDp)));

/** Floor a size onto the market's lot grid — never round a size up. */
export const snapSize = (m: Market, n: number) =>
  Number((Math.floor(n / m.lotSize) * m.lotSize).toFixed(Math.min(12, m.sizeDp)));

// ---------------------------------------------------------------- venue totals
/** Exchange-wide roll-ups shown on the Markets screen. */
export const VENUE = {
  vol24: MARKETS.reduce((a, m) => a + getStats(m.sym).vol24, 0),
  oi: MARKETS.reduce((a, m) => a + getStats(m.sym).oi, 0),
  fills24: MARKETS.reduce((a, m) => a + getStats(m.sym).fills24, 0),
  markets: MARKETS.length,
  classes: new Set(MARKETS.map((m) => m.cls)).size,
};

// ------------------------------------------------------------ compat re-exports
/**
 * Re-exported from the contract layer so a component needs one import to work in
 * real market terms. Anything importing these from "@/lib/markets" keeps working
 * if the registry later moves behind a `GET /markets` fetch.
 */
export { MARKET_SUFFIX, QUOTE_ASSET };
export { registryMarket, marketIdFor, baseAssetOf };
export type { MarketId, RegistryMarket };
