// End to end, against a loopback venue: the whole live path, with the real SDK
// doing every REST request and the SDK's own WebSocket client doing the stream.
//
//   npm test                           (quiet)
//   BRACKET_E2E_VERBOSE=1 npm test     (prints each run's output)
//
// The fake venue implements the behaviour this app depends on: an IOC entry
// that fills only what the book holds, conditional exits that rest until the
// test fires them, CCXT-shaped orders (`symbol`, `clientOrderId`, `filled`,
// `amount`) as the live venue returns, and a `DELETE /orders/{id}` that answers
// 400 without `market_id`, as spec v0.8.1 requires (ENG-17118). The socket is
// injected through `createWsClient`'s `WebSocketImpl`, so the SDK's reconnect
// and resubscribe logic is the real one; only the transport is fake. Nothing
// checks signatures. CI runs this offline, as CONTRIBUTING requires ("a
// loopback socket is fine, a live venue is not").

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { WebSocketCtor, WebSocketLike } from "@nexus-xyz/exchange-ts";

import { EXIT_INTERRUPTED, EXIT_OK, EXIT_REFUSED, EXIT_UNRESOLVED, runBracket } from "./app.js";
import type { Phase } from "./app.js";
import type { Config } from "./config.js";
import * as dec from "./decimal.js";

const MARKET = "BTC-USDX-PERP";
const VERBOSE = process.env["BRACKET_E2E_VERBOSE"] === "1";

interface FakeOrder {
  id: string;
  symbol: string;
  clientOrderId: string | null;
  side: string;
  type: string;
  timeInForce: string;
  reduceOnly: boolean;
  triggerPrice: string | null;
  price: string | null;
  amount: string;
  filled: string;
  status: "open" | "closed" | "canceled";
  cancellation_reason: string | null;
}

class FakeSocket implements WebSocketLike {
  static readonly OPEN = 1;
  static venue: FakeVenue | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  subscriptions = new Set<string>();

  constructor(readonly url: string) {
    const venue = FakeSocket.venue;
    const token = new URL(url).searchParams.get("token");
    setTimeout(() => {
      if (venue === null || token === null || !venue.tokens.delete(token)) {
        this.readyState = 3;
        this.onclose?.({});
        return;
      }
      venue.sockets.add(this);
      this.readyState = 1;
      this.onopen?.({});
    }, 5);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { op: string; channel: string };
    if (msg.op === "subscribe") {
      this.subscriptions.add(msg.channel);
      this.onmessage?.({ data: JSON.stringify({ op: "subscribed", channel: msg.channel, market: null, seq_at_join: 0 }) });
    }
  }

  close(): void {
    this.drop();
  }

  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    FakeSocket.venue?.sockets.delete(this);
    this.onclose?.({});
  }
}

class FakeVenue {
  orders: FakeOrder[] = [];
  fills: { id: string; order_id: string; price: string; size: string; side: string }[] = [];
  position = dec.ZERO;
  /** What the book holds for the entry: the rest of an IOC is cancelled. */
  liquidity = dec.parse("0.004");
  codActive = false;
  tokens = new Set<string>();
  sockets = new Set<FakeSocket>();
  posts: Record<string, unknown>[] = [];
  deletes: string[] = [];
  reads = 0;
  private seq = 0;
  private ids = 0;

  push(channel: "orders" | "fills", payload: unknown): void {
    this.seq += 1;
    for (const s of this.sockets) {
      if (s.subscriptions.has(channel)) {
        s.onmessage?.({ data: JSON.stringify({ op: "event", channel, market: null, seq: this.seq, payload }) });
      }
    }
  }

  dropSockets(): void {
    for (const s of [...this.sockets]) s.drop();
  }

  byType(type: string): FakeOrder {
    const o = this.orders.find((x) => x.type === type);
    assert.ok(o, `no ${type} order`);
    return o;
  }

  /** The venue firing a conditional exit: it fills in full and closes the position. */
  fire(type: "TakeProfitMarket" | "StopMarket"): FakeOrder {
    const o = this.byType(type);
    o.status = "closed";
    o.filled = o.amount;
    this.fills.push({ id: `f-${o.id}`, order_id: o.id, price: o.triggerPrice ?? "0", size: o.amount, side: o.side });
    this.position = dec.sub(this.position, dec.parse(o.amount));
    return o;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = `${req.method} ${url.pathname}`;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const ccxt = (o: FakeOrder) => ({ ...o, remaining: dec.format(dec.sub(dec.parse(o.amount), dec.parse(o.filled))) });
    if (req.method === "GET") this.reads += 1;

    if (route === "GET /markets") return send(200, [{ id: MARKET, tick_size: "0.5", lot_size: "0.001", min_order_size: "0.001" }]);
    if (route === `GET /api/v1/markets/${MARKET}/mark-price`) return send(200, { market_id: MARKET, mark_price: "80000" });
    if (route === "GET /api/v1/account/cancel-on-disconnect") {
      return send(200, { enabled: this.codActive, active: this.codActive, grace_secs: this.codActive ? 5 : null });
    }
    if (route === "GET /api/v1/positions") {
      return send(200, dec.isZero(this.position) ? [] : [{ market_id: MARKET, side: "Long", size: dec.format(this.position) }]);
    }
    if (route === "GET /api/v1/orders") return send(200, this.orders.filter((o) => o.status === "open").map(ccxt));
    if (route === "GET /api/v1/orders/history") return send(200, this.orders.filter((o) => o.status !== "open").map(ccxt));
    if (route === "GET /api/v1/fills") return send(200, [...this.fills].reverse());
    if (route === "POST /ws/token") {
      const token = `tok-${this.tokens.size}-${Date.now()}`;
      this.tokens.add(token);
      return send(200, { token, expires_in_secs: 60 });
    }
    if (route === "POST /api/v1/orders") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      this.posts.push(body);
      this.ids += 1;
      const order: FakeOrder = {
        id: `00000000-0000-4000-8000-${String(this.ids).padStart(12, "0")}`,
        symbol: String(body["market_id"]),
        clientOrderId: typeof body["client_id"] === "string" ? body["client_id"] : null,
        side: String(body["side"]),
        type: String(body["order_type"]),
        timeInForce: String(body["time_in_force"]),
        reduceOnly: body["reduce_only"] === true,
        triggerPrice: typeof body["trigger_price"] === "string" ? body["trigger_price"] : null,
        price: typeof body["price"] === "string" ? body["price"] : null,
        amount: String(body["quantity"]),
        filled: "0",
        status: "open",
        cancellation_reason: null,
      };
      this.orders.push(order);
      const fills: unknown[] = [];
      if (order.type === "Limit" && order.timeInForce === "IOC") {
        const got = dec.min(dec.parse(order.amount), this.liquidity);
        order.filled = dec.format(got);
        order.status = dec.compare(got, dec.parse(order.amount)) === 0 ? "closed" : "canceled";
        this.position = dec.add(this.position, got);
        const fill = { id: `f-${order.id}`, order_id: order.id, price: order.price ?? "0", size: order.filled, side: order.side };
        this.fills.push(fill);
        fills.push({ id: fill.id, price: fill.price, quantity: fill.size });
      }
      return send(201, { order: ccxt(order), fills });
    }
    const del = /^DELETE \/api\/v1\/orders\/([^/]+)$/.exec(route);
    if (del) {
      if (url.searchParams.get("market_id") !== MARKET) return send(400, { code: "InvalidRequest", message: "market_id is required" });
      const o = this.orders.find((x) => x.id === del[1]);
      if (o === undefined || o.status !== "open") return send(404, { code: "OrderNotFound" });
      o.status = "canceled";
      o.cancellation_reason = "User";
      this.deletes.push(o.id);
      return send(200, { ok: true });
    }
    send(404, { code: "NOT_FOUND", route });
  };
}

async function withVenue(fn: (venue: FakeVenue, config: Config) => Promise<void>): Promise<void> {
  const venue = new FakeVenue();
  FakeSocket.venue = venue;
  const server = createServer((req, res) => void venue.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const config: Config = {
    apiKey: "test-key",
    apiSecret: "11".repeat(32),
    baseUrl: `http://127.0.0.1:${port}`,
    baseUrlOverridden: true,
    wsUrl: `ws://127.0.0.1:${port}`,
    funds: "play",
    live: true,
    bracket: { market: MARKET, side: "Buy", size: dec.parse("0.006"), limit: dec.parse("80010"), tp: dec.parse("80500"), sl: dec.parse("79600") },
    runId: "t1",
    // Long on purpose: nothing in these tests may be rescued by the timer.
    // Every detection has to come from a frame or a reconnect.
    reconcileMs: 60_000,
  };
  try {
    await fn(venue, config);
  } finally {
    venue.dropSockets();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface Run {
  readonly lines: string[];
  readonly abort: AbortController;
  readonly managing: Promise<void>;
  readonly done: Promise<number>;
}

function start(config: Config): Run {
  const lines: string[] = [];
  const abort = new AbortController();
  let resolveManaging!: () => void;
  const managing = new Promise<void>((r) => (resolveManaging = r));
  const done = runBracket(config, {
    log: (m) => {
      lines.push(m);
      if (VERBOSE) console.log(`    ${m}`);
    },
    signal: abort.signal,
    onPhase: (p: Phase) => {
      if (p === "managing") resolveManaging();
    },
    WebSocketImpl: FakeSocket as unknown as WebSocketCtor,
    settleMs: 20,
  });
  return { lines, abort, managing, done };
}

async function until(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Managing, with the socket open and subscribed, and the first reconcile read. */
async function settled(venue: FakeVenue, run: Run): Promise<void> {
  await run.managing;
  await until("the socket to subscribe", () => [...venue.sockets].some((s) => s.subscriptions.size === 2));
  await until("the first reconcile", () => run.lines.some((l) => l.startsWith("reconcile (initial reconcile)")));
}

test("partial entry: exits sized to the fill, stop placed first; a take-profit frame cancels the stop with market_id", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);

    const [entry, first, second] = venue.posts;
    assert.equal(entry?.["time_in_force"], "IOC");
    assert.equal(first?.["order_type"], "StopMarket", "the stop goes on before the take-profit");
    assert.equal(second?.["order_type"], "TakeProfitMarket");
    for (const exit of [first, second]) {
      assert.equal(exit?.["quantity"], "0.004", "sized to the 0.004 that filled, not the 0.006 asked for");
      assert.equal(exit?.["reduce_only"], true);
      assert.equal(exit?.["side"], "Sell");
    }
    assert.equal(first?.["trigger_price"], "79600");
    assert.equal(second?.["trigger_price"], "80500");

    const tp = venue.fire("TakeProfitMarket");
    venue.push("fills", { order_id: tp.id, size: tp.amount });
    assert.equal(await run.done, EXIT_OK);
    assert.deepEqual(venue.deletes, [venue.byType("StopMarket").id]);
    assert.equal(venue.orders.filter((o) => o.status === "open").length, 0);
  });
});

test("a fill missed while the socket was down is found by the reconcile a reconnect forces", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);

    // The socket drops, and while it is down the stop fires. No frame is ever
    // delivered for it: the fake does not replay, which is the worst case the
    // server's bounded ring allows without announcing `out_of_sync`.
    venue.dropSockets();
    venue.fire("StopMarket");

    assert.equal(await run.done, EXIT_OK);
    assert.ok(run.lines.some((l) => l.includes("websocket reconnected")), run.lines.join("\n"));
    assert.deepEqual(venue.deletes, [venue.byType("TakeProfitMarket").id]);
  });
});

test("an out_of_sync notice forces a reconcile too", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);
    venue.fire("TakeProfitMarket");
    for (const s of venue.sockets) s.onmessage?.({ data: JSON.stringify({ op: "out_of_sync", channel: "orders", market: null, oldest_seq: 50 }) });
    assert.equal(await run.done, EXIT_OK);
    assert.ok(run.lines.some((l) => l.includes("out_of_sync")));
    assert.deepEqual(venue.deletes, [venue.byType("StopMarket").id]);
  });
});

test("interrupt: both exits are left resting, and nothing is cancelled", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);
    run.abort.abort();
    assert.equal(await run.done, EXIT_INTERRUPTED);
    assert.deepEqual(venue.deletes, []);
    assert.equal(venue.orders.filter((o) => o.status === "open" && o.reduceOnly).length, 2);
    assert.ok(run.lines.some((l) => l.includes("position stays protected")));
  });
});

test("the venue removing the stop is reported unprotected, and the take-profit is not touched", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);
    const sl = venue.byType("StopMarket");
    sl.status = "canceled";
    sl.cancellation_reason = "InsufficientLiquidity";
    venue.push("orders", { id: sl.id, status: "canceled" });
    assert.equal(await run.done, EXIT_UNRESOLVED);
    assert.deepEqual(venue.deletes, []);
    assert.ok(run.lines.some((l) => l.includes("UNPROTECTED") && l.includes("InsufficientLiquidity")));
  });
});

test("a position closed elsewhere cancels both exits", async () => {
  await withVenue(async (venue, config) => {
    const run = start(config);
    await settled(venue, run);
    venue.position = dec.ZERO;
    venue.push("orders", { id: "someone-elses-order" });
    assert.equal(await run.done, EXIT_OK);
    assert.equal(venue.deletes.length, 2);
  });
});

test("live refuses to start with cancel-on-disconnect active, and sends nothing", async () => {
  await withVenue(async (venue, config) => {
    venue.codActive = true;
    const run = start(config);
    assert.equal(await run.done, EXIT_REFUSED);
    assert.equal(venue.posts.length, 0);
    assert.ok(run.lines.some((l) => l.includes("cancel-on-disconnect is active")));
  });
});
