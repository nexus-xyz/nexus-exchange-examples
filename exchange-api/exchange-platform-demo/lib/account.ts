/*
 * The mock account — now built from wire fixtures.
 *
 * Positions, working orders, fills and funding payments are authored as the
 * REAL payloads (`WirePosition`, `WireOrder`, `WireFill`, `WireAccountFunding`,
 * `WireAccountPortfolioSummary`) and then run through lib/api/adapter.ts, the
 * same parsers a live response would take. The exported `POSITIONS`,
 * `OPEN_ORDERS`, `FILLS` and `ACCOUNT` are therefore the *parsed* model, not
 * hand-written display objects.
 *
 * Why fixtures-then-parse rather than fixtures-as-UI-objects: it means the
 * casing asymmetries are exercised on every page load. The position fixtures say
 * `Long`, the order fixtures say `Buy`, the fill fixtures say `buy`, and all
 * three arrive in the UI as `LONG` / `BUY`. If the adapter regresses, the mock
 * breaks — which is the point.
 *
 * UI FIELD NAMES ARE PRESERVED. `p.sym`, `p.side === "LONG"`, `o.filled` (a
 * percent), `f.role` and so on are unchanged, because the screens compare against
 * them and the conversion is the adapter's job, not the component's. The
 * wire-named fields sit alongside as `p.wire`, `p.unrealizedPnl`, etc.
 */

import {
  dec,
  parseAccountFunding,
  parseFill,
  parseOrder,
  parsePortfolioSummary,
  parsePosition,
  type UiAccountFunding,
  type UiFill,
  type UiOrder,
  type UiPosition,
} from "./api/adapter";
import type {
  WireAccountFunding,
  WireAccountPortfolioSummary,
  WireFill,
  WireOrder,
  WirePosition,
} from "./api/types";
import { marketIdFor, registryMarket } from "./api/markets";
import { EPOCH_MS, hms } from "./feed";

/**
 * Display side for a position. The wire says `Long` / `Short`; the screens
 * render and compare `LONG` / `SHORT`. Both spellings are real, in different
 * layers — see lib/api/enums.ts.
 */
export type Side = "LONG" | "SHORT";

/** A fixed "now" for age math. Never Date.now() — determinism (see feed.ts). */
const NOW_MS = EPOCH_MS;

const min = (n: number) => n * 60_000;

// ─────────────────────────────────────────────────────────── wire fixtures

/**
 * `GET /positions` → `Position[]`.
 *
 * Note what a real position payload does NOT contain: leverage, margin mode,
 * funding accrued, or fee PnL. And `liquidation_price` is hardcoded "0" on the
 * live path — these fixtures carry real values instead, which is a deliberate
 * divergence flagged in lib/api/README.md so the UI has something to render.
 */
export const WIRE_POSITIONS: WirePosition[] = [
  {
    market_id: marketIdFor("BTC"),
    side: "Long",
    size: dec("0.820"),
    entry_price: dec("61240.0"),
    unrealized_pnl: dec("2279.60"),
    realized_pnl: dec("412.08"),
    liquidation_price: dec("54180.0"),
  },
  {
    market_id: marketIdFor("ETH"),
    side: "Short",
    size: dec("12.40"),
    entry_price: dec("3602.1"),
    unrealized_pnl: dec("879.24"),
    realized_pnl: dec("-104.12"),
    liquidation_price: dec("4120.7"),
  },
  {
    market_id: marketIdFor("SOL"),
    side: "Long",
    size: dec("140.0"),
    entry_price: dec("168.40"),
    unrealized_pnl: dec("-882.00"),
    realized_pnl: dec("61.40"),
    liquidation_price: dec("142.10"),
  },
];

/**
 * `GET /orders` → `Order[]`.
 *
 * Deliberately exercises the wire's rough edges:
 *   • the third order uses `limit_price` instead of `price` (the engine's name)
 *   • `PostOnly` and reduce-only appear as what they really are — a TIF value and
 *     a boolean flag, not an order "type"
 *   • a `StopMarket` carries `trigger_price` and NO limit price
 */
export const WIRE_OPEN_ORDERS: WireOrder[] = [
  {
    id: "8d1c0d1e-0000-4000-8000-000000000001",
    market_id: marketIdFor("BTC"),
    account_id: "0x5f2c...9a41",
    side: "Buy",
    order_type: "Limit",
    price: dec("63420.0"),
    quantity: dec("0.150"),
    filled_qty: dec("0.000"),
    status: "Open",
    // PostOnly is a TIME-IN-FORCE on this API. There is no post_only field.
    time_in_force: "PostOnly",
    created_at: NOW_MS - min(42.3),
    updated_at: NOW_MS - min(42.3),
  },
  {
    id: "8d1c0d1e-0000-4000-8000-000000000002",
    market_id: marketIdFor("ETH"),
    account_id: "0x5f2c...9a41",
    side: "Sell",
    order_type: "Limit",
    price: dec("3580.0"),
    quantity: dec("4.20"),
    filled_qty: dec("1.05"),
    status: "PartiallyFilled",
    time_in_force: "GTC",
    reduce_only: true,
    created_at: NOW_MS - min(39.1),
    updated_at: NOW_MS - min(4.2),
  },
  /*
   * A bracket on the open BTC long: take-profit above, stop-loss below.
   *
   * Two ordinary reduce-only trigger orders on the opposite side — because that is all
   * a bracket IS on this API. `POST /orders` cannot compose a parent with children, so
   * the blotter's TP/SL column is DERIVED by matching these back to the position rather
   * than modelled as a field. These rows exist so that column is populated on first
   * paint instead of only after a user places one.
   */
  {
    id: "8d1c0d1e-0000-4000-8000-000000000004",
    market_id: marketIdFor("BTC"),
    account_id: "0x5f2c...9a41",
    side: "Sell",
    order_type: "TakeProfitMarket",
    limit_price: null,
    trigger_price: dec("68400.0"),
    quantity: dec("0.820"),
    filled_qty: dec("0.000"),
    status: "Open",
    time_in_force: "GTC",
    reduce_only: true,
    created_at: NOW_MS - min(40.0),
    updated_at: NOW_MS - min(40.0),
  },
  {
    id: "8d1c0d1e-0000-4000-8000-000000000005",
    market_id: marketIdFor("BTC"),
    account_id: "0x5f2c...9a41",
    side: "Sell",
    order_type: "StopMarket",
    limit_price: null,
    trigger_price: dec("58200.0"),
    quantity: dec("0.820"),
    filled_qty: dec("0.000"),
    status: "Open",
    time_in_force: "GTC",
    reduce_only: true,
    created_at: NOW_MS - min(40.0),
    updated_at: NOW_MS - min(40.0),
  },
  {
    id: "8d1c0d1e-0000-4000-8000-000000000003",
    market_id: marketIdFor("SOL"),
    account_id: "0x5f2c...9a41",
    side: "Buy",
    order_type: "StopMarket",
    // WIRE DRIFT ON PURPOSE: the engine emits `limit_price`, the spec says
    // `price`. The adapter reads `price ?? limit_price`; this row proves it.
    limit_price: null,
    trigger_price: dec("154.20"),
    quantity: dec("60.0"),
    filled_qty: dec("0.0"),
    status: "Open",
    time_in_force: "IOC",
    created_at: NOW_MS - min(12.7),
    updated_at: NOW_MS - min(12.7),
  },
];

/** `GET /fills` → `Fill[]`. Note `side` is LOWERCASE here and `size`, not `quantity`. */
/*
 * The four slice fills of the seeded TWAP run (`SEED_TWAPS` in lib/lifecycle.ts).
 *
 * They are ordinary fills, because that is all the venue ever sees of a TWAP — the
 * schedule is the client's and never reaches the wire. Their `order_id`s are what the
 * run's `sliceIds` point at, so the executed size and average price on the TWAP row are
 * summed from exactly these rows rather than stored as a second, drift-prone number.
 */
const TWAP_SLICE_ORDER_IDS = [
  "b41f0a20-0000-4000-8000-0000000000t1",
  "b41f0a20-0000-4000-8000-0000000000t2",
  "b41f0a20-0000-4000-8000-0000000000t3",
  "b41f0a20-0000-4000-8000-0000000000t4",
] as const;
export const TWAP_SEED_SLICE_IDS: readonly string[] = TWAP_SLICE_ORDER_IDS;

/** The completed run's slices, so History shows a run that actually traded. */
const TWAP_DONE_ORDER_IDS = [
  "b41f0a20-0000-4000-8000-0000000000d1",
  "b41f0a20-0000-4000-8000-0000000000d2",
  "b41f0a20-0000-4000-8000-0000000000d3",
] as const;
export const TWAP_DONE_SLICE_IDS: readonly string[] = TWAP_DONE_ORDER_IDS;

const TWAP_SEED_FILLS: WireFill[] = TWAP_SLICE_ORDER_IDS.map((oid, i) => ({
  id: `ff02c7f3-0000-4000-8000-00000000t${i + 1}`,
  order_id: oid,
  market_id: marketIdFor("SOL"),
  side: "buy" as const,
  // Drifting a few ticks apart, which is the point of slicing in the first place.
  price: dec((162.02 + i * 0.06).toFixed(2)),
  size: dec("2.500"),
  fee: dec("0.08"),
  taker_or_maker: "taker" as const,
  timestamp: NOW_MS - min(9 - i * 2),
  is_liquidation: false,
}));

const TWAP_DONE_FILLS: WireFill[] = TWAP_DONE_ORDER_IDS.map((oid, i) => ({
  id: `ff03c7f3-0000-4000-8000-00000000d${i + 1}`,
  order_id: oid,
  market_id: marketIdFor("ETH"),
  side: "sell" as const,
  price: dec((3529.4 + i * 1.1).toFixed(2)),
  size: dec("1.000"),
  fee: dec("0.71"),
  taker_or_maker: "taker" as const,
  timestamp: NOW_MS - min(74 - i * 3),
  is_liquidation: false,
}));

export const WIRE_FILLS: WireFill[] = [
  {
    id: "cf72c7f3-0000-4000-8000-000000000001",
    order_id: "8d1c0d1e-0000-4000-8000-0000000000a1",
    market_id: marketIdFor("BTC"),
    side: "buy",
    price: dec("64012.5"),
    size: dec("0.050"),
    fee: dec("1.60"),
    taker_or_maker: "taker",
    timestamp: NOW_MS - min(48.5),
    is_liquidation: false,
  },
  {
    id: "cf72c7f3-0000-4000-8000-000000000002",
    order_id: "8d1c0d1e-0000-4000-8000-0000000000a2",
    market_id: marketIdFor("ETH"),
    side: "sell",
    price: dec("3531.2"),
    size: dec("4.20"),
    // Negative = maker rebate (registry maker_rebate_bps is -2 on crypto).
    fee: dec("-2.97"),
    taker_or_maker: "maker",
    timestamp: NOW_MS - min(45.0),
    is_liquidation: false,
  },
  {
    id: "cf72c7f3-0000-4000-8000-000000000003",
    order_id: "8d1c0d1e-0000-4000-8000-0000000000a3",
    market_id: marketIdFor("SOL"),
    side: "buy",
    price: dec("162.05"),
    size: dec("40.0"),
    fee: dec("3.24"),
    taker_or_maker: "taker",
    timestamp: NOW_MS - min(41.9),
    is_liquidation: false,
  },
  {
    id: "cf72c7f3-0000-4000-8000-000000000004",
    order_id: "8d1c0d1e-0000-4000-8000-0000000000a4",
    market_id: marketIdFor("BTC"),
    side: "sell",
    price: dec("64120.0"),
    size: dec("0.120"),
    fee: dec("-1.54"),
    taker_or_maker: "maker",
    timestamp: NOW_MS - min(38.2),
    is_liquidation: false,
  },
  {
    id: "cf72c7f3-0000-4000-8000-000000000005",
    // GOLD, not XAU — the registry's spelling.
    order_id: "8d1c0d1e-0000-4000-8000-0000000000a5",
    market_id: marketIdFor("GOLD"),
    side: "buy",
    price: dec("2411.4"),
    size: dec("3.00"),
    fee: dec("2.89"),
    taker_or_maker: "taker",
    timestamp: NOW_MS - min(33.1),
    is_liquidation: false,
  },
];

/**
 * `GET /funding` → `AccountFunding[]`.
 *
 * This is where per-position funding actually comes from: `Position` carries no
 * funding field on the wire, so a "funding" column in the blotter has to be
 * joined from here by market.
 */
export const WIRE_FUNDING_PAYMENTS: WireAccountFunding[] = [
  {
    market_id: marketIdFor("BTC"),
    amount: dec("-2.06"),
    direction: "received",
    funding_rate: dec("-0.00004"),
    position_size: dec("0.820"),
    timestamp: NOW_MS - min(18),
  },
  {
    market_id: marketIdFor("ETH"),
    amount: dec("0.88"),
    direction: "paid",
    funding_rate: dec("0.00002"),
    position_size: dec("12.40"),
    timestamp: NOW_MS - min(18),
  },
  {
    market_id: marketIdFor("SOL"),
    amount: dec("-1.59"),
    direction: "received",
    funding_rate: dec("-0.00007"),
    position_size: dec("140.0"),
    timestamp: NOW_MS - min(18),
  },
];

/** `GET /account/summary` → `AccountPortfolioSummary`. */
export const WIRE_PORTFOLIO: WireAccountPortfolioSummary = {
  collateral: dec("72072.40"),
  total_equity: dec("84512.40"),
  total_unrealized_pnl: dec("2276.84"),
  total_realized_pnl_24h: dec("369.36"),
  total_volume_24h: dec("1842004.20"),
  open_positions_count: 3,
  open_orders_count: 3,
  margin_used: dec("12440.00"),
  available_margin: dec("41280.00"),
};

// ───────────────────────────────────────────────────── parsed UI model

/**
 * A position as the screens use it: the parsed wire fields plus four MOCK
 * additions the API does not provide.
 */
export type Position = Omit<UiPosition, "liq"> & {
  /**
   * Liquidation price. NON-NULL here, unlike `UiPosition.liq`, because the
   * fixtures supply one — see `liqIsSynthetic`. A component reading a live
   * position must handle null; a component reading these fixtures need not.
   */
  liq: number;
  /** Alias of `sym`. Both spellings kept so old call sites still compile. */
  readonly market_id: string;
  /**
   * MOCK. There is no position leverage on the wire and no way to set one — the
   * engine derives margin from `initial_margin_rate`, and `max_leverage` is that
   * rate's reciprocal. This is an illustrative effective leverage.
   */
  lev: number;
  /** MOCK-JOINED from `GET /funding`: hourly funding rate as a ratio. */
  fundingRate: number;
  /** Alias of `entry`, kept for existing call sites. */
  readonly entryPrice: number;
  /**
   * true when `liq` came from a fixture rather than the venue. The live
   * `/positions` path returns "0" for `liquidation_price`, so a real client shows
   * nothing here.
   */
  readonly liqIsSynthetic: boolean;
  /** The untouched wire payload. */
  readonly wire: WirePosition;
};

/** MOCK effective leverage per market, applied on top of the wire position. */
const MOCK_LEVERAGE: Record<string, number> = {
  [marketIdFor("BTC")]: 10,
  [marketIdFor("ETH")]: 5,
  [marketIdFor("SOL")]: 8,
};

const FUNDING_BY_MARKET = new Map(
  WIRE_FUNDING_PAYMENTS.map((f) => [f.market_id, Number(f.funding_rate)]),
);

export const POSITIONS: Position[] = WIRE_POSITIONS.map((w) => {
  const p = parsePosition(w);
  return {
    ...p,
    // Fixtures always carry a liquidation price; fall back to entry if one is
    // ever "0" (the live path's "not computed" sentinel) so the type stays sound.
    liq: p.liq ?? p.entry,
    market_id: p.sym,
    lev: MOCK_LEVERAGE[p.sym] ?? Math.max(1, Math.round(1 / Number(registryMarket(p.sym)?.initial_margin_rate ?? 0.02))),
    fundingRate: FUNDING_BY_MARKET.get(p.sym) ?? 0,
    entryPrice: p.entry,
    // The fixture supplies a real number, so it is synthetic by definition.
    liqIsSynthetic: p.liq !== null,
    wire: w,
  };
});

/**
 * Unrealized PnL and return on equity for a position at a given mark.
 *
 * The venue also sends `unrealized_pnl` (see `p.unrealizedPnl`); this recomputes
 * against a fresher mark, which is what the blotter needs between polls. Uses
 * `p.dir` rather than a string compare — the adapter already resolved direction.
 */
export function positionPnl(p: Position, mark: number) {
  const pnl = (mark - p.entry) * p.size * p.dir;
  const margin = (p.entry * p.size) / p.lev;
  return { pnl, roe: margin === 0 ? 0 : (pnl / margin) * 100, mark, margin };
}

/**
 * A working order as the blotter renders it.
 *
 * `type` and `filled` are OMITTED from `UiOrder` and redefined, because the
 * blotter's meaning differs from the wire's: its `type` is a composed label
 * ("Limit · post-only", from three separate wire fields) and its `filled` is a
 * PERCENT, not base units. The wire meanings survive as `typeLabel` / `wire.
 * order_type` and `filledQty`.
 */
export type WorkingOrder = Omit<UiOrder, "type" | "filled" | "price"> & {
  /** Display label, e.g. "Limit · post-only". Composed from type + TIF + flags. */
  type: string;
  /**
   * The price to show in a single PRICE column, NON-NULL.
   *
   * `UiOrder.price` is nullable because market-family orders have no limit price
   * — that is the honest wire shape. A one-column blotter still has to print
   * something, so the fallback order is: limit price → trigger price → 0. Check
   * `priceIsTrigger` before labelling it a limit.
   */
  price: number;
  /** true when `price` is really `trigger_price` (a stop / take-profit order). */
  priceIsTrigger: boolean;
  /** The nullable wire-faithful limit price. */
  limitPrice: number | null;
  /** The wire `order_type`, unmodified. */
  orderType: UiOrder["type"];
  /** 0-100. The blotter renders this with a % sign. */
  filled: number;
  /** Filled base units — the wire's `filled_qty`. */
  filledQty: number;
  /** Original quantity. Alias of `quantity`. */
  size: number;
  /** hh:mm:ss since `created_at`. */
  age: string;
  readonly wire: WireOrder;
};

/**
 * Compose the display type string. The API has no such field: it has
 * `order_type` (8 values), `time_in_force` (4, one of which IS post-only) and
 * `reduce_only`. Squashing them into one label is a UI decision, made here.
 */
function orderTypeLabel(o: UiOrder): string {
  const parts = [o.typeLabel];
  if (o.tif === "PostOnly") parts.push("post-only");
  else if (o.tif !== "GTC") parts.push(o.tif);
  if (o.reduceOnly) parts.push("reduce-only");
  return parts.join(" · ");
}

/**
 * The parsed orders, WITHOUT the display collapse below.
 *
 * `WorkingOrder.price` folds `triggerPrice` into `price` because the old blotter had
 * a single PRICE column and no way to show a trigger. Now that there is a TRIGGER
 * column, that fold makes a stop order render its trigger twice — once as a limit
 * price it does not have. Anything showing both columns must seed from here.
 */
export const OPEN_ORDERS_PARSED: UiOrder[] = WIRE_OPEN_ORDERS.map(parseOrder);

export const OPEN_ORDERS: WorkingOrder[] = WIRE_OPEN_ORDERS.map((w) => {
  const o = parseOrder(w);
  return {
    ...o,
    type: orderTypeLabel(o),
    orderType: o.type,
    price: o.price ?? o.triggerPrice ?? 0,
    priceIsTrigger: o.price === null && o.triggerPrice !== null,
    limitPrice: o.price,
    filled: o.filledPct,
    filledQty: o.filled,
    size: o.quantity,
    age: hms(Math.max(0, NOW_MS - o.createdAt)),
    wire: w,
  };
});

export type Fill = UiFill & {
  /** hh:mm:ss of the fill, UTC. */
  time: string;
  readonly wire: WireFill;
};

/*
 * Funding payments on this account, hourly.
 *
 * `funding_interval_s` is 3600 on every market in the registry, so a row per hour per
 * open position is the real shape — not a daily roll-up. Signs follow the venue's
 * convention: a long pays when the rate is positive, and `direction` is carried
 * explicitly because the wire calls it authoritative.
 */
/** Plausible marks for the three legs. MOCK, and local so this file stays leaf-ish. */
const REF_PRICE: Record<string, number> = { BTC: 64020, ETH: 3531, SOL: 162.1 };

export const WIRE_ACCOUNT_FUNDING: WireAccountFunding[] = (() => {
  const rows: WireAccountFunding[] = [];
  const legs = [
    { base: "BTC", size: 0.82, rate: -0.00004 },
    { base: "ETH", size: -12.4, rate: 0.00002 },
    { base: "SOL", size: 240, rate: 0.00006 },
  ];
  for (let h = 1; h <= 6; h++) {
    for (const leg of legs) {
      // Rate wobbles hour to hour; the sign of the payment is size × rate.
      const rate = leg.rate * (1 + 0.18 * Math.sin(h * 1.7 + leg.size));
      // Registry reference price, not `getMarket` — lib/markets imports this file.
      const notional = Math.abs(leg.size) * REF_PRICE[leg.base];
      const amount = -Math.sign(leg.size) * rate * notional;
      rows.push({
        market_id: marketIdFor(leg.base),
        amount: dec(amount.toFixed(4)),
        direction: amount >= 0 ? "received" : "paid",
        funding_rate: dec(rate.toFixed(8)),
        position_size: dec(leg.size.toFixed(4)),
        timestamp: NOW_MS - h * 3_600_000,
      });
    }
  }
  return rows;
})();

export const ACCOUNT_FUNDING: UiAccountFunding[] = WIRE_ACCOUNT_FUNDING.map(parseAccountFunding);

export const FILLS: Fill[] = [...WIRE_FILLS, ...TWAP_SEED_FILLS, ...TWAP_DONE_FILLS].map((w) => {
  const f = parseFill(w);
  return { ...f, time: hms(f.ts), wire: w };
});

// ─────────────────────────────────────────────────────────────── roll-ups

const portfolio = parsePortfolioSummary(WIRE_PORTFOLIO);

/**
 * Aggregate maintenance margin, DERIVED — there is no aggregate maintenance
 * margin field anywhere in the API. Summing `maintenance_margin_rate × notional`
 * per position is the same computation the risk engine does, using the registry's
 * real per-market rates (BTC/ETH 1%, SOL 2.5%, everything else 2%).
 */
const maintMargin = POSITIONS.reduce((a, p) => {
  const rate = Number(registryMarket(p.sym)?.maintenance_margin_rate ?? 0.02);
  return a + p.entry * p.size * rate;
}, 0);

/**
 * Account roll-ups.
 *
 * `equity` / `buyingPower` / `marginUsed` are the parsed portfolio summary.
 * `maintMargin` is derived (above). `fees30d` / `pnl30d` / `pnl30dPct` /
 * `curveSeed` are MOCK — the API exposes only a 24h realized PnL
 * (`total_realized_pnl_24h`) and an equity history at 5s cadence
 * (`GET /account/equity-history`); there is no 30-day window and no fee total.
 */
export const ACCOUNT = {
  equity: portfolio.equity,
  /** `available_margin` — what the venue will let you commit. */
  buyingPower: portfolio.availableMargin,
  marginUsed: portfolio.marginUsed,
  maintMargin,
  unrealizedPnl: portfolio.unrealizedPnl,
  /** Real field, 24h window. */
  realizedPnl24h: portfolio.realizedPnl24h,
  volume24h: portfolio.volume24h,
  /** MOCK: no 30d fee total in the API. */
  fees30d: 184.2,
  /** MOCK: no 30d PnL window in the API. */
  pnl30d: 7204,
  /** MOCK. */
  pnl30dPct: 9.3,
  /** Equity-curve PRNG seed. MOCK — the real curve is /account/equity-history. */
  curveSeed: 88,
};

/**
 * Volume-tiered fee schedule position.
 *
 * MOCK — there is NO fee-schedule endpoint in the API, and `GET /markets` does
 * not carry fees either. The maker/taker figures below are the registry's real
 * BTC-USDX-PERP bps (`maker_rebate_bps: -2`, `taker_fee_bps: 5`) rendered as
 * percentages; the tier, volumes and rebate total are invented.
 */
const btc = registryMarket(marketIdFor("BTC"));
const bpsToPct = (bps: number) => `${bps < 0 ? "-" : ""}${(Math.abs(bps) / 100).toFixed(3)}%`;

export const FEE_TIER = {
  tier: 3,
  volume30d: 41_800_000,
  nextAt: 75_000_000,
  progress: 56,
  /** From the registry: -2 bps on BTC. */
  maker: bpsToPct(btc?.extra.maker_rebate_bps ?? -2),
  /** From the registry: 5 bps on BTC. */
  taker: bpsToPct(btc?.extra.taker_fee_bps ?? 5),
  rebates30d: 96.4,
};

/**
 * API key rows.
 *
 * MOCK. `POST /keys` and `GET /keys` exist on the API but their response bodies
 * are not schematized in openapi.json 0.7.0, so there is no wire type to mirror.
 * Fills / win-rate / PnL / quota per key are not exposed at all — the only real
 * adjacent surface is `GET /account/rate-limit`.
 */
/**
 * An API credential. NOT a strategy.
 *
 * The previous shape carried `pnl`, `win` and a sparkline, which asserted a one-to-one
 * relationship between a key and a trading system that holds in neither direction: two
 * bots can share a key, and one bot can rotate keys weekly. Rotate, and the "agent's"
 * performance history resets — which is nonsense, because the strategy did not change,
 * only the credential did.
 *
 * A credential list answers three questions, and it answers them when something has
 * gone wrong: WHICH key, HAS IT BEEN USED, and KILL IT. The old panel could answer none
 * of them.
 *
 * `quota` is gone too. It rendered a rate-limit bar per key, and this project's own API
 * notes say rate limits are per ACCOUNT (`GET /account/rate-limit` reports headroom) —
 * a specification showing per-key metering tells the team to build something the venue
 * does not have. Headroom moved to the panel header, where it is true.
 */
export type ApiKey = {
  /** The public prefix. The secret is shown once, at creation, and never stored. */
  id: string;
  label: string;
  /**
   * What the key may do — and the point of the whole feature is what is ABSENT.
   *
   * A credential must be strictly less powerful than the account that issued it. That
   * invariant is what makes it safe to put on a machine you do not physically control,
   * and it is the single most important thing this panel communicates. Hyperliquid's
   * API wallets make the same promise from the other direction: they can sign trades and
   * cannot withdraw.
   *
   * `withdraw` is deliberately not in the union. It is not a scope you can grant.
   */
  scopes: ("trade" | "read")[];
  createdAt: number;
  /** Null means it never expires — which the UI marks, because that is a risk. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  /** Coarse origin. Enough to notice "that is not me" without pretending to be forensics. */
  lastUsedFrom: string | null;
  /** Usage, not performance: is this key busy? */
  fills: string;
  status: "active" | "expired" | "revoked";
};

const DAY = 86_400_000;

export const API_KEYS: ApiKey[] = [
  {
    id: "nx_live_8fd2",
    label: "mm-quoter-01",
    scopes: ["trade", "read"],
    createdAt: NOW_MS - 214 * DAY,
    expiresAt: NOW_MS + 151 * DAY,
    lastUsedAt: NOW_MS - 4_000,
    lastUsedFrom: "eu-west-1",
    fills: "41.2k",
    status: "active",
  },
  {
    id: "nx_live_a73c",
    label: "basis-hedge",
    scopes: ["trade", "read"],
    createdAt: NOW_MS - 61 * DAY,
    expiresAt: NOW_MS + 304 * DAY,
    lastUsedAt: NOW_MS - 96_000,
    lastUsedFrom: "us-east-1",
    fills: "8.9k",
    status: "active",
  },
  {
    /* Read-only, and never expires. Both are worth showing: the first because scopes
       are per key and a reader should see that they differ, the second because a
       credential with no expiry is the one that outlives the person who made it. */
    id: "nx_live_c019",
    label: "risk-dashboard",
    scopes: ["read"],
    createdAt: NOW_MS - 402 * DAY,
    expiresAt: null,
    lastUsedAt: NOW_MS - 31 * DAY,
    lastUsedFrom: "ap-southeast-1",
    fills: "0",
    status: "active",
  },
  {
    /* An expired key, left in the list rather than hidden. A credential that vanishes
       when it lapses cannot be audited, and "when did that stop working" is a question
       people ask. */
    id: "nx_live_44b1",
    label: "vol-scalper (old)",
    scopes: ["trade", "read"],
    createdAt: NOW_MS - 500 * DAY,
    expiresAt: NOW_MS - 12 * DAY,
    lastUsedAt: NOW_MS - 12 * DAY,
    lastUsedFrom: "eu-west-1",
    fills: "22.7k",
    status: "expired",
  },
];

/**
 * A subaccount: an isolated margin bucket under one login.
 *
 * The reason to have them is risk containment — a strategy that blows up should take
 * its own bucket and not the account. Hyperliquid's model, and the one worth
 * specifying: each has its own equity, its own positions and its own margin, and you
 * move funds between them explicitly.
 *
 * Which is why `equity` here is not a slice of a single pot. Each row is a separate
 * margin account, and the master's equity is its own — the table totals to the login's
 * whole balance, but liquidation is computed per row.
 */
export type SubAccount = {
  id: string;
  name: string;
  /** The master cannot be renamed, transferred out of existence, or closed. */
  isMaster?: boolean;
  equity: number;
  /** Maintenance margin currently held against open positions. */
  marginUsed: number;
  positions: number;
  upnl: number;
};

export const SUBACCOUNTS: SubAccount[] = [
  { id: "nx_acct_master", name: "Master", isMaster: true, equity: 62_180.4, marginUsed: 1_112.6, positions: 2, upnl: 1_842 },
  { id: "nx_sub_7c14", name: "market-making", equity: 18_400.0, marginUsed: 402.1, positions: 1, upnl: 435 },
  { id: "nx_sub_2ba9", name: "basis", equity: 3_932.0, marginUsed: 23.5, positions: 0, upnl: 0 },
];

/** Margin ratio → a 0-100 health score, and its band. */
export function accountHealth(equity: number, maintMarginUsd: number) {
  const score = Math.round(Math.max(0, Math.min(100, 100 - (maintMarginUsd / equity) * 100 * 12.5)));
  const band = score >= 70 ? "healthy" : score >= 40 ? "caution" : "at risk";
  return { score, band };
}
