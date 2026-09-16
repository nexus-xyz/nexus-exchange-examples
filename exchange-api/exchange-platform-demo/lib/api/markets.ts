/*
 * Nexus Exchange — the real market registry.
 *
 * Transcribed from the exchange's own market-registry config — the file the
 * exchange service actually boots with. All 32 markets, verbatim values.
 * Nothing here is invented: if a number is in this file it is in that config.
 *
 * Why the client carries a copy of server config at all: `GET /markets` returns
 * exactly this data, so the registry below is a *fixture of that response*. It
 * lets the terminal derive real tick/lot precision offline, and when the live
 * API is wired in, `REGISTRY` is replaced by the fetched `WireMarket[]` and
 * every consumer keeps working — the type is the same.
 *
 * WHAT /markets RETURNS vs WHAT THE SERVER CONFIG HOLDS
 *   The `WireMarket` shape (10 fields) is a strict subset of that config. Fees,
 *   price bands, funding intervals, OI caps and the isolated-margin floor are
 *   in the config but NOT in the /markets response, so they live on `extra`
 *   below and are flagged as fixture-only. A live client cannot learn taker fees
 *   from /markets; it would need the (unspecced) fee schedule.
 */

import type { Decimal, MarketId, WireMarket } from "./types";
import { MARKET_SUFFIX, QUOTE_ASSET } from "./enums";

/** Unchecked cast into the branded Decimal. Only legal for literals we author. */
const d = (s: string) => s as Decimal;

/**
 * Registry fields present in the exchange's server-side market config but
 * absent from `GET /markets`. Fixture-only: a live deployment cannot source
 * these from the documented API.
 */
export type RegistryExtra = {
  /** Maker fee in bps. Negative = rebate. */
  maker_rebate_bps: number;
  /** Taker fee in bps. */
  taker_fee_bps: number;
  /** Order-vs-mark collar, bps. Orders outside it are rejected. */
  price_band_bps: number;
  /** Cap on total open interest, in base units (decimal string). */
  max_open_interest: Decimal;
  /** Charged on liquidation, bps of filled notional. */
  liquidation_penalty_bps: number;
  /** Funding settlement interval, seconds. 3600 (1h) on every market. */
  funding_interval_s: number;
  /** Per-interval funding rate cap, as a ratio. */
  funding_rate_cap: Decimal;
  /** Isolated-margin floor ratio. The engine has isolated margin; the API does not expose it. */
  isolated_margin_floor_ratio: Decimal;
};

export type RegistryMarket = WireMarket & { extra: RegistryExtra };

/*
 * Column order, matching the TOML key order:
 *   base, tick_size, lot_size, max_order_size, imr, mmr, max_leverage,
 *   maker_rebate_bps, taker_fee_bps, price_band_bps, max_open_interest,
 *   liquidation_penalty_bps, funding_rate_cap
 *
 * `min_order_size == lot_size` on all 32 markets, so it is not a column — it is
 * assigned from lot below. If that ever stops being true in the TOML, this is
 * the line that has to grow a column.
 */
type Row = [
  base: string,
  tick: string,
  lot: string,
  maxSize: string,
  imr: string,
  mmr: string,
  maxLev: number,
  makerBps: number,
  takerBps: number,
  bandBps: number,
  maxOi: string,
  liqPenaltyBps: number,
  fundingCap: string,
];

const ROWS: Row[] = [
  // ── Majors (margin profile: MMR < IMR) ────────────────────────────────────
  ["BTC", "0.5", "0.001", "100", "0.02", "0.01", 50, -2, 5, 500, "10000", 50, "0.001"],
  ["ETH", "0.10", "0.01", "1000", "0.02", "0.01", 50, -2, 5, 500, "50000", 50, "0.001"],
  ["SOL", "0.01", "0.1", "10000", "0.05", "0.025", 20, -2, 5, 800, "200000", 50, "0.001"],
  // ── Crypto L1s ────────────────────────────────────────────────────────────
  ["AVAX", "0.01", "0.1", "50000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["DOT", "0.001", "1", "200000", "0.02", "0.02", 50, -2, 5, 800, "1000000", 50, "0.001"],
  ["ADA", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 5, 800, "10000000", 50, "0.001"],
  ["ATOM", "0.01", "0.1", "100000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["NEAR", "0.001", "1", "500000", "0.02", "0.02", 50, -2, 5, 800, "1000000", 50, "0.001"],
  ["SUI", "0.0001", "1", "500000", "0.02", "0.02", 50, -2, 5, 800, "2000000", 50, "0.001"],
  ["APT", "0.01", "0.1", "100000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["TIA", "0.001", "0.1", "200000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["SEI", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 5, 800, "5000000", 50, "0.001"],
  ["INJ", "0.01", "0.1", "100000", "0.02", "0.02", 50, -2, 5, 800, "200000", 50, "0.001"],
  // ── Crypto DeFi ───────────────────────────────────────────────────────────
  ["LINK", "0.01", "0.1", "200000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["UNI", "0.01", "0.1", "200000", "0.02", "0.02", 50, -2, 5, 800, "500000", 50, "0.001"],
  ["AAVE", "0.1", "0.01", "10000", "0.02", "0.02", 50, -2, 5, 800, "50000", 50, "0.001"],
  // MKR: tick_size "1" — the coarsest tick in the registry. JPY below is the
  // finest at "0.000001". Six orders of magnitude apart, which is exactly why
  // price precision must be derived from tick and never guessed from magnitude.
  ["MKR", "1", "0.001", "1000", "0.02", "0.02", 50, -2, 5, 800, "5000", 50, "0.001"],
  ["SNX", "0.001", "1", "500000", "0.02", "0.02", 50, -2, 5, 800, "1000000", 50, "0.001"],
  ["CRV", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 5, 800, "10000000", 50, "0.001"],
  ["FIL", "0.001", "1", "500000", "0.02", "0.02", 50, -2, 5, 800, "1000000", 50, "0.001"],
  ["WIF", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 6, 800, "10000000", 50, "0.001"],
  // ── Crypto mid-cap (taker 6 bps, one bp wider than the majors) ─────────────
  ["DOGE", "0.00001", "100", "50000000", "0.02", "0.02", 50, -2, 6, 800, "100000000", 50, "0.001"],
  ["ARB", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 6, 800, "10000000", 50, "0.001"],
  ["OP", "0.001", "1", "1000000", "0.02", "0.02", 50, -2, 6, 800, "2000000", 50, "0.001"],
  ["POL", "0.0001", "10", "5000000", "0.02", "0.02", 50, -2, 6, 800, "10000000", 50, "0.001"],
  // ── FX (taker 3 bps, band 500, liq penalty 25) ─────────────────────────────
  ["EUR", "0.0001", "100", "10000000", "0.02", "0.02", 50, -1, 3, 500, "50000000", 25, "0.0005"],
  ["GBP", "0.0001", "100", "10000000", "0.02", "0.02", 50, -1, 3, 500, "50000000", 25, "0.0005"],
  // JPY is quoted INVERTED from USDJPY (~160 → 1/160 ≈ 0.00625); tick 0.000001
  // is ~1.6 bps on that price.
  ["JPY", "0.000001", "10000", "1000000000", "0.02", "0.02", 50, -1, 3, 500, "500000000", 25, "0.0005"],
  // ── Commodities (taker 4 bps, liq penalty 30) ─────────────────────────────
  ["GOLD", "0.10", "0.01", "5000", "0.02", "0.02", 50, -1, 4, 500, "10000", 30, "0.0005"],
  ["OIL", "0.01", "1", "100000", "0.02", "0.02", 50, -1, 4, 500, "500000", 30, "0.0005"],
  // ── Equity indices ────────────────────────────────────────────────────────
  ["SPX", "0.25", "0.01", "5000", "0.02", "0.02", 50, -1, 4, 500, "10000", 30, "0.0005"],
  ["NDQ", "0.25", "0.01", "5000", "0.02", "0.02", 50, -1, 4, 500, "10000", 30, "0.0005"],
];

/** `{BASE}` → `{BASE}-USDX-PERP`. */
export const marketIdFor = (base: string): MarketId => `${base}${MARKET_SUFFIX}`;

/** `{BASE}-USDX-PERP` → `{BASE}`. Returns the input unchanged if unsuffixed. */
export const baseAssetOf = (id: MarketId): string =>
  id.endsWith(MARKET_SUFFIX) ? id.slice(0, -MARKET_SUFFIX.length) : id;

export const REGISTRY: RegistryMarket[] = ROWS.map(
  ([base, tick, lot, maxSize, imr, mmr, maxLev, makerBps, takerBps, bandBps, maxOi, liqBps, cap]) => ({
    market_id: marketIdFor(base),
    base_asset: base,
    quote_asset: QUOTE_ASSET,
    tick_size: d(tick),
    lot_size: d(lot),
    // min_order_size == lot_size across the whole registry (asserted upstream by
    // the config parser's lot/min consistency check).
    min_order_size: d(lot),
    max_order_size: d(maxSize),
    initial_margin_rate: d(imr),
    maintenance_margin_rate: d(mmr),
    max_leverage: maxLev,
    extra: {
      maker_rebate_bps: makerBps,
      taker_fee_bps: takerBps,
      price_band_bps: bandBps,
      max_open_interest: d(maxOi),
      liquidation_penalty_bps: liqBps,
      // 3600 on every market in the registry; hoisted out of the row table
      // rather than repeated 32 times.
      funding_interval_s: 3600,
      funding_rate_cap: d(cap),
      isolated_margin_floor_ratio: d("0.10"),
    },
  }),
);

const BY_ID = new Map(REGISTRY.map((m) => [m.market_id, m]));
const BY_BASE = new Map(REGISTRY.map((m) => [m.base_asset, m]));

/** Registry lookup by full market id. */
export const registryMarket = (id: MarketId): RegistryMarket | undefined => BY_ID.get(id);

/** Registry lookup by base asset ticker, e.g. "BTC". */
export const registryMarketByBase = (base: string): RegistryMarket | undefined =>
  BY_BASE.get(base.toUpperCase());

/** The market ids, in registry order. */
export const MARKET_IDS: MarketId[] = REGISTRY.map((m) => m.market_id);

/** The bare `WireMarket[]` — byte-identical in shape to `GET /markets`. */
export const WIRE_MARKETS: WireMarket[] = REGISTRY.map(({ extra: _extra, ...m }) => m);

// ───────────────────────────────────────────────── precision from tick / lot

/**
 * Decimal places implied by a step string. `"0.5"` → 1, `"1"` → 0,
 * `"0.000001"` → 6, `"10000"` → 0.
 *
 * This is THE precision rule. It replaces guessing decimals from a price's
 * magnitude, which gets MKR (tick 1, price ~1400 → 0 decimals) and JPY
 * (tick 0.000001, price ~0.00625 → 6 decimals) both wrong.
 *
 * Handles exponential notation because a Decimal string may legally arrive as
 * "1e-6"; `"0.5".split(".")` alone would not.
 */
export function stepDecimals(step: string): number {
  const s = step.trim();
  const exp = /e([+-]?\d+)$/i.exec(s);
  if (exp) {
    const mantissa = s.slice(0, exp.index);
    const frac = mantissa.includes(".") ? mantissa.split(".")[1].length : 0;
    return Math.max(0, frac - Number(exp[1]));
  }
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  // Trailing zeros are significant in the config ("0.10" → 2) because the venue
  // quotes to that many places even when the last one is always zero.
  return s.length - dot - 1;
}

/** Price decimals for a market — derived from `tick_size`, never from price. */
export const priceDecimalsOf = (m: WireMarket): number => stepDecimals(m.tick_size);

/** Size decimals for a market — derived from `lot_size`, never from price. */
export const sizeDecimalsOf = (m: WireMarket): number => stepDecimals(m.lot_size);

/** Round `v` down/nearest onto the step grid. `mode` defaults to nearest. */
export function roundToStep(v: number, step: number, mode: "nearest" | "floor" = "nearest"): number {
  if (!(step > 0)) return v;
  const n = mode === "floor" ? Math.floor(v / step) : Math.round(v / step);
  // Re-round to the step's own precision so 0.1 * 3 does not become
  // 0.30000000000000004 and print as an untradeable price.
  const dp = stepDecimals(String(step));
  return Number((n * step).toFixed(Math.min(12, dp)));
}

/** Snap a price onto the market's tick grid. */
export const snapToTick = (m: WireMarket, price: number, mode: "nearest" | "floor" = "nearest") =>
  roundToStep(price, Number(m.tick_size), mode);

/** Snap a size onto the market's lot grid (floor — never round a size up). */
export const snapToLot = (m: WireMarket, size: number) =>
  roundToStep(size, Number(m.lot_size), "floor");

/**
 * Multipliers applied to `tick_size` to build the book's grouping ladder.
 *
 * 1× / 2× / 10× / 20× rather than plain decades, because decades jump too far:
 * BTC (tick 0.5) would offer 0.5 → 5 with nothing in between, and traders group
 * a $64k book at $1. Every multiplier is an integer, so every grouping is an
 * exact multiple of the tick and no level can land off-grid.
 */
const GROUPING_MULTIPLES = [1, 2, 10, 20] as const;

/**
 * Order-book grouping options for a market. Derived from `tick_size`, because a
 * grouping that is not a multiple of the tick produces levels at prices the
 * venue would reject.
 *
 * BTC (tick 0.5) → [0.5, 1, 5, 10]; MKR (tick 1) → [1, 2, 10, 20];
 * JPY (tick 0.000001) → [0.000001, 0.000002, 0.00001, 0.00002].
 */
export function groupingsFor(m: WireMarket): number[] {
  const tick = Number(m.tick_size);
  const dp = stepDecimals(m.tick_size);
  return GROUPING_MULTIPLES.map((k) => Number((tick * k).toFixed(Math.min(12, dp))));
}

/**
 * `max_leverage == floor(1 / initial_margin_rate)` — the engine invariant
 * (eng_4885) asserted across every deployed exchange*.toml. Exported so a UI
 * that shows leverage can assert against the same rule the engine enforces.
 */
export const leverageMatchesMargin = (m: WireMarket): boolean =>
  m.max_leverage === Math.floor(1 / Number(m.initial_margin_rate));
