// The doomed trading session.
//
// This process is spawned by `index.ts` and is meant to be killed. It opens the
// authenticated WebSocket that cancel-on-disconnect keys off, places one
// resting order, tells its parent the order id, and then does nothing at all
// until it is SIGKILLed.
//
// **There is deliberately no cleanup in here.** No `finally`, no signal
// handler, no `process.on("exit")`. That absence is the entire point: the whole
// catalog already shows a write example cancelling its own orders on the way
// out, and this example exists for the case where there is no way out. A
// `finally` block here would make a successful demonstration prove the wrong
// thing — you would be watching this process tidy up, not the venue.
//
// SIGKILL cannot be caught anyway, so the absence is belt and braces: it also
// keeps an accidental Ctrl-C (SIGINT, which *is* catchable) from turning into a
// polite shutdown that quietly cancels the order.
//
// It is not run directly. `npm start -- --live` runs the supervisor, which
// spawns this.

import { createWsClient } from "@nexus-xyz/exchange-ts";
import type { WsClient } from "@nexus-xyz/exchange-ts";

import { loadConfig } from "./config.js";
import { planRestingOrder } from "./plan.js";
import { buildClient, describe } from "./venue.js";

/**
 * Messages the session sends its parent, one JSON object per line on stdout.
 *
 * stdout is the machine channel and stderr is the human one, which is why the
 * two are split rather than tagged: the parent parses one and forwards the
 * other. A log line that happened to look like JSON could otherwise be read as
 * a protocol message, and the protocol message that matters here carries the id
 * of a live order.
 */
export type SessionMessage =
  | { readonly event: "ws-open"; readonly url: string }
  | { readonly event: "resting"; readonly orderId: string; readonly marketId: string }
  | { readonly event: "failed"; readonly message: string };

/** How long to wait for the socket to reach `open` before giving up. */
const WS_OPEN_TIMEOUT_MS = 20_000;
const WS_POLL_MS = 100;

function send(message: SessionMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Wait for the socket to actually be open.
 *
 * Worth being strict about. `createWsClient` connects in the background, so
 * placing an order the moment it returns would rest the order with no
 * connection for the venue to watch — and if the connection then never came up,
 * the run would "pass" for the wrong reason, on a run where COD had nothing to
 * key off. `status()` reaching `"open"` means the upgrade succeeded, and the
 * upgrade only succeeds with a valid token, so this is also the point at which
 * the session is known to be *authenticated* and not merely connected.
 *
 * **Call this after subscribing, never before.** `createWsClient` does not open
 * a socket until something wants one: the client starts in `"closed"` and the
 * first `subscribe()` is what triggers the connect. Polling for `"open"` before
 * that either spins until the timeout or — if `"closed"` is read as a failure —
 * fails instantly on every run. Every non-`"open"` state is tolerated here
 * until the deadline for the same reason: a failed attempt passes back through
 * `"closed"` on its way to `"reconnecting"`, and treating that instant as
 * terminal would abandon a connection that was about to succeed.
 */
async function waitForOpen(ws: WsClient, url: string): Promise<void> {
  const deadline = Date.now() + WS_OPEN_TIMEOUT_MS;
  for (;;) {
    const status = ws.status();
    if (status === "open") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `the WebSocket at ${url}/ws was still "${status}" after ${WS_OPEN_TIMEOUT_MS / 1000}s. ` +
          `Check the credentials, and check NEXUS_EXCHANGE_WS_URL — the stream path is part ` +
          `of the deployment prefix, and the bare origin 404s.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WS_POLL_MS));
  }
}

async function main(): Promise<void> {
  // The session takes no arguments of its own: it reads the same environment
  // the supervisor did, so the two cannot disagree about which deployment,
  // market or price this is. Anything that must vary between them would be a
  // reason for them to be looking at different orders.
  // No credential re-check here: `Config.apiKey` and `.apiSecret` are
  // `readonly string`, and `loadConfig` throws before returning if either is
  // missing. The guard that used to sit here compared them to `undefined`,
  // which the types make unreachable (@nvizble, #20) — a check that cannot
  // fire reads as protection and is not.
  const config = loadConfig([]);

  const client = buildClient(config);

  // `wsTokenProvider()` rather than a token minted once. Tokens are single-use
  // and expire in 60 seconds, so a cached one is a session that comes back
  // unauthenticated after the first reconnect — and an unauthenticated session
  // is one COD is no longer watching. The provider is called on every
  // (re)connect, which is exactly the lifetime a ws token has.
  //
  // Tokens are also network-scoped: this one is minted by `client`, against the
  // same deployment the socket below connects to, because they are built from
  // one config.
  const ws = createWsClient({
    url: config.wsUrl,
    tokenProvider: client.wsTokenProvider(),
  });

  // Subscribe first, then wait: the client does not open a socket until
  // something wants one, so this call is what starts the connection. The
  // channel choice is not what arms COD — the venue keys off the connection's
  // resolved owner, not off any subscription — but the private `orders` channel
  // is how a real session would learn its order rested, and attaching to it
  // makes "this is an authenticated connection" a demonstrated fact rather than
  // an assertion.
  const orders = ws.subscribe("orders");

  try {
    await waitForOpen(ws, config.wsUrl);
  } catch (error) {
    orders.unsubscribe();
    ws.close();
    throw error;
  }
  log(`ws open at ${config.wsUrl}/ws — this is the connection COD watches`);
  send({ event: "ws-open", url: config.wsUrl });

  void (async () => {
    for await (const event of orders.events) {
      if (event.outOfSync) {
        log("orders stream lost continuity");
        continue;
      }
      log(`orders event seq=${event.seq}`);
    }
  })();

  const markets = await client.fetchMarkets();
  const market = markets.find((m) => m.market_id === config.market);
  if (market === undefined) {
    throw new Error(
      `market ${config.market} not found. Available: ${markets.map((m) => m.market_id).join(", ")}`,
    );
  }
  const mark = await client.fetchMarkPrice(config.market);
  const plan = planRestingOrder(market, mark, config.priceOffsetBps);

  const placed = await client.placeOrder(plan.order);
  log(`placed ${placed.order.id} status=${placed.order.status}`);
  if (placed.fills.length > 0) {
    // A `PostOnly` order the engine crossed would be a venue bug, but reporting
    // the fills rather than ignoring them is what lets the supervisor say so
    // instead of reporting a missing order as a successful cancel.
    log(`WARNING: the order reported ${placed.fills.length} immediate fill(s)`);
  }
  send({ event: "resting", orderId: placed.order.id, marketId: placed.order.market_id });

  // And now: nothing. No timer that would eventually exit, no cleanup path, no
  // signal handler. The socket stays open and this process waits to be killed.
  // `setInterval` is only here to keep the event loop alive — the WebSocket
  // would do that on its own, but relying on that would make the demonstration
  // depend on an implementation detail of the SDK's socket handling.
  log("session is idle and holding the socket. Waiting to be killed.");
  setInterval(() => {}, 1 << 30);
}

try {
  await main();
} catch (error) {
  // The one thing the session does report is its own failure to get started,
  // because a supervisor that cannot tell "the session died before placing"
  // from "the session placed and was killed" would clean up the wrong thing.
  send({ event: "failed", message: describe(error) });
  process.exit(1);
}
