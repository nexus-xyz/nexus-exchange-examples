// End to end, against a loopback venue: a live run SIGKILLed mid-slice, then
// resumed, and nothing is sent twice.
//
//   npm test                          (quiet)
//   TWAP_E2E_VERBOSE=1 npm test       (prints both runs' output)
//
// The fake venue implements exactly the behaviour this app depends on, as the
// venue documents it: `client_id` dedupe (a repeat answers `200` while the
// original rests and `409 DuplicateClientId` once it doesn't), IOC matching
// against a finite ask level, CCXT-shaped orders (`symbol`, `clientOrderId`,
// `filled`), weight-5 history and fills reads, and one `429` with
// `retry-after`. It does not check signatures. CI runs this offline, as
// CONTRIBUTING requires ("a loopback socket is fine, a live venue is not").

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as journal from "./journal.js";

interface FakeOrder {
  id: string;
  symbol: string;
  clientOrderId: string | null;
  side: string;
  type: string;
  timeInForce: string;
  price: string;
  amount: string;
  filled: string;
  remaining: string;
  status: string;
}

function fakeVenue() {
  // 0.004 on offer at 80000, then unlimited at 80000.5. Integers of 0.001 lots.
  let bestLevelLots = 4;
  const orders: FakeOrder[] = [];
  const accountFills: { id: string; order_id: string; price: string; size: string }[] = [];
  const postsByClientId = new Map<string, number>();
  let seq = 0;
  let refused429 = false;
  const cancels: string[] = [];

  const lots = (s: string) => Math.round(Number(s) * 1000);
  const qty = (n: number) => (n / 1000).toFixed(3);

  function send(res: ServerResponse, status: number, body: unknown, bucket: string, extra: Record<string, string> = {}) {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-ratelimit-limit": "20",
      "x-ratelimit-remaining": "19",
      "x-ratelimit-bucket": bucket,
      ...extra,
    });
    res.end(JSON.stringify(body));
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /markets") {
      return send(res, 200, [{ id: "BTC-USDX-PERP", tick_size: "0.5", lot_size: "0.001", min_order_size: "0.001", max_order_size: "100" }], "key");
    }
    if (route === "GET /api/v1/markets/BTC-USDX-PERP/orderbook") {
      const asks: [number, number][] = bestLevelLots > 0 ? [[80000, bestLevelLots / 1000], [80000.5, 5]] : [[80000.5, 5]];
      return send(res, 200, { symbol: "BTC-USDX-PERP", bids: [[79999.5, 5]], asks, timestamp: Date.now(), datetime: "", nonce: 0 }, "ip");
    }
    if (route === "GET /api/v1/account/rate-limit") {
      return send(res, 200, { tier: "pro", limit: 20, remaining: 20, reset_at_ms: 0, buckets: { key: { limit: 20, remaining: 20, reset_at_ms: 0 }, order: { limit: 20, remaining: 20, reset_at_ms: 0 }, cancel: { limit: 20, remaining: 20, reset_at_ms: 0 } } }, "key");
    }
    if (route === "GET /api/v1/orders") return send(res, 200, orders.filter((o) => o.status === "Open"), "key");
    if (route === "GET /api/v1/orders/history") return send(res, 200, orders.filter((o) => o.status !== "Open").reverse(), "key");
    if (route === "GET /api/v1/fills") return send(res, 200, [...accountFills].reverse(), "key");
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/orders/")) {
      assert.ok(url.searchParams.get("market_id"), "cancel must carry market_id");
      cancels.push(url.pathname);
      return send(res, 404, { code: "not found" }, "cancel");
    }
    if (route === "POST /api/v1/orders") {
      const b = await body(req);
      const clientId = typeof b["client_id"] === "string" ? b["client_id"] : null;
      if (clientId !== null) postsByClientId.set(clientId, (postsByClientId.get(clientId) ?? 0) + 1);
      if (clientId?.endsWith("-4") && !refused429) {
        refused429 = true;
        return send(res, 429, { code: "RATE_LIMIT_EXCEEDED", message: "Order placement rate limit exceeded", tier: "pro" }, "order", { "retry-after": "1" });
      }
      const prior = orders.find((o) => o.clientOrderId === clientId && clientId !== null);
      if (prior !== undefined) {
        if (prior.status === "Open") return send(res, 200, { order: prior, fills: [] }, "order");
        return send(res, 409, { code: "DuplicateClientId", message: `client_id already used by ${prior.id}` }, "order");
      }
      assert.equal(b["time_in_force"], "IOC");
      const want = lots(String(b["quantity"]));
      const limit = Number(b["price"]);
      const fills: { id: string; price: string; quantity: string }[] = [];
      let left = want;
      if (limit >= 80000 && bestLevelLots > 0) {
        const take = Math.min(left, bestLevelLots);
        bestLevelLots -= take;
        left -= take;
        fills.push({ id: `t${++seq}`, price: "80000", quantity: qty(take) });
      }
      if (left > 0 && limit >= 80000.5) {
        fills.push({ id: `t${++seq}`, price: "80000.5", quantity: qty(left) });
        left = 0;
      }
      const filled = want - left;
      const order: FakeOrder = {
        id: `o${++seq}`,
        symbol: "BTC-USDX-PERP",
        clientOrderId: clientId,
        side: String(b["side"]),
        type: "Limit",
        timeInForce: "IOC",
        price: String(b["price"]),
        amount: qty(want),
        filled: qty(filled),
        remaining: qty(left),
        status: left === 0 ? "Filled" : "Cancelled",
      };
      orders.push(order);
      for (const f of fills) accountFills.push({ id: f.id, order_id: order.id, price: f.price, size: f.quantity });
      return send(res, 201, { order, fills }, "order");
    }
    send(res, 404, { code: `no route ${route}` }, "key");
  });
  return { server, orders, postsByClientId, cancels };
}

function runApp(args: string[], port: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      env: {
        ...process.env,
        NEXUS_EXCHANGE_API_URL: `http://127.0.0.1:${port}`,
        NEXUS_EXCHANGE_FUNDS: "play",
        NEXUS_EXCHANGE_API_KEY: "nx_loopback",
        NEXUS_EXCHANGE_API_SECRET: "00".repeat(32),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("exit", (code, signal) => resolve({ code, signal, out }));
  });
}

test("a live run SIGKILLed after slice 2 resumes without sending anything twice", { timeout: 60_000 }, async () => {
  const venue = fakeVenue();
  await new Promise<void>((r) => venue.server.listen(0, "127.0.0.1", r));
  const port = (venue.server.address() as AddressInfo).port;
  const runId = `e2e-${process.pid}`;
  const verbose = process.env["TWAP_E2E_VERBOSE"] === "1";
  try {
    const first = await runApp(
      ["--live", "--size", "0.006", "--duration", "12", "--slices", "6", "--limit", "80001", "--run-id", runId, "--kill-after", "2"],
      port,
    );
    if (verbose) console.log(`\n$ npm start -- --live … --kill-after 2\n${first.out}`);
    assert.equal(first.signal, "SIGKILL", first.out);
    // The venue has slice 2; the journal does not know it.
    assert.equal(venue.postsByClientId.get(`twap-${runId}-2`), 1);
    assert.equal(journal.load(runId).slices[2]?.state, "sending");

    const second = await runApp(["--live", "--resume", runId], port);
    if (verbose) console.log(`\n$ npm start -- --live --resume ${runId}\n${second.out}`);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /slice 2 .*the venue has it/);

    // The point of the whole design: one order per client id, and slice 2 was
    // never sent a second time.
    assert.equal(venue.postsByClientId.get(`twap-${runId}-2`), 1, "slice 2 re-sent after resume");
    const ids = venue.orders.map((o) => o.clientOrderId);
    assert.equal(new Set(ids).size, ids.length, "two venue orders share a client id");

    // Slice 4's 429 was a refusal: not retried, and its quantity rolled forward.
    const final = journal.load(runId);
    assert.equal(final.slices[4]?.state, "refused");
    assert.equal(venue.postsByClientId.get(`twap-${runId}-4`), 1, "a 429'd submission was retried");
    const filled = final.slices.reduce((a, s) => a + Math.round(Number(s.filled) * 1000), 0);
    assert.equal(filled, 6, "the parent filled in full through catch-up");
    assert.ok(final.finishedAt !== null);
  } finally {
    venue.server.close();
    rmSync(journal.journalPath(runId), { force: true });
  }
});
