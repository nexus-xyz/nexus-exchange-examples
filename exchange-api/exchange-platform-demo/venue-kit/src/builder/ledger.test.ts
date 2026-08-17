import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AttributionLedger, summarise, type FillLike } from "./ledger.ts";

function fill(overrides: Partial<FillLike> & Pick<FillLike, "order_id">): FillLike {
  return {
    id: `f-${overrides.order_id}`,
    market_id: "BTC-USDX-PERP",
    price: "65000",
    size: "1",
    fee: "32.500000",
    ...overrides,
  };
}

function attribute(ledger: AttributionLedger, orderId: string, code: string, feeBps: number) {
  return ledger.record({
    orderId,
    builderCode: code,
    feeBps,
    marketId: "BTC-USDX-PERP",
    submittedAtMs: 1_760_000_000_000,
  });
}

describe("AttributionLedger", () => {
  it("normalises the rate once, at the recording boundary, cap included", () => {
    const ledger = new AttributionLedger();
    /* 50 bps is above the 10 bps ceiling, so it accrues at the ceiling. Recording
       it as given would book a receivable nobody can collect. */
    const recorded = attribute(ledger, "o1", "bld_acme", 50);
    assert.equal(recorded.feeBps, 10);
    assert.equal(ledger.lookup("o1")?.feeBps, 10);

    /* What the boundary still does: non-negative, rounded to a tenth of a bp. */
    assert.equal(attribute(ledger, "o2", "bld_acme", 3.2).feeBps, 3.2);
    assert.equal(attribute(ledger, "o3", "bld_acme", 2.94).feeBps, 2.9);
    assert.equal(attribute(ledger, "o4", "bld_acme", -4).feeBps, 0);
  });

  it("follows an amend chain to the original attribution", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "o1", "bld_acme", 2);
    ledger.recordAmend("o1", "o2");
    ledger.recordAmend("o2", "o3");
    assert.equal(ledger.lookup("o3")?.builderCode, "bld_acme");
  });

  it("does not hang on a cyclic amend chain", () => {
    const ledger = new AttributionLedger();
    ledger.recordAmend("a", "b");
    ledger.recordAmend("b", "a");
    assert.equal(ledger.lookup("a"), undefined);
  });

  it("returns undefined for an order it never submitted", () => {
    assert.equal(new AttributionLedger().lookup("stranger"), undefined);
  });
});

describe("summarise", () => {
  it("rolls up notional, venue fees, and accrued builder fee per code", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "o1", "bld_acme", 2);
    attribute(ledger, "o2", "bld_acme", 2);

    const [summary, ...rest] = summarise(ledger, [fill({ order_id: "o1" }), fill({ order_id: "o2" })]);

    assert.equal(rest.length, 0);
    assert.deepEqual(summary, {
      builderCode: "bld_acme",
      fills: 2,
      notional: "130000.000000",
      venueFees: "65.000000",
      builderFeeAccrued: "26.000000",
      attributionAuthoritative: false,
    });
  });

  it("skips flow the venue did not submit rather than claiming it", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "mine", "bld_acme", 2);

    const summaries = summarise(ledger, [
      fill({ order_id: "mine" }),
      fill({ order_id: "someone-elses" }),
    ]);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.fills, 1);
    assert.equal(summaries[0]?.notional, "65000.000000");
  });

  it("keeps two venues on the same account apart", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "o1", "bld_acme", 2);
    attribute(ledger, "o2", "bld_beta", 5);

    const summaries = summarise(ledger, [fill({ order_id: "o1" }), fill({ order_id: "o2" })]);

    assert.deepEqual(
      summaries.map((s) => [s.builderCode, s.builderFeeAccrued]),
      [
        ["bld_acme", "13.000000"],
        ["bld_beta", "32.500000"],
      ],
    );
  });

  it("attributes fills that land on an amended successor id", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "o1", "bld_acme", 2);
    ledger.recordAmend("o1", "o2");

    const summaries = summarise(ledger, [fill({ order_id: "o2", price: "64000", size: "0.5" })]);

    assert.equal(summaries[0]?.builderCode, "bld_acme");
    assert.equal(summaries[0]?.notional, "32000.000000");
    assert.equal(summaries[0]?.builderFeeAccrued, "6.400000");
  });

  it("never reports itself as authoritative", () => {
    const ledger = new AttributionLedger();
    attribute(ledger, "o1", "bld_acme", 2);
    for (const summary of summarise(ledger, [fill({ order_id: "o1" })])) {
      assert.equal(summary.attributionAuthoritative, false);
    }
  });

  it("is empty when nothing filled", () => {
    assert.deepEqual(summarise(new AttributionLedger(), []), []);
  });
});
