/*
 * The adapter — the ONE boundary between wire shapes and the terminal's model.
 *
 * Everything above this file works in plain JS numbers with UI-cased enums.
 * Everything below it (./types.ts, ./markets.ts) is the API's own shape. When
 * the mock feed is swapped for `fetch(BASE_URL + path)`, only the callers of
 * these parsers change — never the components.
 *
 * Three principles, each of which exists because of a specific real-world break:
 *
 *  1. TOLERANT, NEVER THROWING. A malformed field degrades that field and records
 *     the reason in `errors[wireFieldName]`; it does not take down the panel.
 *     This mirrors the resilience convention used elsewhere across this
 *     platform (per-entry `*_error`, snapshot stays up) — one bad position
 *     must not blank the blotter.
 *
 *  2. READ BOTH NAMES WHEN THE WIRE HAS TWO. The engine emits `limit_price`
 *     where the spec says `price`; order history uses `size` where `Order` uses
 *     `quantity`, and snake_case order types where everything else is
 *     PascalCase. The parsers absorb all of it.
 *
 *  3. DECIMALS CROSS HERE AND ONLY HERE. `parseDecimal` is the sole place a
 *     decimal string becomes a float, so the lossy step is auditable. Sizes and
 *     prices are re-serialized from the UI's numbers with `decFromNumber` at the
 *     market's own tick/lot precision, so we never post "0.30000000000000004".
 */

import {
  ORDER_TYPE_FROM_SNAKE,
  ORDER_TYPE_LABEL,
  coerceTimeInForce,
  directionOf,
  isLimitFamily,
  isOrderStatus,
  isOrderType,
  isTakerOrMaker,
  isTrailingFamily,
  isTriggerFamily,
  positionSideToUi,
  sideToUi,
  sideToWire,
  type OrderStatusWire,
  type OrderTypeWire,
  type PositionSideUi,
  type SideUi,
  type TakerOrMaker,
  type TimeInForceWire,
  type Timeframe,
  type FundingDirection,
} from "./enums";
import { priceDecimalsOf, sizeDecimalsOf, snapToLot, snapToTick, stepDecimals } from "./markets";
import type {
  WireAccountFunding,
  Decimal,
  MarketId,
  Parsed,
  TimestampMs,
  WireAccountPortfolioSummary,
  WireAccountSummary,
  WireBookLevel,
  WireCandle,
  WireFill,
  WireFundingSample,
  WireMarket,
  WireOrder,
  WireOrderBook,
  WireOrderHistoryEntry,
  WireOrderRequest,
  WirePosition,
  WirePreviewResponse,
  WirePublicTrade,
  WireTicker,
} from "./types";

// ────────────────────────────────────────────────────── decimal construction

/**
 * Brand a string as a `Decimal`. Use for literals you know are well-formed
 * (fixtures, config). Prefer `decFromNumber` for anything computed.
 */
export const dec = (s: string): Decimal => s as Decimal;

/**
 * Number → `Decimal` at a fixed precision.
 *
 * `toFixed` is deliberate: it is the only cheap way to guarantee the string has
 * no float artefacts and no exponent, both of which the venue's decimal parser
 * would either reject or silently widen past tick.
 */
export const decFromNumber = (n: number, decimals: number): Decimal =>
  n.toFixed(Math.max(0, Math.min(18, decimals))) as Decimal;

/** A price as a `Decimal`, snapped to the market's tick and its precision. */
export const priceDecimal = (m: WireMarket, price: number): Decimal =>
  decFromNumber(snapToTick(m, price), priceDecimalsOf(m));

/** A size as a `Decimal`, floored onto the market's lot grid. */
export const sizeDecimal = (m: WireMarket, size: number): Decimal =>
  decFromNumber(snapToLot(m, size), sizeDecimalsOf(m));

// ───────────────────────────────────────────────────────── tolerant primitives

/** Mutable error bag used while parsing one entry. */
type Errs = Record<string, string>;

/** Attach the bag only when non-empty, so a clean parse has no `errors` key. */
function withErrors<T extends object>(value: T, errs: Errs): Parsed<T> {
  return (Object.keys(errs).length ? { ...value, errors: errs } : value) as Parsed<T>;
}

/**
 * Decimal string → number. Records `field` in `errs` and returns `fallback` on
 * anything unparseable (null, "", "abc", NaN, Infinity).
 *
 * Precision note: JS numbers hold ~15-16 significant digits, so a 28-digit
 * decimal loses tail precision here. That is acceptable for *rendering* and is
 * why the reverse path (`decFromNumber`) re-quantizes to tick/lot rather than
 * echoing a float back. It would NOT be acceptable for settlement math, which is
 * the venue's job, not the terminal's.
 */
export function parseDecimal(
  v: Decimal | string | number | null | undefined,
  field: string,
  errs: Errs,
  fallback = 0,
): number {
  if (v === null || v === undefined || v === "") {
    errs[`${field}_error`] = "missing";
    return fallback;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    errs[`${field}_error`] = `unparseable decimal: ${String(v)}`;
    return fallback;
  }
  return n;
}

/** Optional decimal → number | null. Absent is legal and records no error. */
export function parseOptionalDecimal(
  v: Decimal | string | number | null | undefined,
  field: string,
  errs: Errs,
): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    errs[`${field}_error`] = `unparseable decimal: ${String(v)}`;
    return null;
  }
  return n;
}

/**
 * `quantity - filled_qty`, clamped at zero.
 *
 * The wire sends neither — every client computes it. The `toFixed(12)` round-trip
 * matters: 4.2 - 1.05 is 3.1500000000000004 in binary floating point, and a
 * remaining size with 16 significant digits then fails lot-size validation when
 * it is used to seed a close-position order. Decimal subtraction on the venue side
 * has no such artefact, so neither should our mirror of it.
 */
export const remainingQty = (quantity: number, filled: number): number =>
  Math.max(0, Number((quantity - filled).toFixed(12)));

/** CCXT nullable number → number | null, tolerating strings. */
export function parseNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Timestamps: accept ms numbers and numeric strings; 0 means "unknown". */
export function parseTs(v: TimestampMs | string | null | undefined): TimestampMs {
  const n = parseNumber(v);
  return n === null ? 0 : n;
}

// ─────────────────────────────────────────────────────────── UI model: trading

/** An order as the blotter and ticket want it. */
export type UiOrder = {
  id: string;
  /** Market id — `sym` because that is what every existing screen calls it. */
  sym: MarketId;
  side: SideUi;
  type: OrderTypeWire;
  /** "Stop Limit", for display. */
  typeLabel: string;
  /** Limit price, or null for market-family orders. */
  price: number | null;
  quantity: number;
  filled: number;
  /** `quantity - filled_qty`, clamped at 0. The wire does not send this. */
  remaining: number;
  /** 0-100. What the blotter's FILLED column shows. */
  filledPct: number;
  status: OrderStatusWire;
  tif: TimeInForceWire;
  reduceOnly: boolean;
  triggerPrice: number | null;
  trailingOffsetBps: number | null;
  limitOffsetBps: number | null;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  /** Free-form engine `CancellationReason`, stringified for display. */
  cancellationReason: string | null;
};

/**
 * `WireOrder` → `UiOrder`.
 *
 * Handles, in order: the `price ?? limit_price` drift, an unknown `order_type`
 * (falls back to Limit and records it), an unknown `status` (falls back to Open
 * — including `Triggered`, which the spec omits but the engine emits), and
 * `remaining`, which no endpoint returns.
 */
export function parseOrder(w: WireOrder): Parsed<UiOrder> {
  const errs: Errs = {};

  // WIRE DRIFT: spec says `price`, engine struct says `limit_price`. Read both,
  // in spec-first order, and only complain if a limit-family order has neither.
  const rawPrice = w.price ?? w.limit_price ?? null;

  const type: OrderTypeWire = isOrderType(w.order_type)
    ? w.order_type
    : (ORDER_TYPE_FROM_SNAKE[String(w.order_type).toLowerCase()] ??
      (((errs.order_type_error = `unknown order_type: ${String(w.order_type)}`), "Limit") as OrderTypeWire));

  const price = parseOptionalDecimal(rawPrice, "price", errs);
  if (price === null && isLimitFamily(type)) {
    errs.price_error = "limit-family order with no price (checked price and limit_price)";
  }

  const quantity = parseDecimal(w.quantity, "quantity", errs);
  const filled = parseDecimal(w.filled_qty, "filled_qty", errs);

  let status: OrderStatusWire = "Open";
  if (isOrderStatus(w.status)) status = w.status;
  else errs.status_error = `unknown status: ${String(w.status)}`;

  const remaining = remainingQty(quantity, filled);

  return withErrors<UiOrder>(
    {
      id: String(w.id ?? ""),
      sym: w.market_id,
      side: sideToUi(w.side),
      type,
      typeLabel: ORDER_TYPE_LABEL[type],
      price,
      quantity,
      filled,
      remaining,
      filledPct: quantity > 0 ? (filled / quantity) * 100 : 0,
      status,
      tif: coerceTimeInForce(String(w.time_in_force ?? "GTC")),
      reduceOnly: w.reduce_only ?? false,
      // `trigger_price` wins over the deprecated `stop_price`, matching the
      // engine's own precedence rule.
      triggerPrice: parseOptionalDecimal(w.trigger_price ?? w.stop_price, "trigger_price", errs),
      trailingOffsetBps: w.trailing_offset_bps ?? null,
      limitOffsetBps: w.limit_offset_bps ?? null,
      createdAt: parseTs(w.created_at),
      updatedAt: parseTs(w.updated_at),
      cancellationReason:
        w.cancellation_reason == null
          ? null
          : typeof w.cancellation_reason === "string"
            ? w.cancellation_reason
            : JSON.stringify(w.cancellation_reason),
    },
    errs,
  );
}

/**
 * `WireOrderHistoryEntry` → `UiOrder`.
 *
 * Same UI type, different wire field names: `size` not `quantity`, lowercase
 * side, snake_case order type, and `completed_at_ms` in place of `updated_at`.
 * Normalizing to one UI type is the point — the blotter should not know which
 * endpoint a row came from.
 */
export function parseOrderHistoryEntry(w: WireOrderHistoryEntry): Parsed<UiOrder> {
  const errs: Errs = {};
  const type: OrderTypeWire =
    ORDER_TYPE_FROM_SNAKE[String(w.order_type).toLowerCase()] ??
    (isOrderType(w.order_type)
      ? w.order_type
      : (((errs.order_type_error = `unknown order_type: ${String(w.order_type)}`), "Limit") as OrderTypeWire));

  const quantity = parseDecimal(w.size, "size", errs);
  const filled = parseDecimal(w.filled_qty, "filled_qty", errs);
  let status: OrderStatusWire = "Filled";
  if (isOrderStatus(w.status)) status = w.status;
  else errs.status_error = `unknown status: ${String(w.status)}`;

  return withErrors<UiOrder>(
    {
      id: String(w.id ?? ""),
      sym: w.market_id,
      side: sideToUi(w.side),
      type,
      typeLabel: ORDER_TYPE_LABEL[type],
      price: parseOptionalDecimal(w.price, "price", errs),
      quantity,
      filled,
      remaining: remainingQty(quantity, filled),
      filledPct: quantity > 0 ? (filled / quantity) * 100 : 0,
      status,
      // Order history carries no TIF at all. GTC is the assumption, flagged so a
      // UI can choose to render "—" instead of a wrong chip.
      tif: "GTC",
      reduceOnly: false,
      triggerPrice: null,
      trailingOffsetBps: null,
      limitOffsetBps: null,
      createdAt: parseTs(w.created_at_ms),
      updatedAt: parseTs(w.completed_at_ms),
      cancellationReason: w.cancellation_reason ?? null,
    },
    errs,
  );
}

/** A position as the blotter wants it. */
export type UiPosition = {
  sym: MarketId;
  side: PositionSideUi;
  /** +1 long, -1 short. Use this for PnL, never a string compare. */
  dir: 1 | -1;
  /** Absolute base units. */
  size: number;
  entry: number;
  unrealizedPnl: number;
  realizedPnl: number;
  /**
   * null when the venue did not compute one. The live `/positions` path
   * hardcodes "0", so "0" is mapped to null rather than rendered as a real
   * liquidation at zero.
   */
  liq: number | null;
};

export function parsePosition(w: WirePosition): Parsed<UiPosition> {
  const errs: Errs = {};
  const rawLiq = parseOptionalDecimal(w.liquidation_price, "liquidation_price", errs);
  // "0" from the live path means "not computed". Treating it as a price would
  // paint every position as safe-to-zero, which is worse than showing nothing.
  const liq = rawLiq === null || rawLiq === 0 ? null : rawLiq;
  return withErrors<UiPosition>(
    {
      sym: w.market_id,
      side: positionSideToUi(w.side),
      dir: directionOf(String(w.side)),
      size: parseDecimal(w.size, "size", errs),
      entry: parseDecimal(w.entry_price, "entry_price", errs),
      unrealizedPnl: parseDecimal(w.unrealized_pnl, "unrealized_pnl", errs),
      realizedPnl: parseDecimal(w.realized_pnl, "realized_pnl", errs),
      liq,
    },
    errs,
  );
}

/** A fill as the tape and blotter want it. */
export type UiFill = {
  id: string;
  orderId: string;
  sym: MarketId;
  side: SideUi;
  price: number;
  size: number;
  /** USDX. Negative = maker rebate. */
  fee: number;
  role: TakerOrMaker;
  ts: TimestampMs;
  isLiquidation: boolean;
};

export function parseFill(w: WireFill): Parsed<UiFill> {
  const errs: Errs = {};
  let role: TakerOrMaker = "taker";
  if (isTakerOrMaker(w.taker_or_maker)) role = w.taker_or_maker;
  else errs.taker_or_maker_error = `unknown role: ${String(w.taker_or_maker)}`;
  return withErrors<UiFill>(
    {
      id: String(w.id ?? ""),
      orderId: String(w.order_id ?? ""),
      sym: w.market_id,
      side: sideToUi(w.side),
      price: parseDecimal(w.price, "price", errs),
      size: parseDecimal(w.size, "size", errs),
      // NOTE: `fee` is on the REST fill, but the engine's own `Fill` struct has
      // no fee field — per-fill fees are a settlement-layer derivation. A
      // WebSocket fill event may therefore arrive without one; 0 is the fallback.
      fee: parseDecimal(w.fee, "fee", errs),
      role,
      ts: parseTs(w.timestamp),
      isLiquidation: w.is_liquidation ?? false,
    },
    errs,
  );
}

// ────────────────────────────────────────────────────── UI model: market data

export type UiBookLevel = { px: number; sz: number };

/**
 * `WireOrderBook` → sorted levels.
 *
 * Bids come back best-first and asks best-first; a ladder renders asks
 * far-to-near, so `asksDescending` is provided rather than leaving each panel to
 * remember which way the wire order runs.
 */
export function parseOrderBook(w: WireOrderBook): {
  sym: MarketId;
  bids: UiBookLevel[];
  asks: UiBookLevel[];
  asksDescending: UiBookLevel[];
  ts: TimestampMs;
  nonce: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
} {
  const level = ([px, sz]: WireBookLevel): UiBookLevel => ({ px: Number(px), sz: Number(sz) });
  const bids = (w.bids ?? []).map(level).filter((l) => Number.isFinite(l.px));
  const asks = (w.asks ?? []).map(level).filter((l) => Number.isFinite(l.px));
  const bestBid = bids.length ? bids[0].px : null;
  const bestAsk = asks.length ? asks[0].px : null;
  return {
    sym: w.symbol,
    bids,
    asks,
    asksDescending: asks.slice().reverse(),
    ts: parseTs(w.timestamp),
    nonce: w.nonce ?? 0,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

export type UiCandle = { ts: TimestampMs; o: number; h: number; l: number; c: number; v: number };

/** `[ts, o, h, l, c, v]` tuples → named fields. Malformed rows are dropped. */
export function parseCandles(rows: WireCandle[]): UiCandle[] {
  const out: UiCandle[] = [];
  for (const r of rows ?? []) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [ts, o, h, l, c, v] = r;
    if (![o, h, l, c].every((n) => Number.isFinite(Number(n)))) continue;
    out.push({ ts: Number(ts), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 });
  }
  return out;
}

export type UiTicker = {
  sym: MarketId;
  ts: TimestampMs;
  last: number | null;
  /** Engine mark. Falls back to `last` — the venue does this too, pre-first-poll. */
  mark: number | null;
  index: number | null;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  /** Already a PERCENT on the wire (CCXT `percentage`). Not re-scaled here. */
  changePct: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
};

export function parseTicker(w: WireTicker): UiTicker {
  const last = parseNumber(w.last ?? w.close);
  return {
    sym: w.symbol,
    ts: parseTs(w.timestamp),
    last,
    mark: parseNumber(w.markPrice) ?? last,
    index: parseNumber(w.indexPrice),
    bid: parseNumber(w.bid),
    ask: parseNumber(w.ask),
    high: parseNumber(w.high),
    low: parseNumber(w.low),
    open: parseNumber(w.open),
    changePct: parseNumber(w.percentage),
    baseVolume: parseNumber(w.baseVolume),
    quoteVolume: parseNumber(w.quoteVolume),
  };
}

export type UiPublicTrade = {
  id: string;
  sym: MarketId;
  px: number;
  sz: number;
  side: SideUi;
  /** Convenience for tape colouring — equivalent to `side === "BUY"`. */
  up: boolean;
  ts: TimestampMs;
  isLiquidation: boolean;
};

export function parsePublicTrade(w: WirePublicTrade): UiPublicTrade {
  const side = sideToUi(w.side);
  return {
    id: String(w.id ?? ""),
    sym: w.symbol,
    px: Number(w.price) || 0,
    sz: Number(w.amount) || 0,
    side,
    up: side === "BUY",
    ts: parseTs(w.timestamp),
    isLiquidation: w.is_liquidation ?? false,
  };
}

/**
 * One funding payment on this account.
 *
 * `direction` is parsed rather than derived from the sign of `amount`. The wire
 * calls it authoritative, and a venue that ever disagrees with itself here should
 * show its own answer rather than ours.
 */
export type UiAccountFunding = {
  sym: MarketId;
  /** Signed USDX. Negative = paid. */
  amount: number;
  direction: FundingDirection;
  /** Ratio, as sent. */
  rate: number;
  /** Same value in percent — every funding display in this terminal is percent. */
  ratePct: number;
  /** Signed base units: the position the charge was assessed on. */
  positionSize: number;
  ts: TimestampMs;
};

export function parseAccountFunding(w: WireAccountFunding): Parsed<UiAccountFunding> {
  const errs: Errs = {};
  const rate = parseDecimal(w.funding_rate, "funding_rate", errs);
  return withErrors<UiAccountFunding>(
    {
      sym: w.market_id,
      amount: parseDecimal(w.amount, "amount", errs),
      direction: w.direction,
      rate,
      ratePct: rate * 100,
      positionSize: parseDecimal(w.position_size, "position_size", errs),
      ts: parseTs(w.timestamp),
    },
    errs,
  );
}

export type UiFundingSample = {
  ts: TimestampMs;
  /** Ratio, as sent. */
  rate: number;
  /** Same value in percent — what the funding chart plots. */
  ratePct: number;
  premiumIndex: number;
  mark: number;
  oracle: number;
};

export function parseFundingSample(w: WireFundingSample): Parsed<UiFundingSample> {
  const errs: Errs = {};
  const rate = parseDecimal(w.funding_rate, "funding_rate", errs);
  return withErrors<UiFundingSample>(
    {
      ts: parseTs(w.timestamp),
      rate,
      // The wire rate is a RATIO. Every funding display in this terminal is in
      // percent, so the conversion happens once, here.
      ratePct: rate * 100,
      premiumIndex: parseDecimal(w.premium_index, "premium_index", errs),
      mark: parseDecimal(w.mark_price, "mark_price", errs),
      oracle: parseDecimal(w.oracle_price, "oracle_price", errs),
    },
    errs,
  );
}

// ────────────────────────────────────────────────────────── UI model: account

export type UiAccountSummary = {
  balance: number;
  collateral: number;
  equity: number;
  availableMargin: number;
  positions: Parsed<UiPosition>[];
};

export function parseAccountSummary(w: WireAccountSummary): Parsed<UiAccountSummary> {
  const errs: Errs = {};
  return withErrors<UiAccountSummary>(
    {
      balance: parseDecimal(w.balance, "balance", errs),
      collateral: parseDecimal(w.collateral, "collateral", errs),
      equity: parseDecimal(w.equity, "equity", errs),
      availableMargin: parseDecimal(w.available_margin, "available_margin", errs),
      // Per-position failures stay on the position, so one bad row does not
      // invalidate the account.
      positions: (w.positions ?? []).map(parsePosition),
    },
    errs,
  );
}

export type UiPortfolioSummary = {
  collateral: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl24h: number;
  volume24h: number;
  openPositions: number;
  openOrders: number;
  marginUsed: number;
  availableMargin: number;
  earlyAccessAllowed: boolean | null;
};

export function parsePortfolioSummary(
  w: WireAccountPortfolioSummary,
): Parsed<UiPortfolioSummary> {
  const errs: Errs = {};
  return withErrors<UiPortfolioSummary>(
    {
      collateral: parseDecimal(w.collateral, "collateral", errs),
      equity: parseDecimal(w.total_equity, "total_equity", errs),
      unrealizedPnl: parseDecimal(w.total_unrealized_pnl, "total_unrealized_pnl", errs),
      realizedPnl24h: parseDecimal(w.total_realized_pnl_24h, "total_realized_pnl_24h", errs),
      volume24h: parseDecimal(w.total_volume_24h, "total_volume_24h", errs),
      openPositions: w.open_positions_count ?? 0,
      openOrders: w.open_orders_count ?? 0,
      marginUsed: parseDecimal(w.margin_used, "margin_used", errs),
      availableMargin: parseDecimal(w.available_margin, "available_margin", errs),
      earlyAccessAllowed: w.early_access_allowed ?? null,
    },
    errs,
  );
}

export type UiPreview = {
  accepted: boolean;
  rejectReason: string | null;
  requiredInitialMargin: number;
  projectedEquity: number;
  projectedLiquidationPrice: number | null;
  projectedLeverage: number;
  expectedVwap: number | null;
  projectedFees: number;
};

export function parsePreview(w: WirePreviewResponse): Parsed<UiPreview> {
  const errs: Errs = {};
  return withErrors<UiPreview>(
    {
      accepted: w.accepted ?? false,
      rejectReason: w.reject_reason ?? null,
      requiredInitialMargin: parseDecimal(w.required_initial_margin, "required_initial_margin", errs),
      projectedEquity: parseDecimal(w.projected_post_trade_equity, "projected_post_trade_equity", errs),
      projectedLiquidationPrice: parseOptionalDecimal(
        w.projected_post_trade_liquidation_price,
        "projected_post_trade_liquidation_price",
        errs,
      ),
      projectedLeverage: parseDecimal(w.projected_post_trade_leverage, "projected_post_trade_leverage", errs),
      expectedVwap: parseOptionalDecimal(w.expected_fill_vwap, "expected_fill_vwap", errs),
      projectedFees: parseDecimal(w.projected_fees, "projected_fees", errs),
    },
    errs,
  );
}

// ───────────────────────────────────────────────────────── serialize: outbound

/** What an order ticket collects, before it is a wire request. */
export type OrderDraft = {
  sym: MarketId;
  side: SideUi | "BUY" | "SELL";
  type: OrderTypeWire;
  /** Limit price, in UI numbers. Snapped to tick on serialize. */
  price?: number | null;
  /** Base units. Floored to lot on serialize. */
  size: number;
  tif: TimeInForceWire | string;
  reduceOnly?: boolean;
  triggerPrice?: number | null;
  trailingOffsetBps?: number | null;
  limitOffsetBps?: number | null;
};

/** Result of serializing a draft: the body, plus why it would be rejected. */
export type SerializeResult = {
  body: WireOrderRequest;
  /** Empty ⇒ the body satisfies the spec's per-type field requirements. */
  problems: string[];
};

/**
 * `OrderDraft` → `POST /orders` body.
 *
 * Applies the spec's per-type field rules rather than sending everything and
 * letting the venue 400: limit-family needs a price, trigger-family needs a
 * trigger, trailing types need an offset AND must not carry a price or trigger.
 * Fields the wrong type would ignore are OMITTED, not sent as null, because a
 * present-but-null `price` on a Market order is a needless ambiguity.
 *
 * `market` is required (not just `sym`) because tick/lot snapping is not
 * optional: an unsnapped price is a guaranteed rejection.
 */
export function serializeOrderRequest(draft: OrderDraft, market: WireMarket): SerializeResult {
  const problems: string[] = [];
  const type = draft.type;

  const body: WireOrderRequest = {
    market_id: draft.sym,
    side: sideToWire(draft.side),
    order_type: type,
    quantity: sizeDecimal(market, draft.size),
    time_in_force: coerceTimeInForce(String(draft.tif)),
  };

  const minSize = Number(market.min_order_size);
  const maxSize = Number(market.max_order_size);
  const snappedSize = Number(body.quantity);
  if (!(snappedSize > 0)) problems.push("size rounds to zero at this market's lot size");
  else if (snappedSize < minSize) problems.push(`size below min_order_size (${market.min_order_size})`);
  else if (snappedSize > maxSize) problems.push(`size above max_order_size (${market.max_order_size})`);

  if (isLimitFamily(type)) {
    if (draft.price === null || draft.price === undefined || !Number.isFinite(draft.price)) {
      problems.push(`${type} requires a limit price`);
    } else {
      body.price = priceDecimal(market, draft.price);
    }
  }

  if (isTriggerFamily(type)) {
    if (draft.triggerPrice === null || draft.triggerPrice === undefined) {
      problems.push(`${type} requires trigger_price`);
    } else {
      // Canonical field only. `stop_price` is deprecated and we never emit it —
      // sending both invites a precedence bug for zero benefit.
      body.trigger_price = priceDecimal(market, draft.triggerPrice);
    }
  }

  if (isTrailingFamily(type)) {
    const off = draft.trailingOffsetBps;
    if (off === null || off === undefined || !Number.isInteger(off) || off < 0) {
      problems.push(`${type} requires an integer trailing_offset_bps >= 0`);
    } else {
      body.trailing_offset_bps = off;
    }
    if (type === "TrailingLimit") {
      const lim = draft.limitOffsetBps;
      if (lim === null || lim === undefined || !Number.isInteger(lim) || lim < 0 || lim > 9999) {
        problems.push("TrailingLimit requires an integer limit_offset_bps in 0..9999");
      } else {
        body.limit_offset_bps = lim;
      }
    }
  }

  if (draft.reduceOnly) body.reduce_only = true;

  // PostOnly is a TIME-IN-FORCE, not a flag: there is no `post_only` field on
  // OrderRequest. Guard against a UI that models it as a checkbox.
  if (body.time_in_force === "PostOnly" && !isLimitFamily(type)) {
    problems.push("PostOnly is only meaningful for limit-family orders");
  }

  return { body, problems };
}

/** `PATCH /orders/{id}` body. Note the field is `size`, not `quantity`. */
export function serializeAmend(
  market: WireMarket,
  changes: { price?: number | null; size?: number | null },
): { price?: Decimal; size?: Decimal } {
  const out: { price?: Decimal; size?: Decimal } = {};
  if (changes.price !== null && changes.price !== undefined) out.price = priceDecimal(market, changes.price);
  if (changes.size !== null && changes.size !== undefined) out.size = sizeDecimal(market, changes.size);
  return out;
}

// ────────────────────────────────────────────────────────── derived quantities

/**
 * Unrealized PnL for a position at a mark.
 *
 * The venue sends `unrealized_pnl`, so this is only for marking a position
 * against a *fresher* price than the last account snapshot — which is exactly
 * what the blotter does between polls.
 */
export function markToMarket(pos: Pick<UiPosition, "dir" | "size" | "entry">, mark: number) {
  return (mark - pos.entry) * pos.size * pos.dir;
}

/**
 * Initial margin for a notional, from the market's own rate.
 *
 * There is no settable leverage in this API: margin follows
 * `initial_margin_rate`, and `max_leverage` is its reciprocal. A leverage slider
 * is therefore a *display* of `1 / imr`, not a request parameter.
 */
export const initialMarginFor = (m: WireMarket, notional: number) =>
  notional * Number(m.initial_margin_rate);

export const maintenanceMarginFor = (m: WireMarket, notional: number) =>
  notional * Number(m.maintenance_margin_rate);

/** Fee on a notional, from the registry's bps. Negative for the maker rebate. */
export const feeFor = (notional: number, bps: number) => (notional * bps) / 10_000;

/** Re-exported so callers need one import for precision + parsing. */
export { priceDecimalsOf, sizeDecimalsOf, stepDecimals };
export type { Timeframe };
