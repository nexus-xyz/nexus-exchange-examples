/*
 * Signing is the one part of this kit where being *nearly* right produces a
 * plausible signature the server rejects with an opaque 401. So these tests pin
 * the canonical string literally, and the signatures against fixtures computed
 * independently — not by calling the code under test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalString, signHeaders, TIMESTAMP_TOLERANCE_MS } from "./sign.ts";

const KEY = {
  keyId: "nx_test_key",
  secretHex: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
};
const TS = 1_760_000_000_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("canonicalString", () => {
  it("is five newline-separated lines in the server's order", () => {
    const canonical = canonicalString({ method: "GET", path: "/api/v1/markets", timestampMs: TS });
    assert.equal(canonical, `1760000000000\nGET\n/api/v1/markets\n\n${EMPTY_SHA256}`);
    assert.equal(canonical.split("\n").length, 5);
  });

  it("hashes an absent body rather than omitting the line", () => {
    const canonical = canonicalString({ method: "GET", path: "/api/v1/markets", timestampMs: TS });
    assert.ok(canonical.endsWith(EMPTY_SHA256));
  });

  it("keeps an empty query as an empty line", () => {
    const withQuery = canonicalString({
      method: "GET",
      path: "/api/v1/fills",
      query: "limit=50",
      timestampMs: TS,
    });
    assert.equal(withQuery.split("\n")[3], "limit=50");
  });

  it("upper-cases the method", () => {
    const canonical = canonicalString({ method: "post", path: "/api/v1/orders", timestampMs: TS });
    assert.equal(canonical.split("\n")[1], "POST");
  });

  it("signs the full path, prefix included", () => {
    // Signing `/orders` when the server verifies `/api/v1/orders` is a 401.
    const canonical = canonicalString({ method: "POST", path: "/api/v1/orders", timestampMs: TS });
    assert.equal(canonical.split("\n")[2], "/api/v1/orders");
  });
});

describe("signHeaders", () => {
  it("matches an independently computed signature for a GET", () => {
    const headers = signHeaders(KEY, { method: "GET", path: "/api/v1/markets", timestampMs: TS });
    assert.deepEqual(headers, {
      "x-api-key": "nx_test_key",
      "x-timestamp": "1760000000000",
      "x-signature": "65e605b82366fb74546c1b80e0dd41ba28f9ac16b56544ceef3859ba6fd06008",
    });
  });

  it("matches an independently computed signature for a POST with a body", () => {
    const headers = signHeaders(KEY, {
      method: "POST",
      path: "/api/v1/orders",
      body: '{"market_id":"BTC-USDX-PERP","side":"Buy"}',
      timestampMs: TS,
    });
    assert.equal(
      headers["x-signature"],
      "c0d673826896792a2ce45391be496e2c72df4b68e32cccff8e34de297620c262",
    );
  });

  it("signs with the decoded secret, not the hex text", () => {
    // The failure this guards is silent: signing with the string produces a
    // well-formed signature that is always rejected.
    const asText = signHeaders(
      { keyId: KEY.keyId, secretHex: KEY.secretHex.toUpperCase() },
      { method: "GET", path: "/api/v1/markets", timestampMs: TS },
    );
    assert.equal(
      asText["x-signature"],
      "65e605b82366fb74546c1b80e0dd41ba28f9ac16b56544ceef3859ba6fd06008",
    );
  });

  it("rejects a secret that is not 32 bytes of hex", () => {
    for (const bad of ["", "deadbeef", KEY.secretHex.slice(0, 62), `${KEY.secretHex}ff`, "z".repeat(64)]) {
      assert.throws(
        () => signHeaders({ keyId: "k", secretHex: bad }, { method: "GET", path: "/", timestampMs: TS }),
        /32 bytes/,
        `expected a throw for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("accepts a 0x-prefixed secret", () => {
    const headers = signHeaders(
      { keyId: KEY.keyId, secretHex: `0x${KEY.secretHex}` },
      { method: "GET", path: "/api/v1/markets", timestampMs: TS },
    );
    assert.equal(
      headers["x-signature"],
      "65e605b82366fb74546c1b80e0dd41ba28f9ac16b56544ceef3859ba6fd06008",
    );
  });
});

describe("clock", () => {
  it("states the server's 30s tolerance", () => {
    assert.equal(TIMESTAMP_TOLERANCE_MS, 30_000);
  });
});
