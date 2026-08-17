/*
 * From ticket draft to actual requests, and the local order lifecycle.
 *
 * This file exists because the ticket was lying. It rendered a hand-built object
 * with `leverage`, `margin_mode`, `post_only` and a nested `bracket` — four fields
 * the real API does not have — with lowercase enum values and JSON numbers where
 * decimal strings are required. Meanwhile `serializeOrderRequest` in lib/api/adapter.ts
 * already produced a correct body and was called from nowhere.
 *
 * Three truths the old preview hid, which this makes visible instead:
 *
 *   1. `scale` and `twap` are NOT wire order types. The real `OrderType` enum has
 *      eight values and neither is among them. They are client-side algorithms that
 *      emit many ordinary orders. So they serialize to a *set* of requests.
 *   2. TP/SL is not a field. `OrderRequest` has no bracket. A take-profit and a
 *      stop-loss are follow-up trigger orders placed after the entry — which is
 *      exactly why the blotter needs a trigger column to show them.
 *   3. Leverage and margin mode have no API surface at all. They are local
 *      projections, and saying so is better than emitting fields that would 400.
 */

import { serializeOrderRequest, type OrderDraft, type SerializeResult, type UiOrder } from "./api/adapter";
import { registryMarket } from "./api/markets";
import type { MarketId, WireOrderRequest } from "./api/types";
import type { Market } from "./markets";
import {
  effectiveTif,
  scaleLadder,
  twapSchedule,
  type Draft,
  type OrderType,
} from "@/components/terminal/OrderTicket";

/** Ticket order-type ids → the real wire enum. `scale`/`twap` have no wire form. */
const WIRE_TYPE: Record<Exclude<OrderType, "scale" | "twap">, "Limit" | "Market" | "StopLimit" | "StopMarket"> = {
  limit: "Limit",
  market: "Market",
  stop_limit: "StopLimit",
  stop_market: "StopMarket",
};


export type PlanKind = "entry" | "scale-child" | "twap-slice" | "take-profit" | "stop-loss";

export type PlannedRequest = {
  kind: PlanKind;
  /** What this request is for, in one phrase. */
  label: string;
  result: SerializeResult;
};

export type OrderPlan = {
  requests: PlannedRequest[];
  /** Every problem across every request, deduped. Non-empty ⇒ do not submit. */
  problems: string[];
  /**
   * Ticket controls with no API surface. Shown in the preview as local-only rather
   * than emitted as fields that would be rejected.
   */
  localOnly: { field: string; value: string; why: string }[];
  /** True when the draft is an algorithm rather than a single order. */
  isAlgo: boolean;
};

function baseDraft(draft: Draft, market: Market, last: number): OrderDraft {
  const wireType = draft.type === "scale" || draft.type === "twap" ? "Limit" : WIRE_TYPE[draft.type];
  return {
    sym: market.sym as MarketId,
    side: draft.side === "buy" ? "BUY" : "SELL",
    type: wireType,
    // A market-family order carries no price; the serializer rejects one that does.
    price: wireType === "Market" || wireType === "StopMarket" ? null : (draft.price ?? last),
    size: draft.size,
    tif: effectiveTif(draft),
    reduceOnly: draft.reduceOnly,
    triggerPrice: wireType === "StopLimit" || wireType === "StopMarket" ? (draft.trigger ?? last) : null,
  };
}

/**
 * Turn a ticket draft into the request (or requests) it actually implies.
 *
 * Deliberately returns a plan rather than a body: a Scale order is five requests, a
 * TWAP is six, and an entry with a bracket is three. A preview that shows one object
 * for any of those is the lie this replaces.
 */
export function planOrder(draft: Draft, market: Market, last: number): OrderPlan {
  /*
   * `registryMarket` returns undefined for a symbol outside the registry. Every
   * market on screen comes from it, so this is a should-never-happen — but the
   * serializer needs tick/lot to snap prices, and silently skipping the snap would
   * emit off-tick prices the venue rejects. Surface it as a problem instead.
   */
  const reg = registryMarket(market.sym);
  if (!reg) {
    return {
      requests: [],
      problems: [`${market.sym} is not in the market registry — cannot snap price to tick or size to lot`],
      localOnly: [],
      isAlgo: false,
    };
  }
  const requests: PlannedRequest[] = [];
  const isAlgo = draft.type === "scale" || draft.type === "twap";

  if (draft.type === "scale") {
    /*
     * The ladder the ticket's own fields describe — start, end, count and skew —
     * rather than a hardcoded five rungs between prices nobody chose. `scaleLadder`
     * is the single definition; the summary block reads the same function, so the
     * "5 orders" it prints and the five requests below cannot disagree.
     */
    const ladder = scaleLadder(draft, last);
    ladder.rungs.forEach((rung, i) => {
      requests.push({
        kind: "scale-child",
        label: `rung ${i + 1} of ${ladder.n}`,
        result: serializeOrderRequest(
          { ...baseDraft(draft, market, last), price: rung.price, size: rung.size },
          reg,
        ),
      });
    });
  } else if (draft.type === "twap") {
    const { orders, sizePer } = twapSchedule(draft, market.minOrderSize);
    for (let i = 0; i < orders; i++) {
      requests.push({
        kind: "twap-slice",
        label: `slice ${i + 1} of ${orders}`,
        result: serializeOrderRequest(
          { ...baseDraft(draft, market, last), type: "Market", price: null, size: sizePer },
          reg,
        ),
      });
    }
  } else {
    requests.push({ kind: "entry", label: "entry", result: serializeOrderRequest(baseDraft(draft, market, last), reg) });
  }

  /*
   * The bracket, as what it really is: two reduce-only trigger orders on the
   * opposite side, placed after the entry. Not a field on the entry.
   */
  if (draft.tpsl && !isAlgo) {
    const exit = draft.side === "buy" ? ("SELL" as const) : ("BUY" as const);
    if (draft.tp !== null) {
      requests.push({
        kind: "take-profit",
        label: "take profit",
        result: serializeOrderRequest(
          { sym: market.sym as MarketId, side: exit, type: "TakeProfitMarket", price: null, size: draft.size, tif: "GTC", reduceOnly: true, triggerPrice: draft.tp },
          reg,
        ),
      });
    }
    if (draft.sl !== null) {
      requests.push({
        kind: "stop-loss",
        label: "stop loss",
        result: serializeOrderRequest(
          { sym: market.sym as MarketId, side: exit, type: "StopMarket", price: null, size: draft.size, tif: "GTC", reduceOnly: true, triggerPrice: draft.sl },
          reg,
        ),
      });
    }
  }

  const localOnly = [
    {
      field: "leverage",
      value: `${draft.lev}×`,
      why: "POST /leverage exists on the engine but is absent from the vendored spec and unproxied; Position.leverage returns null",
    },
    {
      field: "margin_mode",
      value: draft.margin,
      why: "no margin_mode field exists anywhere in openapi.json; cross is the engine default",
    },
    // Randomize is a property of the SCHEDULE, not of any one slice. Every request
    // below is an ordinary market order; what the flag changes is when the client
    // fires them, which is why it cannot appear on the wire.
    ...(draft.type === "twap" && draft.twapRandomize
      ? [
          {
            field: "twap_randomize",
            value: "on",
            why: "the client jitters each slice's send time; the venue receives ordinary orders and never sees the schedule",
          },
        ]
      : []),
  ];

  return {
    requests,
    problems: [...new Set(requests.flatMap((r) => r.result.problems))],
    localOnly,
    isAlgo,
  };
}

// ---------------------------------------------------------------- local lifecycle

/*
 * Minting working orders used to happen here. It now lives in `lib/lifecycle.ts`,
 * because an order's id has to be a function of the tick it was placed on and this
 * module has no tick.
 *
 * What was here before: a module-level `seq` counter behind a comment promising
 * "Never crypto.randomUUID or Date.now — a submitted order has to render identically
 * on a re-capture". The promise was right and the counter did not keep it — a module
 * variable survives Fast Refresh, is invisible to React, and is not derived from
 * (symbol, tick), so the same order re-rendered under a different id. It also never
 * set `createdAt`, `updatedAt` or `cancellationReason`, all three required on
 * `UiOrder`, and an `as UiOrder` cast hid that they were `undefined` at runtime.
 *
 * The boundary now reads:
 *   lib/orders.ts     draft   → request     (planOrder — this module)
 *   lib/lifecycle.ts  request → state       (place, cancel, amend, settle)
 */

export type SubmitOutcome = { ok: false; problems: string[] } | { ok: true; note: string };

/**
 * Validate a plan and describe what placing it does.
 *
 * The refusal is the point: the button has the same failure modes the real endpoint
 * would, because the plan it refuses is the one the serializer rejected. Placement
 * itself is `place()` in `lib/lifecycle.ts`.
 */
/**
 * One TWAP slice, as an ordinary market order.
 *
 * A TWAP is not a wire order type — the venue only ever sees the slices, and the
 * schedule is the client's. So the scheduler in `lib/lifecycle.ts` releases slices by
 * calling this, and each release goes through the same serializer as a hand-placed
 * order. Null when the symbol is not in the registry, which is the same
 * should-never-happen `planOrder` guards.
 */
export function twapSliceRequest(
  sym: MarketId,
  side: "BUY" | "SELL",
  size: number,
): PlannedRequest | null {
  const reg = registryMarket(sym);
  if (!reg) return null;
  return {
    kind: "twap-slice",
    label: "slice",
    result: serializeOrderRequest(
      { sym, side, type: "Market", price: null, size, tif: "GTC", reduceOnly: false, triggerPrice: null },
      reg,
    ),
  };
}

export function submitPlan(plan: OrderPlan, market: Market): SubmitOutcome {
  if (plan.problems.length > 0) return { ok: false, problems: plan.problems };

  const n = plan.requests.length;

  const note =
    plan.isAlgo || n > 1
      ? `${n} orders working — ${plan.requests[0].kind === "scale-child" ? "scale ladder" : plan.requests[0].kind === "twap-slice" ? "TWAP slices" : "entry plus bracket"}`
      : `order working on ${market.sym}`;
  return { ok: true, note };
}
