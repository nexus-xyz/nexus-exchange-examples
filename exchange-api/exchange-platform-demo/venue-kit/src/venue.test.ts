import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TenantConfig } from "./tenant.ts";
import { VenueProxy } from "./venue.ts";

const TENANT: TenantConfig = {
  id: "acme",
  name: "Acme Perps",
  palette: { green: "#12b981", red: "#ef4444", bg: "#0a0a0b", hi: "#fafafa" },
  venue: { apiBase: "https://api.example.test/api/v1", proxyPath: "/api/venue" },
  builder: { code: "bld_acme", feeBps: 2 },
  legal: { entity: "Acme Markets Ltd", disclosure: "./legal/acme.md" },
};

const KEY = {
  keyId: "nx_test_key",
  secretHex: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
};

/** A `fetch` stand-in that records what it was called with. */
function stubFetch(responses: { status: number; body: string }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | RequestInfo, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: "{}" };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function proxy(responses: { status: number; body: string }[] = []) {
  const { impl, calls } = stubFetch(responses);
  return {
    venue: new VenueProxy({
      tenant: TENANT,
      key: KEY,
      apiBase: "https://api.example.test/api/v1",
      now: () => 1_760_000_000_000,
      fetchImpl: impl,
    }),
    calls,
  };
}

describe("route allowlist", () => {
  it("refuses a route the venue does not expose, before signing it", async () => {
    const { venue, calls } = proxy();
    for (const request of [
      { method: "POST", path: "/keys" },
      { method: "POST", path: "/withdrawals" },
      { method: "GET", path: "/admin/tiers" },
      { method: "POST", path: "/auth/login" },
      { method: "GET", path: "/account/../admin/tiers" },
    ]) {
      const response = await venue.forward(request);
      assert.equal(response.status, 403, `expected 403 for ${request.method} ${request.path}`);
    }
    assert.equal(calls.length, 0, "a refused route must never reach the network");
  });

  it("allows the trading and read routes a terminal needs", async () => {
    const { venue, calls } = proxy([
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
    ]);
    for (const request of [
      { method: "GET", path: "/account/summary" },
      { method: "GET", path: "/positions" },
      { method: "POST", path: "/orders/preview", body: "{}" },
      { method: "DELETE", path: "/orders" },
    ]) {
      const response = await venue.forward(request);
      assert.equal(response.status, 200, `expected a pass-through for ${request.path}`);
    }
    assert.equal(calls.length, 4);
  });
});

describe("signing on the wire", () => {
  it("signs the full prefixed path and sends the three headers", async () => {
    const { venue, calls } = proxy([{ status: 200, body: "{}" }]);
    await venue.forward({ method: "GET", path: "/positions" });

    const [call] = calls;
    assert.equal(call?.url, "https://api.example.test/api/v1/positions");
    const headers = call?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "nx_test_key");
    assert.equal(headers["x-timestamp"], "1760000000000");
    assert.match(headers["x-signature"] ?? "", /^[0-9a-f]{64}$/);
  });

  it("never follows a redirect, which would leak the signature", async () => {
    const { venue, calls } = proxy([{ status: 200, body: "{}" }]);
    await venue.forward({ method: "GET", path: "/fills" });
    assert.equal((calls[0]?.init as RequestInit).redirect, "manual");
  });
});

describe("builder-code attribution", () => {
  it("records an accepted order against the tenant's code", async () => {
    const { venue } = proxy([
      { status: 200, body: JSON.stringify({ order: { id: "o1", market_id: "BTC-USDX-PERP" } }) },
    ]);
    await venue.forward({ method: "POST", path: "/orders", body: "{}" });

    const attribution = venue.ledger.lookup("o1");
    assert.equal(attribution?.builderCode, "bld_acme");
    assert.equal(attribution?.feeBps, 2);
    assert.equal(attribution?.marketId, "BTC-USDX-PERP");
  });

  it("attributes nothing when the exchange rejects the order", async () => {
    const { venue } = proxy([{ status: 400, body: JSON.stringify({ error: "MIN_NOTIONAL" }) }]);
    const response = await venue.forward({ method: "POST", path: "/orders", body: "{}" });

    assert.equal(response.status, 400);
    assert.equal(venue.ledger.size, 0);
  });

  it("follows a cancel-replace to the successor id", async () => {
    const { venue } = proxy([
      { status: 200, body: JSON.stringify({ order: { id: "o1", market_id: "BTC-USDX-PERP" } }) },
      { status: 200, body: JSON.stringify({ order: { id: "o2", market_id: "BTC-USDX-PERP" } }) },
    ]);
    await venue.forward({ method: "POST", path: "/orders", body: "{}" });
    await venue.forward({ method: "PATCH", path: "/orders/o1", body: "{}" });

    assert.equal(venue.ledger.lookup("o2")?.builderCode, "bld_acme");
  });

  it("summarises fills into an accrual that is never authoritative", async () => {
    const { venue } = proxy([
      { status: 200, body: JSON.stringify({ order: { id: "o1", market_id: "BTC-USDX-PERP" } }) },
      {
        status: 200,
        body: JSON.stringify([
          { id: "f1", order_id: "o1", market_id: "BTC-USDX-PERP", price: "65000", size: "1", fee: "32.5" },
          { id: "f2", order_id: "elsewhere", market_id: "BTC-USDX-PERP", price: "65000", size: "1", fee: "32.5" },
        ]),
      },
    ]);
    await venue.forward({ method: "POST", path: "/orders", body: "{}" });

    const [summary, ...rest] = await venue.builderSummary();
    assert.equal(rest.length, 0);
    assert.equal(summary?.builderCode, "bld_acme");
    assert.equal(summary?.fills, 1, "flow this venue did not submit must not be claimed");
    assert.equal(summary?.builderFeeAccrued, "13.000000");
    assert.equal(summary?.attributionAuthoritative, false);
  });

  it("survives a response shape it does not recognise", async () => {
    const { venue } = proxy([{ status: 200, body: "not json" }]);
    await venue.forward({ method: "POST", path: "/orders", body: "{}" });
    assert.equal(venue.ledger.size, 0);
  });
});
