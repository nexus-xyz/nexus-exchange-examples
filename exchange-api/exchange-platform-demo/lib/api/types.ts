/*
 * Nexus Exchange API — wire types.
 *
 * Hand-mirrored from the vendored spec at
 *   eng/apps/exchange/api/openapi.json   (info.version 0.7.0)
 * and cross-checked against the engine types at
 *   eng/apps/exchange/backend/common/exchange-types/src/lib.rs
 *
 * These types describe BYTES ON THE WIRE, not what the UI renders. Nothing in
 * here is formatted, rounded, or converted. The translation to the terminal's
 * internal model happens in exactly one place — ./adapter.ts — so that pointing
 * this app at the real API is a base-URL change plus deleting the mock feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO NUMBER CONVENTIONS (get this wrong and everything else is wrong)
 *
 *   1. Native endpoints — /markets, /orders, /positions, /fills, /account,
 *      /funding, /orders/history, /positions/closed, /orders/preview — encode
 *      every monetary or quantity value as a DECIMAL STRING. The spec is
 *      explicit: "Arbitrary-precision decimal serialized as a string
 *      (lossless). Parse with a decimal type, never a float."
 *
 *   2. CCXT-shaped endpoints — /tickers, /markets/{id}/ticker,
 *      /markets/{id}/orderbook, /markets/{id}/trades, /markets/{id}/candles —
 *      encode values as JSON NUMBERS, because CCXT clients expect floats.
 *      Candles are bare tuples: [ts_ms, open, high, low, close, volume].
 *
 * Mixing them is the single most likely wiring bug, so the `Decimal` type below
 * is BRANDED: a bare string literal will not typecheck where a Decimal is
 * required. Construct one with `dec()` / `decFromNumber()` from ./adapter.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  MarketLifecycleStatus,
  OrderStatusWire,
  OrderTypeWire,
  SideLower,
  SideWire,
  PositionSideWire,
  TakerOrMaker,
  TimeInForceWire,
  FundingDirection,
  FundsEntryKind,
  FundsEntryStatus,
} from "./enums";

// ─────────────────────────────────────────────────────────── scalar primitives

/**
 * `Decimal` — spec `components.schemas.Decimal`. A lossless decimal serialized
 * as a JSON string.
 *
 * Branded on purpose. `const p: Decimal = "50000"` is a compile error; you must
 * go through `dec("50000")`. That one bit of friction is what stops a float from
 * silently reaching a price field, which is the failure this whole module exists
 * to prevent.
 */
export type Decimal = string & { readonly __brand: "Decimal" };

/** `TimestampMs` — spec `components.schemas.TimestampMs`. Unix epoch ms. */
export type TimestampMs = number;

/** 0x-prefixed EVM address, used as the account id throughout. */
export type Address = string;

/** UUID string. Order ids, fill ids, trade ids. */
export type Uuid = string;

/**
 * Market id — `{BASE}-USDX-PERP`, e.g. `BTC-USDX-PERP`. Kept as a plain string
 * (not a literal union of the 32 known markets) because the registry is server
 * config: a live venue can add a market without a client redeploy.
 */
export type MarketId = string;

// ──────────────────────────────────────────────────────────────────── markets

/** `GET /markets` → `Market[]`. Every numeric field is a decimal string. */
export type WireMarket = {
  market_id: MarketId;
  base_asset: string;
  /** Always "USDX" on every market in the registry — USDX is the collateral. */
  quote_asset: string;
  tick_size: Decimal;
  lot_size: Decimal;
  min_order_size: Decimal;
  max_order_size: Decimal;
  initial_margin_rate: Decimal;
  maintenance_margin_rate: Decimal;
  /**
   * The ONE integer in this payload — not a decimal string. Invariant enforced
   * by the engine (eng_4885): `max_leverage == floor(1 / initial_margin_rate)`.
   */
  max_leverage: number;
};

/**
 * `GET /markets/summary` → `MarketSummary[]`.
 *
 * NOTE the number convention flip: this endpoint is CCXT-adjacent and uses JSON
 * numbers for `last_trade_price` / `volume_24h`, unlike `/markets` above.
 */
export type WireMarketSummary = {
  market_id: MarketId;
  /** Last TRADE price — not the mark. The mark is on /mark-price + ticker. */
  last_trade_price: number | null;
  volume_24h: number;
  trade_count: number;
  status: MarketLifecycleStatus;
  halt_reason: string | null;
  halted_at: TimestampMs | null;
  adl_event_count: number;
};

/** `GET /markets/{id}/status` → `MarketStatus`. v0.21 halt surface. */
export type WireMarketStatus = {
  market_id: MarketId;
  status: MarketLifecycleStatus;
  halt_reason: string | null;
  halted_at: TimestampMs | null;
  adl_event_count: number;
};

/** `GET /markets/{id}/risk-params` → `MarketRiskParams`. */
export type WireMarketRiskParams = {
  market_id: MarketId;
  max_leverage: number;
  initial_margin_rate: Decimal;
  maintenance_margin_rate: Decimal;
};

/**
 * `GET /markets/{id}/mark-price`.
 *
 * The spec declares only an `example` for this route, no `$ref`d schema, so this
 * shape is transcribed from that example: `{ market_id, mark_price }` with
 * `mark_price` a decimal STRING (this route is native, not CCXT).
 */
export type WireMarkPrice = {
  market_id: MarketId;
  mark_price: Decimal;
};

// ─────────────────────────────────────────────── CCXT-shaped public endpoints

/**
 * `GET /markets/{id}/ticker`, `GET /tickers` → `Ticker`. CCXT shape:
 * camelCase keys, JSON numbers, nullable everything.
 */
export type WireTicker = {
  symbol: MarketId;
  timestamp: TimestampMs;
  /** ISO-8601. Redundant with `timestamp`; CCXT requires both. */
  datetime: string;
  high: number | null;
  low: number | null;
  bid: number | null;
  bidVolume: number | null;
  ask: number | null;
  askVolume: number | null;
  open: number | null;
  close: number | null;
  /** Last trade price. */
  last: number | null;
  change: number | null;
  /** 24h change in PERCENT (CCXT convention), not a ratio. */
  percentage: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  /** Engine mark (oracle + premium index), falls back to `last` pre-first-poll. */
  markPrice: number | null;
  indexPrice: number | null;
  info: Record<string, unknown>;
};

/** One `[price, amount]` book level. JSON numbers, per CCXT. */
export type WireBookLevel = [price: number, amount: number];

/** `GET /markets/{id}/orderbook` → `OrderBook`. */
export type WireOrderBook = {
  symbol: MarketId;
  /** Descending by price (best bid first). */
  bids: WireBookLevel[];
  /** Ascending by price (best ask first) — i.e. NOT render order for a ladder. */
  asks: WireBookLevel[];
  timestamp: TimestampMs;
  datetime: string;
  /** Monotonic sequence number for gap detection on the WS diff stream. */
  nonce: number;
};

/**
 * `GET /markets/{id}/candles` → `[ts_ms, o, h, l, c, v][]`.
 * A bare tuple array — there is no object wrapper and no field names.
 */
export type WireCandle = [
  timestamp: TimestampMs,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
];

/**
 * `GET /markets/{id}/trades` → `Trade[]`. Public tape, CCXT shape.
 *
 * `side` is LOWERCASE here (`buy` | `sell`) while order placement uses
 * PascalCase (`Buy` | `Sell`). That asymmetry is real, not a spec typo — see
 * ./enums.ts.
 */
export type WirePublicTrade = {
  id: Uuid;
  symbol: MarketId;
  price: number;
  amount: number;
  /** price × amount, precomputed by the venue. */
  cost: number;
  side: SideLower;
  timestamp: TimestampMs;
  datetime: string;
  takerOrMaker: TakerOrMaker | null;
  is_liquidation: boolean;
  info: Record<string, unknown>;
};

/**
 * `GET /markets/{id}/funding` → `FundingSample[]`.
 * Native endpoint → decimal STRINGS, unlike the CCXT routes above.
 */
export type WireFundingSample = {
  timestamp: TimestampMs;
  /** Per-interval rate as a ratio (e.g. "0.000000016"), NOT a percent. */
  funding_rate: Decimal;
  premium_index: Decimal;
  mark_price: Decimal;
  oracle_price: Decimal;
};

// ──────────────────────────────────────────────────────────────────── trading

/**
 * `POST /orders` request body → `OrderRequest`.
 *
 * Per-type field requirements (from the spec's schema description):
 *   • limit-family (Limit, StopLimit, TakeProfitLimit)  → `price` required
 *   • triggerable non-trailing (Stop*, TakeProfit*)     → `trigger_price` required
 *   • TrailingStop                                      → `trailing_offset_bps`, market-only
 *   • TrailingLimit                                     → `trailing_offset_bps` + `limit_offset_bps`
 *
 * There is NO `client_id` on this request, NO `margin_mode`, NO `leverage`, and
 * no bracket / OCO composition. See ./README.md § Divergences.
 */
export type WireOrderRequest = {
  market_id: MarketId;
  /** PascalCase on the way IN. */
  side: SideWire;
  order_type: OrderTypeWire;
  /** Limit price. Omit for market-family and trailing orders. */
  price?: Decimal;
  quantity: Decimal;
  time_in_force: TimeInForceWire;
  reduce_only?: boolean;
  /** @deprecated Legacy trigger threshold. `trigger_price` wins when both sent. */
  stop_price?: Decimal | null;
  trigger_price?: Decimal | null;
  /** Basis points. Integer, not a decimal string. */
  trailing_offset_bps?: number | null;
  /** Basis points, 0..9999. TrailingLimit only. */
  limit_offset_bps?: number | null;
};

/**
 * `PATCH /orders/{id}` request body → `AmendOrderRequest`.
 * Atomic cancel-replace. At least one field required; empty body → InvalidAmend.
 * Note the field is `size`, not `quantity` — inconsistent with OrderRequest.
 */
export type WireAmendOrderRequest = {
  price?: Decimal;
  size?: Decimal;
};

/**
 * `Order` — returned by `POST /orders` (inside OrderResponse), `GET /orders`,
 * and `GET /orders/{id}`.
 *
 * WIRE DRIFT: the spec names the resting limit price `price`, but the engine
 * struct (`exchange_types::Order`) names it `limit_price` and some engine-proxied
 * responses emit that name instead. Both are declared here as optional and the
 * adapter reads `price ?? limit_price`. Never read either one directly.
 *
 * WIRE DRIFT: the spec's `status` enum omits `Triggered`, which the engine's
 * `OrderStatus` does have (a conditional order that fired). Typed as the full
 * 7-variant engine union so a `Triggered` order does not fall through parsing.
 */
export type WireOrder = {
  id: Uuid;
  market_id: MarketId;
  account_id: Address;
  side: SideWire;
  /** Spec types this as a bare `string`; it carries `OrderTypeWire` values. */
  order_type: OrderTypeWire;
  /** Spec name for the limit price. */
  price?: Decimal | null;
  /** Engine name for the same field. Read `price ?? limit_price`. */
  limit_price?: Decimal | null;
  quantity: Decimal;
  filled_qty: Decimal;
  status: OrderStatusWire;
  /** Spec types this as a bare `string`; it carries `TimeInForceWire` values. */
  time_in_force: TimeInForceWire;
  created_at: TimestampMs;
  updated_at: TimestampMs;
  limit_offset_bps?: number | null;

  // ── Engine-side fields that appear on engine-proxied payloads but are not in
  // the spec's `Order` schema. All optional: never require them.
  reduce_only?: boolean;
  post_only?: boolean;
  is_liquidation?: boolean;
  stop_price?: Decimal | null;
  trigger_price?: Decimal | null;
  trailing_offset_bps?: number | null;
  trailing_anchor?: Decimal | null;
  /**
   * Engine-only. `OrderRequest` has no `client_id`, so a client cannot set it
   * over HTTP today — treat as read-only and possibly always null.
   */
  client_id?: string | null;
  /** Engine `CancellationReason`, e.g. "User", "MarketHalt", { Stp: ... }. */
  cancellation_reason?: unknown;
};

/** `POST /orders` → 201 `OrderResponse`: the order plus any immediate fills. */
export type WireOrderResponse = {
  order: WireOrder;
  fills: WireFill[];
};

/**
 * `Fill` — `GET /fills`, and the `fills` array on an order response.
 *
 * Note the naming vs `Order`: `size` here, `quantity` there. And `side` is
 * lowercase here, PascalCase on `Order`.
 */
export type WireFill = {
  id: Uuid;
  order_id: string;
  market_id: MarketId;
  side: SideLower;
  price: Decimal;
  size: Decimal;
  /** USDX, signed: negative is a maker rebate. */
  fee: Decimal;
  taker_or_maker: TakerOrMaker;
  timestamp: TimestampMs;
  is_liquidation: boolean;
};

/**
 * `GET /orders/history` → `OrderHistoryEntry[]`. Terminal-status orders only.
 *
 * Three divergences from `Order` for the same conceptual object:
 *   • `side` is lowercase here, PascalCase on `Order`
 *   • `order_type` is snake_case here ("stop_limit"), PascalCase on `Order`
 *   • `size` here, `quantity` on `Order`
 * The adapter normalizes all three.
 */
export type WireOrderHistoryEntry = {
  id: Uuid;
  market_id: MarketId;
  side: SideLower;
  /** snake_case: limit | market | stop_* | take_profit_* | trailing_* */
  order_type: string;
  /** null for market orders. */
  price: Decimal | null;
  /** Original quantity. */
  size: Decimal;
  filled_qty: Decimal;
  status: Extract<OrderStatusWire, "Filled" | "Cancelled" | "Rejected" | "Expired">;
  cancellation_reason: string | null;
  created_at_ms: TimestampMs;
  completed_at_ms: TimestampMs;
};

/** `POST /orders/preview` → `PreviewResponse`. Pre-trade margin/fee projection. */
export type WirePreviewResponse = {
  accepted: boolean;
  reject_reason: string | null;
  required_initial_margin: Decimal;
  projected_post_trade_equity: Decimal;
  projected_post_trade_liquidation_price: Decimal | null;
  projected_post_trade_leverage: Decimal;
  expected_fill_vwap: Decimal | null;
  projected_fees: Decimal;
};

// ──────────────────────────────────────────────────────────── account & risk

/**
 * `Position` — `GET /positions`, and `AccountSummary.positions`.
 *
 * Deliberately missing, and this matters for the UI:
 *   • no `margin_mode` — the engine has Cross/Isolated but the API never
 *     exposes it, so a margin-mode toggle has nothing to bind to
 *   • no `leverage` — position leverage is derived, never set
 *   • no `size`-signed convention: `size` is absolute, direction is in `side`
 *   • `liquidation_price` is present but hardcoded "0" on the live /positions
 *     path, so treat "0" as "unknown", not as "liquidates at zero"
 *   • no `funding_accrued` / `fee_pnl`, which the engine struct does carry
 */
export type WirePosition = {
  market_id: MarketId;
  /** PascalCase Long|Short — a third enum casing, distinct from order sides. */
  side: PositionSideWire;
  /** Absolute size in base units. */
  size: Decimal;
  entry_price: Decimal;
  unrealized_pnl: Decimal;
  realized_pnl: Decimal;
  /** See the caveat above: "0" means the venue did not compute one. */
  liquidation_price: Decimal;
};

/** `GET /account` → `AccountSummary`. */
export type WireAccountSummary = {
  balance: Decimal;
  collateral: Decimal;
  equity: Decimal;
  available_margin: Decimal;
  positions: WirePosition[];
};

/** `GET /account/summary` → `AccountPortfolioSummary`. */
export type WireAccountPortfolioSummary = {
  collateral: Decimal;
  total_equity: Decimal;
  total_unrealized_pnl: Decimal;
  total_realized_pnl_24h: Decimal;
  total_volume_24h: Decimal;
  open_positions_count: number;
  open_orders_count: number;
  margin_used: Decimal;
  available_margin: Decimal;
  /** Only present while the early-access gate is active. */
  early_access_allowed?: boolean;
};

/**
 * `GET /account/equity-history` → `EquityPoint[]`, 5s cadence.
 * `equity` is a JSON NUMBER here even though it is money — the one native
 * endpoint that breaks the decimal-string rule. Do not "fix" it client-side.
 */
export type WireEquityPoint = {
  timestamp_ms: TimestampMs;
  equity: number;
};

/** `GET /positions/closed` → `ClosedPosition[]`. */
export type WireClosedPosition = {
  market_id: MarketId;
  /** The side the position had before it closed. */
  side: PositionSideWire;
  size: Decimal;
  entry_price: Decimal;
  exit_price: Decimal;
  realized_pnl: Decimal;
  closed_at_ms: TimestampMs;
};

/** `GET /funding` → `AccountFunding[]`. Per-account funding payments. */
export type WireAccountFunding = {
  market_id: MarketId;
  /** Signed. `direction` is redundant with the sign but authoritative. */
  amount: Decimal;
  direction: FundingDirection;
  funding_rate: Decimal;
  position_size: Decimal;
  timestamp: TimestampMs;
};

/** `GET /deposits`, `GET /withdrawals` → `FundsEntry[]`. */
export type WireFundsEntry = {
  id: number;
  kind: FundsEntryKind;
  account: Address;
  amount: Decimal;
  asset: string;
  timestamp: TimestampMs;
  status: FundsEntryStatus;
  tx_hash: string | null;
};

// ───────────────────────────────────────────────────────────── venue & health

/** `GET /stats` → `StatsSnapshot`. Unique-trader counts only on /stats. */
export type WireStatsSnapshot = {
  events_received: number;
  fills_total: number;
  liquidations_total: number;
  gap_count: number;
  connected: boolean;
  last_event_ms: TimestampMs | null;
  uptime_seconds: number;
  events_per_sec: number;
  /** Free-form: "Healthy" | "Degraded" | "Unhealthy". */
  health: string;
  highest_sequence_seen: number;
  unique_traders_24h?: number;
  unique_traders_7d?: number;
  unique_traders_30d?: number;
};

// ──────────────────────────────────────────────────── parse-result envelopes

/**
 * A parsed value that survived a partial upstream failure.
 *
 * Mirrors the admin-console convention (repo AGENTS.md rule 9): a bad field on
 * one entry surfaces as a machine-readable `*_error` on that entry rather than
 * failing the whole snapshot. `errors` is keyed by the WIRE field name so an
 * error message can be traced straight back to the payload.
 */
export type Parsed<T> = T & {
  /** Absent on a clean parse. Present ⇒ at least one field fell back. */
  readonly errors?: Readonly<Record<string, string>>;
};
