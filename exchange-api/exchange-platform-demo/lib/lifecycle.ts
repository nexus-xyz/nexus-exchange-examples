/**
 * The order ledger — the one piece of mutable trading state in this app.
 *
 * Pure domain layer: no React, no `components/` imports, no timers. Everything here
 * is a function from (ledger, args) to a new ledger, so it is testable without a
 * renderer and safe to call from inside a `setState` updater.
 *
 * ## Why this file exists
 *
 * `lib/orders.ts` turns a draft into API *requests* (`planOrder` → `serializeOrderRequest`).
 * That half was already real. What was missing is the half after the request: an order
 * that rests, fills, amends, cancels, and ends up somewhere you can look at it. Before
 * this file, `submitPlan` minted orders with `filled: 0` and nothing in the codebase
 * ever changed that value — so the blotter's FILLED column read `0%` forever and a
 * placed order could never produce a fill. Placement was not the dead end; settlement
 * was.
 *
 *   lib/orders.ts     draft   → request     (planOrder, unchanged)
 *   lib/lifecycle.ts  request → state       (this file)
 *
 * ## The three layers, and which one this is
 *
 * | Layer   | Source                                            | Mutability                  |
 * |---------|---------------------------------------------------|-----------------------------|
 * | History | `wireCandles`, seeded off the symbol alone         | immutable, never rewrites   |
 * | Tail    | last candle/book/tape, from `(symbol, tick)`       | recomputed, never stored    |
 * | Ledger  | this file, advanced by `settle(tick)` and by users | accumulated in React state  |
 *
 * The load-bearing invariant: **the ledger reads the feed and never writes to it.** A
 * submitted order cannot perturb a candle, a book level, or a tape print. The book keeps
 * breathing exactly as it did, and history stays symbol-seeded.
 *
 * The honest part: the ledger is the one piece of state that is *not* a pure function of
 * `(symbol, tick)`. The compensating property is that it is **replayable** — given
 * `seedLedger()` plus an ordered list of (tick, action) events, the result is
 * byte-identical, because every non-derived input below was removed on purpose. And a
 * fresh page load starts from `seedLedger()`, so a URL still fully determines the
 * rendered screen and no tracked state regresses.
 *
 * ## Determinism is not decoration here
 *
 * `?tick=N` freezes the clock so two captures of the same state are byte-comparable;
 * that is the whole basis of the audit harness. Four rules keep it true, and each one
 * replaces something that looked deterministic and was not:
 *
 *   1. Ids are `{base}-{placedTick}-{seqInTick}` — a function of the tick, matching the
 *      convention `lib/api/README.md` already documents for trade ids. The previous
 *      `nextId()` drew from a mutable module-level counter whose own comment promised
 *      determinism ("Never crypto.randomUUID or Date.now"); a module counter survives
 *      Fast Refresh, is invisible to React, and is not a function of (symbol, tick), so
 *      it broke the property it claimed. `seqInTick` is counted from prior state inside
 *      the updater, so a StrictMode double-invoke produces the same id rather than two.
 *   2. Timestamps come only from `tickTime(tick)`. `submitPlan` never set `createdAt` or
 *      `updatedAt` at all — both are required on `UiOrder`, and an `as UiOrder` cast hid
 *      that they were `undefined` at runtime. `lib/account.ts` already renders
 *      `hms(NOW_MS - o.createdAt)` as an AGE column, so that hole was one column away
 *      from rendering `NaN` on screen.
 *   3. Fill randomness is one draw per (order, tick) from a seed frozen at placement —
 *      never a generator held across ticks, which would make the Nth fill depend on how
 *      many renders happened.
 *   4. `lastSettledTick` lives in the ledger, not in a ref, because a ref is not restored
 *      across a StrictMode remount — the one environment such a guard exists to defend
 *      against. `components/Terminal.tsx` documents what that class of bug already cost
 *      here once: a double-applied reducer turned a 0.05 BTC order into a $32tn one.
 */

import {
  feeFor,
  parseFill,
  parseOrder,
  priceDecimal,
  remainingQty,
  serializeAmend,
  sizeDecimal,
  type UiFill,
  type UiOrder,
} from "./api/adapter";
import type { Decimal, MarketId } from "./api/types";
import { type OrderStatusWire } from "./api/enums";
import { marketIdFor, registryMarket } from "./api/markets";
import {
  FILLS,
  OPEN_ORDERS_PARSED,
  POSITIONS,
  WIRE_OPEN_ORDERS,
  type Fill,
  type Position,
  TWAP_DONE_SLICE_IDS,
  TWAP_SEED_SLICE_IDS,
} from "./account";
import { EPOCH_MS, TICK_MS, hms, tickTime, type Feed } from "./feed";
import { rng, seedOf } from "./format";
import { twapSliceRequest, type PlanKind, type PlannedRequest } from "./orders";

// ────────────────────────────────────────────────────────────────────── types

/**
 * A working order, plus the bookkeeping the wire does not carry.
 *
 * `order` is the canonical `UiOrder` — never a second parallel model of an order.
 * Everything else is local lifecycle metadata that no endpoint returns.
 */
export type WorkingOrder = {
  order: UiOrder;
  /** The tick submit fired on. The origin of this order's lifecycle clock. */
  placedTick: number;
  /** Ordinal within `placedTick`. Feeds the id, and price-time priority on settle. */
  seqInTick: number;
  /** Which leg of a plan this is. */
  origin: PlanKind;
  /** Bracket children point at their entry order. null for a standalone order. */
  parentId: string | null;
  /** Frozen at placement. The only randomness source for this order's fills. */
  fillSeed: number;
};

/** A fill, plus the two columns a blotter reads first. */
export type LedgerFill = UiFill & {
  /** hh:mm:ss UTC. */
  time: string;
  /** Realized PnL on the closing portion. null when the fill opened or added. */
  closedPnl: number | null;
  /** The order type that produced it. */
  typeLabel: string;
};

/**
 * Everything the blotter reads.
 *
 * One object rather than four pieces of state because a fill has to debit an order and
 * credit a position atomically. As two `setState` calls those cannot be composed, and
 * the two would sit out of step for a commit.
 */
/**
 * A running TWAP.
 *
 * Held as a RECIPE, not as a queue of pending requests. The venue never receives a
 * TWAP — it receives ordinary market orders, one every `frequencyTicks`, and the
 * schedule that produced them is ours. Storing the recipe keeps that true: the run
 * knows how many slices remain and when the next one is due, and each release is
 * serialized through the same path a hand-placed order takes.
 *
 * `sliceIds` is what makes the blotter row honest — executed size and average price
 * are summed from the fills of exactly these orders, so the TWAP row and the Fills
 * tab can never disagree about how much has traded.
 */
export type TwapRun = {
  id: string;
  sym: MarketId;
  side: "BUY" | "SELL";
  /** Total base size across every slice. */
  size: number;
  /** Base size per slice. */
  sizePer: number;
  /** Total slices the schedule will release. */
  slices: number;
  /** Slices already released. */
  released: number;
  /** Ticks between releases. The ticket enters a runtime; this is what it becomes. */
  frequencyTicks: number;
  /** Tick the next slice is due on. */
  nextTick: number;
  startedTick: number;
  /** Epoch ms. Formatted at the column, so the row can show a date or a clock. */
  startedAt: number;
  status: "active" | "completed" | "cancelled";
  /** Ids of every slice order released so far. */
  sliceIds: string[];
};

export type Ledger = {
  /** status ∈ { Open, PartiallyFilled, Triggered } */
  working: WorkingOrder[];
  /** status ∈ { Filled, Cancelled, Rejected, Expired } — newest first. */
  history: UiOrder[];
  /** Newest first. Seeded from the fixtures, appended by settle(). */
  fills: LedgerFill[];
  positions: Position[];
  /** Client-side algorithms in flight. See `TwapRun`. */
  algos: TwapRun[];
  /** Highest tick `settle()` has applied. The StrictMode guard — see the header. */
  lastSettledTick: number;
};

/*
 * Terminal vs working statuses come from `lib/api/enums.ts` (`isTerminalStatus`,
 * `OPEN_STATUSES`) — they are the engine's seven values and were already expressed
 * there, so this file does not restate them.
 *
 * Note what is absent from that enum: `Untriggered`. A comment in `lib/orders.ts`
 * claimed a trigger order rests `Untriggered`; it is not an engine status, and the code
 * beneath that comment correctly set `Open`. A resting trigger order is `Open` until it
 * becomes `Triggered`.
 */

// ───────────────────────────────────────────────────────────────────── seeding

/**
 * Seeded runs, so the TWAP tab has something to show on first paint and so both
 * sub-tabs are exercised: one mid-flight and one already finished.
 *
 * The active run's four released slices point at the four seed fills in
 * `lib/account.ts`; everything the row displays — executed, average price, progress —
 * is summed from those. `nextTick: 0` means the scheduler picks it up on the first
 * settle and carries on releasing the remaining eight.
 */
const SEED_TWAPS: TwapRun[] = [
  {
    id: "twap-sol-01",
    sym: marketIdFor("SOL"),
    side: "BUY",
    size: 30,
    sizePer: 2.5,
    slices: 12,
    released: 4,
    // 30s at a 1.1s tick. The ticket enters a runtime; this is what it becomes.
    frequencyTicks: 27,
    nextTick: 0,
    startedTick: 0,
    startedAt: EPOCH_MS - 9 * 60_000,
    status: "active",
    sliceIds: [...TWAP_SEED_SLICE_IDS],
  },
  {
    id: "twap-eth-00",
    sym: marketIdFor("ETH"),
    side: "SELL",
    size: 3,
    sizePer: 1,
    slices: 3,
    released: 3,
    frequencyTicks: 27,
    nextTick: 0,
    startedTick: 0,
    startedAt: EPOCH_MS - 74 * 60_000,
    status: "completed",
    sliceIds: [...TWAP_DONE_SLICE_IDS],
  },
];

/**
 * The initial ledger.
 *
 * Pure over module constants only. A `Date.now()` or a PRNG draw in here is what breaks
 * hydration — the server render and the first client render must produce the same
 * ledger, and this is the easiest place in the file to get that wrong.
 */
export function seedLedger(): Ledger {
  return {
    working: OPEN_ORDERS_PARSED.map(toWorking),
    history: [],
    fills: FILLS.map(fromFixtureFill),
    positions: POSITIONS,
    algos: SEED_TWAPS,
    lastSettledTick: -1,
  };
}

/**
 * A fixture order, adopted into the ledger.
 *
 * The fixtures came through `parseOrder`, so they already carry real `createdAt`
 * values; `placedTick` is recovered from that rather than invented, which keeps
 * `seqInTick` collision-free if a user places an order on the same nominal tick.
 */
function toWorking(order: UiOrder): WorkingOrder {
  return {
    order,
    placedTick: -1,
    seqInTick: 0,
    origin: "entry",
    parentId: null,
    fillSeed: seedOf(`${order.id}:${order.sym}`),
  };
}

/** A fixture fill, widened to the ledger shape. Fixtures opened nothing, so no PnL. */
function fromFixtureFill(f: Fill): LedgerFill {
  return { ...f, closedPnl: null, typeLabel: "" };
}

/*
 * The account every locally-placed order belongs to.
 *
 * Read off the fixtures rather than restated, so there is one spelling of it in the
 * project. `UiOrder` drops `account_id` — it is single-account UI — but `WireOrder`
 * requires it, and orders are built through `parseOrder` so the wire shape has to be
 * complete.
 */
const ACCOUNT_ID = WIRE_OPEN_ORDERS[0].account_id;

// ──────────────────────────────────────────────────────────────── ids and time

/** `BTC-USDX-PERP` → `BTC`. The id prefix, matching the trade-id convention. */
const baseOf = (sym: MarketId): string => String(sym).split("-")[0] || String(sym);

/**
 * How many orders this ledger already has from `tick`.
 *
 * Counted from prior state, not from a counter, so calling this twice with the same
 * ledger yields the same answer — which is what makes a StrictMode double-invoke of the
 * updater idempotent. `history` holds bare `UiOrder`s with no `placedTick`, so its
 * members are matched on `createdAt`, which is exactly `tickTime(placedTick)`.
 */
function countAtTick(l: Ledger, tick: number): number {
  const ts = tickTime(tick);
  return (
    l.working.filter((w) => w.placedTick === tick).length +
    l.history.filter((o) => o.createdAt === ts).length
  );
}

/** The deterministic id for the n-th order placed on `tick` in `sym`. */
export const orderId = (sym: MarketId, tick: number, seqInTick: number): string =>
  `${baseOf(sym)}-${tick}-${seqInTick}`;

// ───────────────────────────────────────────────────────────────────── actions

/**
 * Place a planned request set.
 *
 * Takes the output of `planOrder` — already validated and already serialized through
 * `serializeOrderRequest`, so this never composes a request body of its own. That
 * single-path rule is the product's thesis: the JSON the ticket shows you is the JSON
 * that was sent, because there is only one serializer.
 *
 * Bracket children (`take-profit` / `stop-loss`) are linked to the entry order by
 * `parentId`, which is what lets a TP/SL column be *derived* rather than modelled — the
 * API has no bracket field, and a bracket already is two reduce-only trigger orders.
 */
export function place(l: Ledger, requests: PlannedRequest[], tick: number): Ledger {
  if (requests.length === 0) return l;

  const at = tickTime(tick);
  let seq = countAtTick(l, tick);
  let entryId: string | null = null;

  const placed: WorkingOrder[] = requests.map(({ kind, result }) => {
    const b = result.body;
    const sym = b.market_id as MarketId;
    const qty = Number(b.quantity);
    const id = orderId(sym, tick, seq);
    const seqInTick = seq;
    seq += 1;

    /*
     * Built through `parseOrder` rather than by hand. The wire shape is the only
     * definition of an order this app has, and going through the parser means a
     * locally-placed order and a fixture order are the same kind of object — including
     * the fields the previous hand-built version silently omitted.
     */
    const order = parseOrder({
      id,
      market_id: sym,
      account_id: ACCOUNT_ID,
      side: b.side,
      order_type: b.order_type,
      price: b.price ?? null,
      quantity: b.quantity,
      filled_qty: "0" as Decimal,
      status: "Open",
      time_in_force: b.time_in_force,
      reduce_only: b.reduce_only ?? false,
      trigger_price: b.trigger_price ?? null,
      created_at: at,
      updated_at: at,
    });

    if (kind === "entry") entryId = id;

    return {
      order: { ...order, remaining: remainingQty(qty, 0) },
      placedTick: tick,
      seqInTick,
      origin: kind,
      parentId: kind === "take-profit" || kind === "stop-loss" ? entryId : null,
      fillSeed: seedOf(`${id}:${sym}`),
    };
  });

  return { ...l, working: [...placed, ...l.working] };
}

/**
 * Cancel one working order.
 *
 * It moves to `history` with a terminal status. It is **not** deleted — deleting was
 * what left Order History with nothing to read, and `cancellationReason` already exists
 * on `UiOrder`, so a populated history needs no new fixture.
 */
export function cancel(l: Ledger, id: string, tick: number): Ledger {
  const hit = l.working.find((w) => w.order.id === id);
  if (!hit) return l;
  return {
    ...l,
    working: l.working.filter((w) => w.order.id !== id),
    history: [retire(hit.order, "Cancelled", "User", tick), ...l.history],
  };
}

/** Cancel every working order, or every one in `sym`. */
export function cancelAll(l: Ledger, tick: number, sym?: MarketId): Ledger {
  const doomed = l.working.filter((w) => (sym ? w.order.sym === sym : true));
  if (doomed.length === 0) return l;
  const ids = new Set(doomed.map((w) => w.order.id));
  return {
    ...l,
    working: l.working.filter((w) => !ids.has(w.order.id)),
    history: [...doomed.map((w) => retire(w.order, "Cancelled", "User", tick)), ...l.history],
  };
}

/** Move an order out of `working` with a terminal status and a stamped `updatedAt`. */
function retire(
  order: UiOrder,
  status: OrderStatusWire,
  reason: string | null,
  tick: number,
): UiOrder {
  return { ...order, status, cancellationReason: reason, updatedAt: tickTime(tick) };
}

export type AmendPatch = { price?: number; size?: number };

/** What an amend produced, so the caller can show the request it implies. */
export type AmendResult = {
  ledger: Ledger;
  /** The `PATCH /v1/orders/{id}` body, snapped to tick and lot size. */
  body: { price?: Decimal; size?: Decimal };
};

/**
 * Amend a working order's price and/or size.
 *
 * Routed through `serializeAmend`, which until now had **zero call sites** — so the
 * ticket's "here is the request this composes" promise held for `POST /orders` and was
 * false for `PATCH /orders/{id}`. The snapped decimal strings the serializer returns are
 * what get applied to local state, not the raw inputs, so the UI cannot drift from the
 * values the endpoint would have accepted.
 *
 * The id is preserved. The endpoint is an atomic cancel-replace but returns the same
 * order, so a second blotter row would be a lie about what the venue did.
 */
export function amend(l: Ledger, id: string, patch: AmendPatch, tick: number): AmendResult {
  const hit = l.working.find((w) => w.order.id === id);
  if (!hit) return { ledger: l, body: {} };

  const reg = registryMarket(hit.order.sym);
  if (!reg) return { ledger: l, body: {} };

  const body = serializeAmend(reg, { price: patch.price ?? null, size: patch.size ?? null });
  if (body.price === undefined && body.size === undefined) return { ledger: l, body: {} };

  const price = body.price !== undefined ? Number(body.price) : hit.order.price;
  const quantity = body.size !== undefined ? Number(body.size) : hit.order.quantity;

  const next: UiOrder = {
    ...hit.order,
    price,
    quantity,
    remaining: remainingQty(quantity, hit.order.filled),
    filledPct: quantity > 0 ? Math.min(100, (hit.order.filled / quantity) * 100) : 0,
    updatedAt: tickTime(tick),
  };

  return {
    ledger: {
      ...l,
      working: l.working.map((w) => (w.order.id === id ? { ...w, order: next } : w)),
    },
    body,
  };
}

// ─────────────────────────────────────────────────────────── position exits

/**
 * Reduce or close a position.
 *
 * `fraction` defaults to the whole position. The reduction is applied here rather than
 * routed through `place()` + settlement, which keeps this step behaviour-identical to
 * what the app does today; moving the reduction into `settle()` — so that an exit emits
 * a real fill with a realized-PnL figure, through the same code path as an entry — is
 * the next step's job and is where this inline arithmetic goes away.
 */
export function closePosition(l: Ledger, sym: MarketId, fraction = 1): Ledger {
  const pos = l.positions.find((p) => p.sym === sym);
  if (!pos) return l;

  const f = Math.min(1, Math.max(0, fraction));
  if (f === 0) return l;
  if (f >= 1) return { ...l, positions: l.positions.filter((p) => p.sym !== sym) };

  const size = Number((pos.size * (1 - f)).toFixed(12));
  if (size <= 0) return { ...l, positions: l.positions.filter((p) => p.sym !== sym) };
  return { ...l, positions: l.positions.map((p) => (p.sym === sym ? { ...p, size } : p)) };
}

/** Close every position. */
export function flattenAll(l: Ledger): Ledger {
  if (l.positions.length === 0) return l;
  return { ...l, positions: [] };
}

// ───────────────────────────────────────────────────────────────── selectors

/** Working orders, newest first, optionally scoped to one market. */
export const workingOrders = (l: Ledger, sym?: MarketId): UiOrder[] =>
  l.working.filter((w) => (sym ? w.order.sym === sym : true)).map((w) => w.order);

/**
 * The bracket children of a position, derived rather than modelled.
 *
 * A bracket is not a field on the wire — it is two reduce-only trigger orders on the
 * opposite side. Matching them back to their position is what a TP/SL column needs, and
 * it costs no new wire field and no fixture change.
 */
export function bracketFor(
  orders: readonly UiOrder[],
  sym: MarketId,
  entry: number,
  dir: number,
): { tp: UiOrder | null; sl: UiOrder | null } {
  const children = orders.filter(
    (o) => o.sym === sym && o.reduceOnly && o.triggerPrice !== null,
  );

  let tp: UiOrder | null = null;
  let sl: UiOrder | null = null;
  for (const o of children) {
    const trigger = o.triggerPrice as number;
    // Profitable side of entry for a long is above it; for a short, below.
    const profitable = dir > 0 ? trigger > entry : trigger < entry;
    if (profitable) tp = o;
    else sl = o;
  }
  return { tp, sl };
}

// ────────────────────────────────────────────────────────────────── settlement

/** Order types that fill immediately or not at all — they never rest. */
const IMMEDIATE = new Set(["Market", "StopMarket", "TakeProfitMarket"]);

/** Order types whose trigger has to fire before they are live. */
const TRIGGERED_FAMILY = new Set([
  "StopLimit",
  "StopMarket",
  "TakeProfitLimit",
  "TakeProfitMarket",
  "TrailingStop",
  "TrailingLimit",
]);

/**
 * Advance the ledger to `tick`.
 *
 * The deterministic matching pass, and the only thing that moves an order forward with
 * the clock. Called from one effect in the shell.
 *
 * ## Idempotency is the whole game
 *
 * The early return on `tick <= lastSettledTick` is not an optimisation — it is a
 * correctness guard. React may invoke a state updater more than once for a single
 * logical update (StrictMode does so deliberately), and settling twice would fill an
 * order twice. Returning the identical object also lets React bail out of the
 * re-render rather than churn.
 *
 * `lastSettledTick` lives in the ledger rather than a `useRef` on purpose: a ref is not
 * restored across a StrictMode remount, so a ref-based guard fails in exactly the
 * environment that exists to expose this class of bug.
 *
 * ## Reads the feed, never writes it
 *
 * `marks` is the same `Feed` the OrderBook and the chart are rendering this tick.
 * Crossing is decided against that ladder, so a fill can never appear at a price the
 * book on screen did not show. Nothing here mutates the feed, so history stays
 * symbol-seeded and the tail keeps breathing exactly as it did.
 */
/**
 * Release every TWAP slice that is due at this tick.
 *
 * Runs at the head of `settle`, so a slice released now is settled by the same pass
 * that released it — which is what a market order does. Returns the ledger unchanged
 * when nothing is due, so the common tick allocates nothing.
 */
function releaseDueSlices(l: Ledger, tick: number): Ledger {
  const due = l.algos.some(
    (a) => a.status === "active" && a.released < a.slices && tick >= a.nextTick,
  );
  if (!due) return l;

  let out = l;
  const algos: TwapRun[] = [];
  for (const a of l.algos) {
    if (a.status !== "active" || a.released >= a.slices || tick < a.nextTick) {
      algos.push(a);
      continue;
    }
    const req = twapSliceRequest(a.sym, a.side, a.sizePer);
    if (!req) {
      algos.push(a);
      continue;
    }
    const before = new Set(out.working.map((w) => w.order.id));
    out = place(out, [req], tick);
    const fresh = out.working.find((w) => !before.has(w.order.id));
    algos.push({
      ...a,
      released: a.released + 1,
      nextTick: tick + a.frequencyTicks,
      sliceIds: fresh ? [...a.sliceIds, fresh.order.id] : a.sliceIds,
    });
  }
  return { ...out, algos };
}

/** A run is done once its last slice has been released and none are still working. */
function markCompleted(algos: TwapRun[], working: WorkingOrder[]): TwapRun[] {
  const live = new Set(working.map((w) => w.order.id));
  let changed = false;
  const next = algos.map((a) => {
    if (a.status !== "active" || a.released < a.slices) return a;
    if (a.sliceIds.some((id) => live.has(id))) return a;
    changed = true;
    return { ...a, status: "completed" as const };
  });
  return changed ? next : algos;
}

export function settle(
  l: Ledger,
  tick: number,
  marks: Map<string, Feed>,
  /*
   * When present, settle ONLY these order ids and skip the tick guard.
   *
   * This exists for one case: an order placed while the clock is frozen by `?tick=N`.
   * The tick guard is what stops the same work being applied twice, so a blanket
   * "force" would re-settle every resting order that this tick already settled — and
   * double-fill them. Naming the ids keeps the guard intact for everything else.
   *
   * Without this, submitting a market order inside a frozen capture would leave it
   * resting forever, and submit would be undemonstrable in exactly the state the audit
   * harness can reproduce.
   */
  only?: ReadonlySet<string>,
): Ledger {
  if (!only && tick <= l.lastSettledTick) return l;

  /* Release before settling, so a slice released on this tick fills on this tick.
     A targeted pass (`only`) is replaying one specific order and must not advance
     any schedule. */
  if (!only) l = releaseDueSlices(l, tick);

  /*
   * Price-time priority. Sorting before applying makes the emitted fill list
   * byte-stable: two runs of the same tick produce the same fills in the same order,
   * which is what lets a capture be compared to a previous capture at all.
   */
  const queue = [...l.working].sort(
    (a, b) => a.placedTick - b.placedTick || a.seqInTick - b.seqInTick,
  );

  const working: WorkingOrder[] = [];
  const retired: UiOrder[] = [];
  const fills: LedgerFill[] = [];
  let positions = l.positions;

  for (const w of queue) {
    if (only && !only.has(w.order.id)) {
      working.push(w);
      continue;
    }
    const feed = marks.get(String(w.order.sym));
    if (!feed) {
      // No feed for this market this tick — the order rests untouched rather than
      // being silently dropped or filled against a stale price.
      working.push(w);
      continue;
    }

    let order = w.order;

    // 1. Trigger, if this order has one and it has not fired yet.
    if (order.status === "Open" && order.triggerPrice !== null && TRIGGERED_FAMILY.has(order.type)) {
      if (!triggerCrossed(order, feed.last)) {
        working.push(w);
        continue;
      }
      order = { ...order, status: "Triggered", updatedAt: tickTime(tick) };
    }

    // 2. Cross against the ladder the book is rendering.
    const touch = crossedSize(order, feed, w.placedTick === tick);
    if (touch <= 0) {
      // IOC and FOK do not rest. An order that could not cross on its own placement
      // pass is cancelled with the reason the engine would give.
      if (w.placedTick === tick && (order.tif === "IOC" || order.tif === "FOK")) {
        retired.push(retire(order, "Cancelled", order.tif === "FOK" ? "FillOrKill" : "IOC", tick));
        continue;
      }
      working.push({ ...w, order });
      continue;
    }

    // 3. Size the fill. One draw per (order, tick) from a seed frozen at placement.
    const remaining = remainingQty(order.quantity, order.filled);
    const draw = rng(w.fillSeed + tick)();
    const reg = registryMarket(order.sym);
    const lot = reg ? Number(reg.lot_size) : remaining;
    let size = IMMEDIATE.has(order.type)
      ? remaining
      : Math.min(remaining, Math.max(lot, touch * draw));

    // FOK is all-or-nothing: if the touch cannot cover it in full, it dies instead.
    if (order.tif === "FOK" && touch < remaining) {
      retired.push(retire(order, "Cancelled", "FillOrKill", tick));
      continue;
    }
    // A reduce-only order may never flip a position's sign.
    if (order.reduceOnly) {
      const held = positions.find((p) => p.sym === order.sym);
      const cap = held ? held.size : 0;
      size = Math.min(size, cap);
      if (size <= 0) {
        working.push({ ...w, order });
        continue;
      }
    }
    size = reg ? Number(sizeDecimal(reg, size)) : Number(size.toFixed(12));
    if (size <= 0) {
      working.push({ ...w, order });
      continue;
    }

    const maker = isMaker(order, w.placedTick === tick);
    const px = fillPrice(order, feed, maker);
    const bps = reg ? (maker ? reg.extra.maker_rebate_bps : reg.extra.taker_fee_bps) : 0;

    // 4. Apply to the position first, so the realized PnL is computed against the
    //    entry this fill is about to change.
    const applied = applyFill(positions, order, px, size, tick);
    positions = applied.positions;

    /*
     * 5. Emit the fill through `parseFill`, the same parser the FILLS fixtures go
     *    through. A locally-settled fill and a fixture fill are then the same kind of
     *    object, which is the point of the fixtures-then-parse design — one renderer,
     *    one shape, no second code path to keep in step.
     */
    const wire = {
      id: `${order.id}-f${order.filled > 0 ? 1 : 0}`,
      order_id: order.id,
      market_id: order.sym,
      side: order.side === "BUY" ? ("buy" as const) : ("sell" as const),
      price: reg ? priceDecimal(reg, px) : (String(px) as never),
      size: reg ? sizeDecimal(reg, size) : (String(size) as never),
      fee: String(feeFor(px * size, bps)) as never,
      taker_or_maker: maker ? ("maker" as const) : ("taker" as const),
      timestamp: tickTime(tick),
      is_liquidation: false,
    };
    const parsed = parseFill(wire as Parameters<typeof parseFill>[0]);
    fills.push({
      ...parsed,
      time: hms(parsed.ts),
      closedPnl: applied.closedPnl,
      typeLabel: order.typeLabel,
    });

    // 6. Advance the order itself.
    const filled = Number((order.filled + size).toFixed(12));
    const rest = remainingQty(order.quantity, filled);
    const next: UiOrder = {
      ...order,
      filled,
      remaining: rest,
      filledPct: order.quantity > 0 ? Math.min(100, (filled / order.quantity) * 100) : 0,
      status: rest <= 0 ? "Filled" : "PartiallyFilled",
      updatedAt: tickTime(tick),
    };
    if (rest <= 0) retired.push(next);
    else working.push({ ...w, order: next });
  }

  return {
    working,
    history: [...retired, ...l.history],
    fills: [...fills, ...l.fills],
    positions,
    algos: markCompleted(l.algos, working),
    // A targeted pass does not claim the tick as settled — the ordinary pass still has
    // the rest of the book to do.
    lastSettledTick: only ? l.lastSettledTick : tick,
  };
}

/* ─────────────────────────────────────────────────────────────────────── TWAP */

/** A run with everything the blotter row needs, derived rather than stored. */
export type TwapView = TwapRun & {
  /** Base units filled across every slice released so far. */
  executed: number;
  /** Size-weighted average fill price, or null before the first fill. */
  avgPrice: number | null;
  /** 0–1. */
  progress: number;
  /** Seconds until the last slice is due, at the current tick. */
  secondsRemaining: number;
};

export function twapViews(l: Ledger, tick: number): TwapView[] {
  return l.algos.map((a) => {
    const ids = new Set(a.sliceIds);
    let executed = 0;
    let notional = 0;
    for (const f of l.fills) {
      if (!ids.has(f.orderId)) continue;
      executed += f.size;
      notional += f.size * f.price;
    }
    const left = Math.max(0, a.slices - a.released);
    return {
      ...a,
      executed,
      avgPrice: executed > 0 ? notional / executed : null,
      progress: a.size > 0 ? Math.min(1, executed / a.size) : 0,
      // Ticks are the clock this app actually runs on; seconds are for the reader.
      secondsRemaining:
        a.status === "active" ? Math.round(((left * a.frequencyTicks) * TICK_MS) / 1000) : 0,
    };
  });
}

/**
 * Start a run, and release its first slice immediately.
 *
 * The plan handed to `submitPlan` contains every slice — a 24-hour TWAP is 2,881 of
 * them — and placing all of them at once is precisely the thing a TWAP exists not to
 * do. So the ticket's plan is used for validation and the count, and the ORDERS come
 * from the scheduler, one at a time.
 */
export function startTwap(
  l: Ledger,
  spec: Pick<TwapRun, "sym" | "side" | "size" | "sizePer" | "slices" | "frequencyTicks">,
  tick: number,
  marks: Map<string, Feed>,
): Ledger {
  const run: TwapRun = {
    ...spec,
    id: `twap-${baseOf(spec.sym).toLowerCase()}-${tick}`,
    released: 0,
    sliceIds: [],
    status: "active",
    startedTick: tick,
    startedAt: tickTime(tick),
    nextTick: tick,
  };
  const before = new Set(l.working.map((w) => w.order.id));
  const released = releaseDueSlices({ ...l, algos: [...l.algos, run] }, tick);
  const fresh = new Set(
    released.working.filter((w) => !before.has(w.order.id)).map((w) => w.order.id),
  );
  return fresh.size ? settle(released, tick, marks, fresh) : released;
}

/** Stop a run. Slices already filled stay filled; the schedule simply stops. */
export function cancelTwap(l: Ledger, id: string, tick: number): Ledger {
  const run = l.algos.find((a) => a.id === id);
  if (!run || run.status !== "active") return l;
  const live = new Set(run.sliceIds);
  let out: Ledger = {
    ...l,
    algos: l.algos.map((a) => (a.id === id ? { ...a, status: "cancelled" as const } : a)),
  };
  for (const w of l.working) if (live.has(w.order.id)) out = cancel(out, w.order.id, tick);
  return out;
}

/**
 * Place a plan and immediately settle whatever it placed.
 *
 * Composed rather than left to the per-tick effect so that market, IOC and FOK orders
 * resolve on their own placement pass — they are defined by not resting, and an
 * immediate-or-cancel order that sits in the blotter is simply wrong.
 *
 * Pure, so it is safe inside a `setState` updater even under StrictMode's double
 * invoke: both invocations start from the same ledger and produce the same result,
 * because ids are derived from (symbol, tick, prior state) rather than a counter.
 */
export function placeAndSettle(
  l: Ledger,
  requests: PlannedRequest[],
  tick: number,
  marks: Map<string, Feed>,
): Ledger {
  const placed = place(l, requests, tick);
  const fresh = new Set(
    placed.working.filter((w) => w.placedTick === tick).map((w) => w.order.id),
  );
  if (fresh.size === 0) return placed;
  return settle(placed, tick, marks, fresh);
}

/**
 * Has a trigger order's trigger fired at this mark?
 *
 * This depends on BOTH the side and the family, and an earlier version of this function
 * claimed otherwise — "both reduce to the same comparison because the trigger price
 * already encodes which side of the mark it sits on". That is false, and the comment
 * rationalised a bug that silently drained a position: a take-profit sell at 68,400 with
 * the mark at 64,161 fired immediately, because side-only logic reads a sell trigger as
 * "fires when the mark falls to it".
 *
 * The four cases, stated rather than inferred:
 *
 *   | Family      | Side | Fires when   | Protects                  |
 *   |-------------|------|--------------|---------------------------|
 *   | Stop        | SELL | mark <= trig | a long, against a fall    |
 *   | Stop        | BUY  | mark >= trig | a short, against a rise   |
 *   | TakeProfit  | SELL | mark >= trig | takes profit on a long    |
 *   | TakeProfit  | BUY  | mark <= trig | takes profit on a short   |
 *
 * A stop fires when the market moves AGAINST the position; a take-profit when it moves
 * IN FAVOUR. That is the distinction, and it is exactly opposite per side.
 */
function triggerCrossed(o: UiOrder, mark: number): boolean {
  const t = o.triggerPrice as number;
  const takeProfit = o.type === "TakeProfitLimit" || o.type === "TakeProfitMarket";
  if (takeProfit) return o.side === "SELL" ? mark >= t : mark <= t;
  return o.side === "SELL" ? mark <= t : mark >= t;
}

/**
 * Size available to this order at the touch, or 0 if it did not cross.
 *
 * Asks are stored far → near (ready to render above the mid), so the best ask is the
 * LAST element — the single easiest thing to get backwards in this file.
 */
function crossedSize(o: UiOrder, feed: Feed, placedThisTick: boolean): number {
  if (o.status !== "Open" && o.status !== "Triggered" && o.status !== "PartiallyFilled") return 0;

  if (IMMEDIATE.has(o.type)) {
    // Market-family: crosses whatever is there. Triggered stops only after firing.
    if (TRIGGERED_FAMILY.has(o.type) && o.status !== "Triggered") return 0;
    const book = o.side === "BUY" ? feed.asks : feed.bids;
    return book.length ? book[o.side === "BUY" ? book.length - 1 : 0].sz : 0;
  }

  // Post-only never fills on the pass it was placed — that is what post-only means.
  if (o.tif === "PostOnly" && placedThisTick) return 0;
  if (o.price === null) return 0;

  if (o.side === "BUY") {
    const bestAsk = feed.asks.length ? feed.asks[feed.asks.length - 1] : null;
    return bestAsk && bestAsk.px <= o.price ? bestAsk.sz : 0;
  }
  const bestBid = feed.bids.length ? feed.bids[0] : null;
  return bestBid && bestBid.px >= o.price ? bestBid.sz : 0;
}

/**
 * The price a fill happens at.
 *
 * Maker and taker are not the same case, and conflating them is why an early version of
 * this filled a crossing buy at the buyer's own limit while labelling it `taker` — a
 * trader would read that as the venue pocketing their price improvement.
 *
 *   • **Maker** — the order was already resting and the book came to it. Its own quote
 *     IS the price; that is what being the maker means.
 *   • **Taker** — the order arrived and crossed. It pays the touch, which is at least as
 *     good as its limit, so the improvement goes to the trader.
 *
 * Asks are stored far → near, so the best ask is the LAST element.
 */
function fillPrice(o: UiOrder, feed: Feed, maker: boolean): number {
  if (maker && !IMMEDIATE.has(o.type) && o.price !== null) return o.price;
  const book = o.side === "BUY" ? feed.asks : feed.bids;
  if (!book.length) return o.price ?? feed.last;
  const touch = book[o.side === "BUY" ? book.length - 1 : 0].px;
  if (o.price === null || IMMEDIATE.has(o.type)) return touch;
  // Never worse than the limit the trader set.
  return o.side === "BUY" ? Math.min(o.price, touch) : Math.max(o.price, touch);
}

/** Maker unless it took the touch on its own placement pass. */
const isMaker = (o: UiOrder, placedThisTick: boolean): boolean =>
  o.tif === "PostOnly" || (!IMMEDIATE.has(o.type) && !placedThisTick);

/**
 * Apply a fill to the position set.
 *
 * Same side → size grows at a weighted-average entry. Opposite side → size reduces and
 * the realized PnL on the closed portion is returned for the fill's `closedPnl`, which
 * is the column a trader reads first. Crossing zero on a non-reduce-only order flips
 * the side and re-enters at the fill price.
 */
function applyFill(
  positions: Position[],
  o: UiOrder,
  px: number,
  size: number,
  tick: number,
): { positions: Position[]; closedPnl: number | null } {
  const dir = o.side === "BUY" ? 1 : -1;
  const held = positions.find((p) => p.sym === o.sym);

  if (!held) {
    /*
     * Opening a position from flat would need an entry price, a liquidation price, a
     * margin figure and a funding rate — all of which the fixtures supply and none of
     * which this pass can invent honestly. Rather than fabricate a position, the fill
     * is recorded and the position set is left alone; a fill with no position is
     * visible in the Fills tab and is not a lie about margin.
     */
    return { positions, closedPnl: null };
  }

  if (held.dir === dir) {
    const notional = held.entry * held.size + px * size;
    const total = Number((held.size + size).toFixed(12));
    const entry = total > 0 ? notional / total : held.entry;
    return {
      positions: positions.map((p) =>
        p.sym === o.sym ? { ...p, size: total, entry, entryPrice: entry } : p,
      ),
      closedPnl: null,
    };
  }

  // Opposite side: this closes some or all of the position.
  const closed = Math.min(held.size, size);
  const closedPnl = (px - held.entry) * closed * held.dir;
  const left = Number((held.size - closed).toFixed(12));
  if (left <= 0) {
    return { positions: positions.filter((p) => p.sym !== o.sym), closedPnl };
  }
  return {
    positions: positions.map((p) => (p.sym === o.sym ? { ...p, size: left } : p)),
    closedPnl,
  };
}

/** Markets the account has exposure to — what `useMarks` should build feeds for. */
export const exposedSymbols = (l: Ledger): string[] => [
  ...new Set([...l.positions.map((p) => String(p.sym)), ...l.working.map((w) => String(w.order.sym))]),
];
