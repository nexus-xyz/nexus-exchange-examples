// The pure half: planning, reading the venue, and one-cancels-other as a table.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkPlan,
  completePlan,
  decide,
  exitOrders,
  legView,
  normaliseStatus,
  readOrder,
  readPositionSize,
} from "./bracket.js";
import type { LegView, MarketRules, Plan, Snapshot } from "./bracket.js";
import type { BracketFlags } from "./config.js";
import * as dec from "./decimal.js";

const d = dec.parse;
const RULES: MarketRules = { marketId: "BTC-USDX-PERP", tick: d("0.5"), lot: d("0.001"), minSize: d("0.001") };

const LONG: Plan = {
  market: "BTC-USDX-PERP",
  side: "Buy",
  size: d("0.006"),
  limit: d("80010"),
  tp: d("80500"),
  sl: d("79600"),
  derived: [],
};

const leg = (state: LegView["state"], filled = "0", quantity = "0.004", reason: string | null = null): LegView => ({
  state,
  filled: d(filled),
  quantity: d(quantity),
  reason,
});

const snap = (tp: LegView, sl: LegView, position: string | null = "0.004"): Snapshot => ({
  tp,
  sl,
  position: position === null ? null : d(position),
});

test("checkPlan: a sound long bracket passes", () => {
  assert.deepEqual(checkPlan(LONG, RULES, d("80000")), []);
});

test("checkPlan: triggers on the wrong side of the mark are refused, not guessed at", () => {
  const problems = checkPlan({ ...LONG, sl: d("80005") }, RULES, d("80000"));
  assert.ok(problems.some((p) => p.includes("stop-loss 80005 is not below the mark 80000")), problems.join("\n"));
});

test("checkPlan: a short mirrors every side", () => {
  const short: Plan = { ...LONG, side: "Sell", limit: d("79990"), tp: d("79500"), sl: d("80400") };
  assert.deepEqual(checkPlan(short, RULES, d("80000")), []);
  assert.equal(checkPlan({ ...short, tp: d("80500") }, RULES, d("80000")).length, 2);
});

test("checkPlan: off-grid prices and sizes are refused", () => {
  const problems = checkPlan({ ...LONG, tp: d("80500.25"), size: d("0.0065") }, RULES, null);
  assert.ok(problems.some((p) => p.includes("tick grid")));
  assert.ok(problems.some((p) => p.includes("lot")));
});

test("completePlan: derived prices snap away from the reference", () => {
  const flags: BracketFlags = { market: "BTC-USDX-PERP", side: "Buy", size: d("0.002"), limit: null, tp: null, sl: null };
  const plan = completePlan(flags, d("80000.3"), d("0.5"));
  // 80000.3 × 1.0100 = 80800.303 → up to 80800.5; × 0.9950 = 79600.2985 → down to 79600
  assert.equal(dec.formatTrimmed(plan.tp), "80800.5");
  assert.equal(dec.formatTrimmed(plan.sl), "79600");
  assert.equal(plan.derived.length, 3);
});

test("exitOrders: sized to the filled quantity, reduce-only, native triggers, opposite side", () => {
  const exits = exitOrders(LONG, "run1", d("0.004"));
  assert.equal(exits.tp.quantity, "0.004");
  assert.equal(exits.sl.quantity, "0.004");
  assert.equal(exits.tp.order_type, "TakeProfitMarket");
  assert.equal(exits.sl.order_type, "StopMarket");
  assert.equal(exits.tp.trigger_price, "80500");
  assert.equal(exits.sl.trigger_price, "79600");
  assert.equal(exits.tp.side, "Sell");
  assert.equal(exits.tp.reduce_only, true);
  assert.equal(exits.sl.reduce_only, true);
  assert.equal(exits.sl.client_id, "br-run1-sl");
  assert.equal(exits.sl.price, undefined);
});

test("readOrder: CCXT and spec spellings read the same", () => {
  const ccxt = readOrder({ id: "a", symbol: "M", clientOrderId: "c", status: "closed", filled: 0.004, amount: "0.004" });
  const spec = readOrder({ id: "a", market_id: "M", client_id: "c", status: "Filled", filled_qty: "0.004", quantity: "0.004" });
  assert.deepEqual({ ...ccxt, status: null }, { ...spec, status: null }, "only the raw status text differs");
  assert.equal(ccxt?.state, "filled");
});

test("normaliseStatus: an unknown status is unknown, never open or gone", () => {
  assert.equal(normaliseStatus("Triggered"), "unknown");
  assert.equal(normaliseStatus(null), "unknown");
  assert.equal(normaliseStatus("canceled"), "gone");
  assert.equal(normaliseStatus("PartiallyFilled"), "open");
});

test("readPositionSize: no row is flat, an undecodable row is unknown", () => {
  assert.equal(dec.formatTrimmed(readPositionSize([], "M") ?? d("9")), "0");
  assert.equal(readPositionSize([{ market_id: "M", size: "n/a" }], "M"), null);
  assert.equal(dec.formatTrimmed(readPositionSize([{ symbol: "M", contracts: "-0.004" }], "M") ?? d("9")), "0.004");
});

test("legView: open orders win over history, and fills can prove a fill the lists don't show", () => {
  const open = [readOrder({ id: "x", status: "open", filled: "0", amount: "0.004" })!];
  const history = [readOrder({ id: "x", status: "canceled", filled: "0", amount: "0.004" })!];
  assert.equal(legView("x", d("0.004"), open, history, []).state, "open");
  const byFills = legView("y", d("0.004"), [], [], [{ id: "f", orderId: "y", size: d("0.004") }]);
  assert.equal(byFills.state, "filled");
  assert.equal(legView("z", d("0.004"), [], [], []).state, "missing");
});

// ── The OCO table ────────────────────────────────────────────────────────────

const table: Array<[string, Snapshot, string]> = [
  ["both resting", snap(leg("open"), leg("open")), "hold"],
  ["take-profit filled → cancel the stop", snap(leg("filled", "0.004"), leg("open"), "0"), "cancel:sl"],
  ["stop filled → cancel the take-profit", snap(leg("open"), leg("filled", "0.004"), "0"), "cancel:tp"],
  ["filled by quantity even while still listed open", snap(leg("open", "0.004"), leg("open"), "0"), "cancel:sl"],
  ["winner filled, loser already gone", snap(leg("filled", "0.004"), leg("gone"), "0"), "done"],
  ["position flat, both resting → cancel both", snap(leg("open"), leg("open"), "0"), "cancel:tp,sl"],
  ["venue removed the stop → unprotected, take-profit untouched", snap(leg("open"), leg("gone", "0", "0.004", "InsufficientLiquidity")), "unprotected"],
  ["venue removed the take-profit → still protected", snap(leg("gone"), leg("open")), "hold"],
  ["partial take-profit → hold, stop keeps full size", snap(leg("open", "0.001"), leg("open"), "0.003"), "hold"],
  ["position unreadable → hold, never guess flat", snap(leg("open"), leg("open"), null), "hold"],
  ["a leg not visible yet → hold", snap(leg("missing"), leg("open")), "hold"],
  ["unknown status → hold", snap(leg("unknown"), leg("open")), "hold"],
];

for (const [name, s, expected] of table) {
  test(`decide: ${name}`, () => {
    const got = decide(s);
    const label = got.kind === "cancel" ? `cancel:${got.legs.join(",")}` : got.kind;
    assert.equal(label, expected, JSON.stringify(got));
  });
}
