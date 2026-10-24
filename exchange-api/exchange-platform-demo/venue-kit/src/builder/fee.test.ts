import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDec } from "../decimal.ts";
import { MAX_FEE_BPS, builderFee, discloseFee, fillNotional, normaliseFeeBps } from "./fee.ts";

describe("normaliseFeeBps", () => {
  it("passes a rate at or under the cap through unchanged", () => {
    assert.equal(normaliseFeeBps(2), 2);
    assert.equal(normaliseFeeBps(MAX_FEE_BPS), MAX_FEE_BPS);
  });

  it("clamps to the cap rather than throwing", () => {
    /* A venue that configures 25 renders at 10. Refusing to build would take a
       venue offline over a number the settlement path would clamp anyway. */
    assert.equal(normaliseFeeBps(25), MAX_FEE_BPS);
    assert.equal(normaliseFeeBps(10_000), MAX_FEE_BPS);
    assert.equal(normaliseFeeBps(10.1), MAX_FEE_BPS);
  });

  it("holds the cap at 10 bps — the number the page and the ticket both quote", () => {
    assert.equal(MAX_FEE_BPS, 10);
  });

  it("floors a negative rate at zero", () => {
    assert.equal(normaliseFeeBps(-5), 0);
  });

  it("keeps tenths of a basis point, because the recommended fee is 3.2", () => {
    assert.equal(normaliseFeeBps(3.2), 3.2);
    assert.equal(normaliseFeeBps(0.8), 0.8);
  });

  it("rounds to the nearest tenth rather than truncating", () => {
    assert.equal(normaliseFeeBps(2.94), 2.9);
    assert.equal(normaliseFeeBps(2.96), 3);
    /* A float path that lands a hair under still resolves to the intended tenth. */
    assert.equal(normaliseFeeBps(3.19999), 3.2);
  });

  it("refuses a non-number", () => {
    assert.throws(() => normaliseFeeBps(Number.NaN), RangeError);
    assert.throws(() => normaliseFeeBps(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe("builderFee", () => {
  it("is additive on notional, not carved out of the venue fee", () => {
    // 1 BTC at 65,000 with a 2 bps builder fee is 13 USDX, on top of whatever
    // the venue's own taker fee comes to. Nothing here touches that.
    const notional = fillNotional("65000", "1");
    assert.equal(formatDec(builderFee(notional, 2)), "13.000000");
  });


  it("is exact on a fractional size", () => {
    const notional = fillNotional("64999.37", "0.135");
    // 8774.91495 * 2 / 10000 = 1.754982990 → 1.754983 at 6dp.
    assert.equal(formatDec(builderFee(notional, 2)), "1.754983");
  });
});

describe("discloseFee", () => {
  it("returns a disclosure the ticket can render as its own row", () => {
    const disclosure = discloseFee("65000", "1", 2);
    assert.deepEqual(disclosure, {
      notional: "65000.000000",
      builderFee: "13.000000",
      feeBps: 2,
      estimate: true,
    });
  });


  it("is always marked an estimate — the exchange cannot charge this fee", () => {
    assert.equal(discloseFee("1", "1", 0).estimate, true);
  });
});
