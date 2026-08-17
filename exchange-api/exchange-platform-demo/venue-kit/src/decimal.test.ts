import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDec, applyBps, formatDec, mulDec, parseDec, ZERO } from "./decimal.ts";

describe("parseDec", () => {
  it("parses integers, fractions, and negatives exactly", () => {
    assert.deepEqual(parseDec("65000"), { units: 65000n, scale: 0 });
    assert.deepEqual(parseDec("0.1"), { units: 1n, scale: 1 });
    assert.deepEqual(parseDec("-12.345"), { units: -12345n, scale: 3 });
    assert.deepEqual(parseDec("  7.50  "), { units: 750n, scale: 2 });
  });

  it("rejects anything that is not a decimal string", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", "0x10", ".5", "5.", "NaN", "Infinity"]) {
      assert.throws(() => parseDec(bad), TypeError, `expected a throw for ${JSON.stringify(bad)}`);
    }
  });
});

describe("mulDec", () => {
  it("is exact where floating point is not", () => {
    // 0.1 * 3 in IEEE-754 is 0.30000000000000004.
    const product = mulDec(parseDec("0.1"), parseDec("3"));
    assert.equal(formatDec(product, 18), "0.300000000000000000");
  });

  it("computes fill notional at full precision", () => {
    const notional = mulDec(parseDec("64999.37"), parseDec("0.135"));
    assert.equal(formatDec(notional), "8774.914950");
  });
});

describe("addDec", () => {
  it("sums across differing scales", () => {
    assert.equal(formatDec(addDec(parseDec("1.5"), parseDec("2.25")), 2), "3.75");
    assert.equal(formatDec(addDec(ZERO, parseDec("0.000001")), 6), "0.000001");
  });
});

describe("applyBps", () => {
  it("applies an additive basis-point rate", () => {
    // 2 bps on 10,000 USDX is 2 USDX.
    assert.equal(formatDec(applyBps(parseDec("10000"), 2)), "2.000000");
    // The 10 bps cap on the same notional is 10 USDX.
    assert.equal(formatDec(applyBps(parseDec("10000"), 10)), "10.000000");
  });

  it("is zero at zero bps", () => {
    assert.equal(formatDec(applyBps(parseDec("8774.91495"), 0)), "0.000000");
  });

  it("rejects a non-integer or negative rate", () => {
    assert.throws(() => applyBps(parseDec("1"), 2.5), RangeError);
    assert.throws(() => applyBps(parseDec("1"), -1), RangeError);
  });
});

describe("formatDec", () => {
  it("rounds half away from zero", () => {
    assert.equal(formatDec({ units: 5n, scale: 1 }, 0), "1");
    assert.equal(formatDec({ units: -5n, scale: 1 }, 0), "-1");
    assert.equal(formatDec({ units: 4n, scale: 1 }, 0), "0");
    assert.equal(formatDec({ units: 15n, scale: 1 }, 0), "2");
  });

  it("pads a value smaller than one place", () => {
    assert.equal(formatDec(parseDec("0.5"), 6), "0.500000");
    assert.equal(formatDec(parseDec("0"), 6), "0.000000");
  });

  it("widens as well as narrows", () => {
    assert.equal(formatDec(parseDec("3"), 2), "3.00");
  });
});
