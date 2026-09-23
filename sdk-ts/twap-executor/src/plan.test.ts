// The properties the README claims, pinned offline.
//
//   npm test
//
// No network: pure functions in, assertions out. `run.test.ts` is the
// end-to-end half, against a loopback venue.

import assert from "node:assert/strict";
import { test } from "node:test";

import { API_VERSION } from "@nexus-xyz/exchange-ts";

import * as dec from "./decimal.js";
import { Pacer, classify, pauseFor } from "./pacer.js";
import {
  PlanError,
  buildSchedule,
  childLots,
  midOf,
  priceChild,
  readMarketRules,
  readTouch,
  reconcile,
  summarise,
} from "./plan.js";
import type { MarketRules, Parent } from "./plan.js";
import { SPEC_TAG, allMarkers, weightOf } from "./weights.js";

const rules: MarketRules = {
  marketId: "BTC-USDX-PERP",
  tick: dec.parse("0.5"),
  lot: dec.parse("0.001"),
  minSize: dec.parse("0.001"),
  maxSize: null,
};

function parent(size: string, slices: number, limit: string | null = "80000"): Parent {
  return {
    market: "BTC-USDX-PERP",
    side: "Buy",
    size: dec.parse(size),
    durationMs: 60_000,
    slices,
    limit: limit === null ? null : dec.parse(limit),
  };
}

test("the schedule sums to the parent exactly, including sizes that do not divide evenly", () => {
  for (const [size, slices] of [["0.006", 6], ["0.007", 3], ["0.1", 7], ["0.013", 13]] as const) {
    const schedule = buildSchedule(parent(size, slices), rules);
    const last = schedule.slots.at(-1);
    assert.equal(last?.cumulativeLots, schedule.totalLots, `${size}/${slices}`);
    const per = schedule.slots.map((s, i) => s.cumulativeLots - (schedule.slots[i - 1]?.cumulativeLots ?? 0n));
    assert.equal(per.reduce((a, b) => a + b, 0n), schedule.totalLots);
    assert.ok(per.every((l) => l > 0n), "no empty slice");
  }
});

test("a size off the lot grid, or too small to split, is refused rather than rounded", () => {
  assert.throws(() => buildSchedule(parent("0.0065", 2), rules), PlanError);
  assert.throws(() => buildSchedule(parent("0.002", 3), rules), PlanError);
});

test("a shortfall rolls forward, capped at twice the even share", () => {
  const schedule = buildSchedule(parent("0.010", 10), rules);
  const slot = (i: number) => schedule.slots[i]!;
  assert.equal(childLots(schedule, slot(0), 0n), 1n);
  // Nothing filled for five slices: the sixth wants 6 lots but may take 2.
  assert.equal(childLots(schedule, slot(5), 0n), 2n);
  // Ahead of schedule: nothing to do.
  assert.equal(childLots(schedule, slot(3), 5n), 0n);
  // Never more than what's left.
  assert.equal(childLots(schedule, slot(9), 9n), 1n);
});

test("a child is priced at the touch and never through the limit", () => {
  const touch = { bid: dec.parse("79990"), ask: dec.parse("80000.5") };
  const buy = priceChild("Buy", touch, dec.parse("80000"));
  assert.equal(buy.kind, "skip", "the ask is beyond a buy limit of 80000");
  const buyOk = priceChild("Buy", touch, dec.parse("80001"));
  assert.ok(buyOk.kind === "price" && dec.format(buyOk.price) === "80000.5");
  const sell = priceChild("Sell", touch, dec.parse("79995"));
  assert.equal(sell.kind, "skip", "the bid is below a sell limit of 79995");
  assert.equal(priceChild("Buy", { bid: null, ask: null }, null).kind, "skip");
});

test("book levels arrive as JSON numbers; an off-grid price is refused, not rounded", () => {
  const touch = readTouch({ bids: [[79999.5, 1]], asks: [[80000, 2]] }, rules.tick);
  assert.equal(dec.format(midOf(touch, rules.tick)!), "79999.750");
  assert.throws(() => readTouch({ bids: [[79999.3, 1]], asks: [] }, rules.tick), PlanError);
});

test("VWAP and slippage are exact, with positive meaning worse for either side", () => {
  const fills = [
    { id: "a", price: "80000", size: "0.001" },
    { id: "b", price: "80010", size: "0.002" },
  ];
  const buy = summarise("Buy", dec.parse("0.006"), fills, dec.parse("80000"), rules.tick);
  assert.equal(dec.format(buy.filled), "0.003");
  assert.equal(dec.formatTrimmed(buy.vwap!), "80006.66667");
  assert.equal(dec.format(buy.slippageBps!), "0.83");
  const sell = summarise("Sell", dec.parse("0.006"), fills, dec.parse("80000"), rules.tick);
  assert.equal(dec.format(sell.slippageBps!), "-0.83", "selling above arrival is better, so negative");
  assert.equal(summarise("Buy", dec.parse("0.006"), [], null, null).vwap, null);
});

test("decimal: the float traps a TWAP would otherwise hit", () => {
  assert.equal(dec.format(dec.add(dec.parse("0.1"), dec.parse("0.2"))), "0.3");
  assert.deepEqual(dec.countSteps(dec.parse("0.03"), dec.parse("0.01")), { count: 3n, exact: true });
  assert.equal(dec.format(dec.divRound(dec.parse("2"), dec.parse("3"), 4)), "0.6667");
  assert.equal(dec.format(dec.divRound(dec.parse("-2"), dec.parse("3"), 4)), "-0.6667");
  assert.throws(() => dec.parse("1e3"));
});

test("market rules are read under both the v0.8.1 and the live CCXT field names", () => {
  const old = readMarketRules({ market_id: "X", tick_size: "0.5", lot_size: "0.001", min_order_size: "0.001" });
  const live = readMarketRules({ id: "X", tick_size: "0.5", lot_size: "0.001", min_order_size: "0.001" });
  assert.equal(old?.marketId, "X");
  assert.equal(live?.marketId, "X");
});

test("reconcile matches by client id across both vocabularies, and attaches fills by order id", () => {
  const open = [{ id: "o-2", symbol: "BTC-USDX-PERP", clientOrderId: "twap-r-2", status: "Open", filled: "0" }];
  const history = [
    { id: "o-0", market_id: "BTC-USDX-PERP", client_id: "twap-r-0", status: "Filled", filled_qty: "0.001" },
    { id: "o-9", symbol: "BTC-USDX-PERP", clientOrderId: "someone-else", status: "Filled", filled: "1" },
  ];
  const fills = [{ id: "f1", order_id: "o-0", price: "80000", size: "0.001" }];
  const [r0, r1, r2] = reconcile(["twap-r-0", "twap-r-1", "twap-r-2"], open, history, fills);
  assert.equal(r0?.foundIn, "history");
  assert.equal(r0?.fills.length, 1);
  assert.equal(r1?.foundIn, null, "never landed");
  assert.equal(r2?.foundIn, "open");
});

test("weights come from the pinned spec's markers, and absence means 1", () => {
  assert.equal(SPEC_TAG, API_VERSION, "spec-weights.json must be regenerated when the SDK pin moves");
  assert.ok(allMarkers().length > 0);
  assert.equal(weightOf("GET", "/api/v1/fills"), 5);
  assert.equal(weightOf("GET", "/api/v1/orders/history"), 5);
  assert.equal(weightOf("POST", "/api/v1/orders"), 1);
  assert.equal(weightOf("GET", "/api/v1/account/rate-limit"), 0);
  assert.throws(() => weightOf("POST", "/api/v1/orders/batch"), /formula/);
});

test("a 429 pause is never shorter than retry-after, and jitter only adds", () => {
  assert.equal(pauseFor(2_000, () => 0), 2_000);
  assert.equal(pauseFor(2_000, () => 1), 3_000);
  assert.equal(pauseFor(null, () => 0), 1_000);
});

test("budgets: read from the status endpoint, trading inferred when buckets are absent", () => {
  const notes: string[] = [];
  const pacer = new Pacer(0.5, (m) => notes.push(m));
  pacer.applyStatus({ tier: "pro", limit: 20, remaining: 20, reset_at_ms: 0 });
  const lines = pacer.describe().join("\n");
  assert.match(lines, /request 20\/s.*\(status\)/);
  assert.match(lines, /order {3}20\/s.*\(inferred\)/);
  assert.match(lines, /cancel {2}shares the order bucket/);
  pacer.applyStatus({ tier: "pro", limit: 20, remaining: 20, reset_at_ms: 0, buckets: { order: { limit: 30, remaining: 30, reset_at_ms: 0 }, cancel: { limit: 40, remaining: 40, reset_at_ms: 0 } } });
  assert.match(pacer.describe().join("\n"), /cancel {2}40\/s/);
  assert.equal(classify("DELETE", "/api/v1/orders/{order_id}"), "cancel");
  assert.equal(classify("GET", "/api/v1/orders"), "request");
});
