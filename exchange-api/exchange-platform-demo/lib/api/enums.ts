/*
 * Nexus Exchange API — enumerations.
 *
 * Sources of truth, in priority order:
 *   1. eng/apps/exchange/backend/common/exchange-types/src/lib.rs  (the engine)
 *   2. eng/apps/exchange/api/openapi.json  info.version 0.7.0      (the spec)
 *
 * Where they disagree, the ENGINE wins and the disagreement is commented here
 * and listed in ./README.md. The engine is what actually rejects your order.
 *
 * Everything is a `const` tuple plus a derived union, so the runtime list and
 * the type can never drift from each other, and a `<select>` can be built by
 * mapping the tuple.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CASING IS NOT CONSISTENT ACROSS THE API. This is the part people get wrong:
 *
 *   Buy | Sell    order placement (OrderRequest.side), Order.side
 *   buy | sell    Fill.side, public Trade.side, OrderHistoryEntry.side
 *   Long | Short  Position.side, ClosedPosition.side
 *
 * Three casings for what a trader thinks of as one concept. The adapter
 * normalizes; nothing above the adapter should ever compare raw wire strings.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────────────────────────────────────── side

/** PascalCase side — request bodies and `Order.side`. Engine `Side`. */
export const SIDES_WIRE = ["Buy", "Sell"] as const;
export type SideWire = (typeof SIDES_WIRE)[number];

/** Lowercase side — fills, public trades, order history. */
export const SIDES_LOWER = ["buy", "sell"] as const;
export type SideLower = (typeof SIDES_LOWER)[number];

/** Position direction. Engine `PositionSide`. */
export const POSITION_SIDES_WIRE = ["Long", "Short"] as const;
export type PositionSideWire = (typeof POSITION_SIDES_WIRE)[number];

/**
 * The terminal's internal side. Uppercase because that is what the existing
 * screens render and compare against, and because a display enum that is
 * distinct from all three wire casings makes it obvious at a glance whether a
 * value has crossed the adapter boundary yet.
 */
export const SIDES_UI = ["BUY", "SELL"] as const;
export type SideUi = (typeof SIDES_UI)[number];

export const POSITION_SIDES_UI = ["LONG", "SHORT"] as const;
export type PositionSideUi = (typeof POSITION_SIDES_UI)[number];

// ────────────────────────────────────────────────────────────────── order type

/**
 * All eight order types the engine accepts. PascalCase on the wire.
 * Engine `OrderType`; identical to the spec's `OrderRequest.order_type` enum.
 *
 * Two unconditional, six conditional:
 *   StopLimit / StopMarket             fire when mark crosses trigger adversely
 *   TakeProfitLimit / TakeProfitMarket fire on the favorable side
 *   TrailingStop                       market-only, fires on retracement
 *   TrailingLimit                      same trigger, rests a limit on fire
 */
export const ORDER_TYPES_WIRE = [
  "Limit",
  "Market",
  "StopLimit",
  "StopMarket",
  "TakeProfitLimit",
  "TakeProfitMarket",
  "TrailingStop",
  "TrailingLimit",
] as const;
export type OrderTypeWire = (typeof ORDER_TYPES_WIRE)[number];

/** Order types that carry a limit price. Sending one without `price` is rejected. */
export const LIMIT_FAMILY: readonly OrderTypeWire[] = ["Limit", "StopLimit", "TakeProfitLimit"];

/** Order types that require `trigger_price` (trailing types derive their own). */
export const TRIGGER_FAMILY: readonly OrderTypeWire[] = [
  "StopLimit",
  "StopMarket",
  "TakeProfitLimit",
  "TakeProfitMarket",
];

/** Order types that require `trailing_offset_bps`. */
export const TRAILING_FAMILY: readonly OrderTypeWire[] = ["TrailingStop", "TrailingLimit"];

export const isLimitFamily = (t: OrderTypeWire) => LIMIT_FAMILY.includes(t);
export const isTriggerFamily = (t: OrderTypeWire) => TRIGGER_FAMILY.includes(t);
export const isTrailingFamily = (t: OrderTypeWire) => TRAILING_FAMILY.includes(t);

/**
 * `GET /orders/history` reports `order_type` in snake_case instead of the
 * PascalCase every other endpoint uses. This is the mapping back.
 */
export const ORDER_TYPE_FROM_SNAKE: Readonly<Record<string, OrderTypeWire>> = {
  limit: "Limit",
  market: "Market",
  stop_limit: "StopLimit",
  stop_market: "StopMarket",
  take_profit_limit: "TakeProfitLimit",
  take_profit_market: "TakeProfitMarket",
  trailing_stop: "TrailingStop",
  trailing_limit: "TrailingLimit",
};

/** Human labels for the order-type control. Not from the API — UI copy. */
export const ORDER_TYPE_LABEL: Readonly<Record<OrderTypeWire, string>> = {
  Limit: "Limit",
  Market: "Market",
  StopLimit: "Stop Limit",
  StopMarket: "Stop Market",
  TakeProfitLimit: "Take Profit Limit",
  TakeProfitMarket: "Take Profit Market",
  TrailingStop: "Trailing Stop",
  TrailingLimit: "Trailing Limit",
};

// ─────────────────────────────────────────────────────────────── time in force

/**
 * Engine `TimeInForce`. Exactly four values.
 *
 * DIVERGENCE WATCH: `ALO` does not exist. Post-only is spelled `PostOnly` and
 * is a time-in-force, not a flag — there is no `post_only` field on
 * `OrderRequest`. Any UI offering an "ALO" chip is talking to a different venue.
 */
export const TIME_IN_FORCE_WIRE = ["GTC", "IOC", "FOK", "PostOnly"] as const;
export type TimeInForceWire = (typeof TIME_IN_FORCE_WIRE)[number];

/** Labels for the TIF control, including the fact that PostOnly is a TIF. */
export const TIF_LABEL: Readonly<Record<TimeInForceWire, string>> = {
  GTC: "GTC",
  IOC: "IOC",
  FOK: "FOK",
  PostOnly: "Post Only",
};

/**
 * Tolerant TIF coercion for legacy UI values. `ALO` (add-liquidity-only) is the
 * Hyperliquid spelling of post-only and appears in the terminal's older order
 * ticket; map it rather than reject it, so a stale component cannot submit an
 * order the engine will refuse.
 */
export function coerceTimeInForce(v: string): TimeInForceWire {
  if (isTimeInForce(v)) return v;
  const u = v.trim().toUpperCase();
  if (u === "ALO" || u === "POSTONLY" || u === "POST_ONLY" || u === "POST-ONLY") return "PostOnly";
  if (u === "GTC" || u === "IOC" || u === "FOK") return u as TimeInForceWire;
  return "GTC";
}

// ─────────────────────────────────────────────────────────────── order status

/**
 * Engine `OrderStatus` — SEVEN variants.
 *
 * DIVERGENCE: the spec's `Order.status` enum lists only six; it omits
 * `Triggered`, the state a conditional order enters when its trigger fires. The
 * engine emits it, so it is included here. A client that types status off the
 * spec alone will hit an unhandled value the first time a stop fires.
 */
export const ORDER_STATUSES_WIRE = [
  "Open",
  "PartiallyFilled",
  "Filled",
  "Cancelled",
  "Rejected",
  "Expired",
  "Triggered",
] as const;
export type OrderStatusWire = (typeof ORDER_STATUSES_WIRE)[number];

/** The six the spec admits. Kept so the gap is expressible in code, not prose. */
export const ORDER_STATUSES_SPEC: readonly OrderStatusWire[] = [
  "Open",
  "PartiallyFilled",
  "Filled",
  "Cancelled",
  "Rejected",
  "Expired",
];

/** Statuses that mean "still working" — i.e. cancellable, shown in the blotter. */
export const OPEN_STATUSES: readonly OrderStatusWire[] = ["Open", "PartiallyFilled", "Triggered"];

/** Statuses that mean "done" — i.e. belongs in order history. */
export const TERMINAL_STATUSES: readonly OrderStatusWire[] = [
  "Filled",
  "Cancelled",
  "Rejected",
  "Expired",
];

export const isOpenStatus = (s: OrderStatusWire) => OPEN_STATUSES.includes(s);
export const isTerminalStatus = (s: OrderStatusWire) => TERMINAL_STATUSES.includes(s);

// ─────────────────────────────────────────────────────────── misc wire enums

export const TAKER_OR_MAKER = ["taker", "maker"] as const;
export type TakerOrMaker = (typeof TAKER_OR_MAKER)[number];

/** `MarketSummary.status` / `MarketStatus.status`. v0.21 halt surface. */
export const MARKET_LIFECYCLE_STATUS = ["active", "halted"] as const;
export type MarketLifecycleStatus = (typeof MARKET_LIFECYCLE_STATUS)[number];

export const FUNDING_DIRECTIONS = ["paid", "received"] as const;
export type FundingDirection = (typeof FUNDING_DIRECTIONS)[number];

export const FUNDS_ENTRY_KINDS = ["deposit", "withdrawal", "faucet"] as const;
export type FundsEntryKind = (typeof FUNDS_ENTRY_KINDS)[number];

export const FUNDS_ENTRY_STATUSES = ["pending", "confirmed", "failed"] as const;
export type FundsEntryStatus = (typeof FUNDS_ENTRY_STATUSES)[number];

/**
 * Candle timeframes. FOUR, and only four — `/markets/{id}/candles?timeframe=`
 * rejects anything else. Notably absent: 15m, 4h, 1d. A "1D" chart button has
 * to be assembled client-side from 1h candles.
 */
export const TIMEFRAMES = ["1s", "1m", "5m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Seconds per timeframe bucket — needed to place candle timestamps. */
export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = {
  "1s": 1,
  "1m": 60,
  "5m": 300,
  "1h": 3600,
};

/** The venue's collateral and quote asset. Every market quotes in it. */
export const QUOTE_ASSET = "USDX";

/** Every market id ends with this. `{BASE}-USDX-PERP`. */
export const MARKET_SUFFIX = "-USDX-PERP";

// ─────────────────────────────────────────────────────────────── type guards

const inTuple = <T extends readonly string[]>(t: T, v: unknown): v is T[number] =>
  typeof v === "string" && (t as readonly string[]).includes(v);

export const isSideWire = (v: unknown): v is SideWire => inTuple(SIDES_WIRE, v);
export const isSideLower = (v: unknown): v is SideLower => inTuple(SIDES_LOWER, v);
export const isPositionSideWire = (v: unknown): v is PositionSideWire =>
  inTuple(POSITION_SIDES_WIRE, v);
export const isOrderType = (v: unknown): v is OrderTypeWire => inTuple(ORDER_TYPES_WIRE, v);
export const isTimeInForce = (v: unknown): v is TimeInForceWire =>
  inTuple(TIME_IN_FORCE_WIRE, v);
export const isOrderStatus = (v: unknown): v is OrderStatusWire =>
  inTuple(ORDER_STATUSES_WIRE, v);
export const isTakerOrMaker = (v: unknown): v is TakerOrMaker => inTuple(TAKER_OR_MAKER, v);
export const isTimeframe = (v: unknown): v is Timeframe => inTuple(TIMEFRAMES, v);
export const isMarketLifecycleStatus = (v: unknown): v is MarketLifecycleStatus =>
  inTuple(MARKET_LIFECYCLE_STATUS, v);

/** True for a well-formed `{BASE}-USDX-PERP` id. Does not check the registry. */
export const isMarketId = (v: unknown): v is string =>
  typeof v === "string" && v.endsWith(MARKET_SUFFIX) && v.length > MARKET_SUFFIX.length;

// ──────────────────────────────────────────────────────── casing conversions

/** Any wire side casing → the UI's uppercase side. Tolerant by design. */
export function sideToUi(v: SideWire | SideLower | string): SideUi {
  return String(v).toLowerCase().startsWith("b") ? "BUY" : "SELL";
}

/** UI side → the PascalCase form `OrderRequest.side` requires. */
export function sideToWire(v: SideUi | SideWire | SideLower | string): SideWire {
  return String(v).toLowerCase().startsWith("b") ? "Buy" : "Sell";
}

/** UI side → the lowercase form fills and the public tape use. */
export function sideToLower(v: SideUi | SideWire | SideLower | string): SideLower {
  return String(v).toLowerCase().startsWith("b") ? "buy" : "sell";
}

/** `Long`/`Short` (any casing) → the UI's `LONG`/`SHORT`. */
export function positionSideToUi(v: PositionSideWire | string): PositionSideUi {
  return String(v).toLowerCase().startsWith("l") ? "LONG" : "SHORT";
}

export function positionSideToWire(v: PositionSideUi | PositionSideWire | string): PositionSideWire {
  return String(v).toLowerCase().startsWith("l") ? "Long" : "Short";
}

/** +1 for long/buy, -1 for short/sell. The only form PnL math should use. */
export function directionOf(v: string): 1 | -1 {
  const c = String(v).toLowerCase()[0];
  return c === "b" || c === "l" ? 1 : -1;
}
