// A terminal trading desk on the Nexus Exchange, built on the raw API.
//
// Run it with:  npm start            (read-only dashboard)
//               npm start -- --trade (also rests one order, and cancels it)
//
// This file is the wiring and the lifecycle. The interesting decisions live in
// the modules it composes: `signing.ts` (the HMAC scheme), `rest.ts` (the
// hardened request path), `stream.ts` (the WebSocket protocol), `book.ts`
// (when market data may be trusted) and `trader.ts` (the write path).
//
// The one lifecycle rule worth stating up front: **nothing this process
// creates may outlive it.** Every exit route — a clean Ctrl-C, a second
// impatient Ctrl-C, a `SIGTERM`, an uncaught exception, an unhandled rejection
// — converges on the same shutdown, which cancels orders under a deadline and
// then leaves. An exit path that skips that is how an example leaves a live
// order resting on someone's account.

import * as dec from "./decimal.js";
import { OrderBookState, parseBook } from "./book.js";
import { loadConfig } from "./config.js";
import { ApiError, MissingCredentialsError, RestClient, sleep } from "./rest.js";
import { MarketStream } from "./stream.js";
import { Trader } from "./trader.js";
import type { Config } from "./config.js";
import type { MarketSpec } from "./trader.js";
import type { StreamEvent, Subscription } from "./stream.js";

/** How often the REST fallback re-reads the book when there is no stream. */
const POLL_INTERVAL_MS = 2_000;
/** Floor on re-snapshots, so a stream of bad frames cannot become a REST flood. */
const MIN_RESNAPSHOT_INTERVAL_MS = 1_000;
/** Upper bound on the whole shutdown, after which we stop being polite. */
const SHUTDOWN_DEADLINE_MS = 12_000;

function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`${stamp}  ${message}`);
}

function warn(message: string): void {
  log(`⚠  ${message}`);
}

/** Read a `Decimal` field from an untrusted object, with a documented fallback. */
function decimalField(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): dec.Dec {
  const raw = source[key];
  if (typeof raw === "string") {
    try {
      return dec.fromString(raw);
    } catch {
      // Fall through: an unparseable tick size is a reason to use a safe
      // default, not a reason to crash the dashboard.
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return dec.fromString(String(raw));
  }
  return dec.fromString(fallback);
}

/**
 * Resolve the market's trading rules from `GET /markets/summary`.
 *
 * The live response carries `tick_size`, `lot_size` and the size bounds. They
 * are read defensively — the spec's own `MarketSummary` schema does not promise
 * them, so a deployment that omits one must degrade rather than crash.
 */
async function loadMarketSpec(
  rest: RestClient,
  market: string,
): Promise<MarketSpec> {
  const summaries = await rest.request<unknown>({
    method: "GET",
    path: "/api/v1/markets/summary",
    idempotent: true,
  });
  if (!Array.isArray(summaries)) {
    throw new Error("GET /api/v1/markets/summary did not return a list");
  }
  const entry = summaries.find(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["market_id"] === market,
  );
  if (entry === undefined) {
    const names = summaries
      .map((item) =>
        item !== null && typeof item === "object"
          ? String((item as Record<string, unknown>)["market_id"])
          : "?",
      )
      .slice(0, 8)
      .join(", ");
    throw new Error(`market ${market} not found. Available include: ${names}…`);
  }

  return {
    marketId: market,
    tickSize: decimalField(entry, "tick_size", "0.01"),
    lotSize: decimalField(entry, "lot_size", "0.001"),
    minOrderSize: decimalField(entry, "min_order_size", "0.001"),
    maxOrderSize: decimalField(entry, "max_order_size", "1000"),
    halted: entry["status"] === "halted",
  };
}

async function fetchBookSnapshot(
  rest: RestClient,
  market: string,
): Promise<ReturnType<typeof parseBook>> {
  const raw = await rest.request<unknown>({
    method: "GET",
    path: `/api/v1/markets/${encodeURIComponent(market)}/orderbook`,
    idempotent: true,
  });
  return parseBook(raw);
}

/** Describe the target in one line, so nobody has to guess whose money this is. */
function describeTarget(config: Config): string {
  const funds =
    config.funds === "play"
      ? "play funds"
      : `funds="${config.funds}" — NOT declared play money`;
  return `${config.baseUrl} (${funds})`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));

  // Shutdown is two stages, and the distinction is load-bearing.
  //
  // `stopping` means "start no new work": the poll loop stops looping, the
  // stream stops reconnecting, sleeps unwind. `halted` means "no more requests
  // at all", and is tripped only once teardown is finished or out of time.
  //
  // Collapsing these into one signal is a bug I had to write before I saw it: if
  // the REST client watches the same signal that Ctrl-C trips, then the very
  // first thing shutdown does is guarantee that the cancel-the-order request
  // cannot be sent. The teardown path has to outlive the stop signal, or it is
  // decoration — so the request path watches `halted`, and everything that
  // loops watches `stopping`.
  const stopping = new AbortController();
  const halted = new AbortController();
  const rest = new RestClient(config, halted.signal, warn);

  // Checked before any network call: a run that cannot do what was asked
  // should fail on the spot, not three requests into looking useful.
  if (config.tradingEnabled && !rest.hasCredentials) {
    throw new MissingCredentialsError("--trade");
  }

  log(`Nexus Exchange trading terminal — ${describeTarget(config)}`);
  log(`market: ${config.market}`);

  if (config.funds !== "play") {
    warn(
      "this target has not declared itself as play funds. Read-only paths " +
        "still work; trading is refused. Set NEXUS_EXCHANGE_FUNDS=play only " +
        "if you are certain.",
    );
  }

  const spec = await loadMarketSpec(rest, config.market);
  log(
    `tick=${dec.toString(spec.tickSize)} lot=${dec.toString(spec.lotSize)} ` +
      `size=[${dec.toString(spec.minOrderSize)}, ${dec.toString(spec.maxOrderSize)}]` +
      `${spec.halted ? " — HALTED" : ""}`,
  );

  const book = new OrderBookState(config.market, spec.tickSize);
  const trader = new Trader(config, rest, spec, log);

  // ── Shutdown, from every direction ────────────────────────────────────────

  let tearingDown = false;
  let stream: MarketStream | null = null;
  /**
   * The one timer deliberately *not* unref'd, so it — and nothing else — is
   * what holds the event loop open. Every other timer here is a safety net, and
   * a safety net should never be the reason a process refuses to exit.
   */
  let renderTimer: NodeJS.Timeout | null = null;

  const stop = async (reason: string, code: number): Promise<never> => {
    if (tearingDown) {
      // The user asked twice. Stop waiting on the exchange and go, but say
      // plainly what that costs — this is the one exit that can leave an order.
      console.log("\nforcing exit — orders may still be resting");
      process.exit(130);
    }
    tearingDown = true;
    log(`shutting down (${reason})`);
    // Stage one: stop new work. The request path is untouched, so the cancel
    // below can still reach the exchange.
    stopping.abort(new Error(`shutting down: ${reason}`));
    stream?.close();
    if (renderTimer !== null) clearInterval(renderTimer);

    // Not unref'd: this deadline is the guarantee that shutdown terminates, so
    // it must be able to hold the loop open long enough to fire.
    const deadline = setTimeout(() => {
      console.error("shutdown exceeded its deadline — exiting anyway");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);

    try {
      await trader.shutdown();
    } catch (error) {
      console.error(`shutdown error: ${describe(error)}`);
    }
    clearTimeout(deadline);
    // Stage two: nothing else may talk to the exchange.
    halted.abort(new Error("halted"));
    process.exit(code);
  };

  process.on("SIGINT", () => void stop("SIGINT", 0));
  process.on("SIGTERM", () => void stop("SIGTERM", 0));
  // An unhandled failure anywhere must still cancel. Leaving an order resting
  // because of a rendering bug would be an absurd way to lose money.
  process.on("uncaughtException", (error) => {
    console.error(`uncaught exception: ${String(error)}`);
    void stop("uncaught exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`unhandled rejection: ${String(reason)}`);
    void stop("unhandled rejection", 1);
  });

  // ── Market data ───────────────────────────────────────────────────────────

  // Single-flight plus a floor on frequency. Without the first, a burst of gap
  // signals starts a burst of snapshots; without the second, a channel that
  // never produces a shape we recognise turns into a REST hot loop.
  let snapshotInFlight: Promise<void> | null = null;
  let lastSnapshotAt = 0;
  // Both the "no stream configured" path and the "stream gave up" path start
  // the poll loop, and a stream can give up more than once in principle. One
  // flag keeps there being exactly one loop.
  let polling = false;

  const resnapshot = (why: string): Promise<void> => {
    if (snapshotInFlight !== null) return snapshotInFlight;
    const wait = Math.max(
      0,
      MIN_RESNAPSHOT_INTERVAL_MS - (Date.now() - lastSnapshotAt),
    );
    const run = (async () => {
      try {
        if (wait > 0) await sleep(wait, stopping.signal);
        const parsed = await fetchBookSnapshot(rest, config.market);
        if (parsed === null) {
          warn("order-book snapshot was not in a shape this app understands");
          return;
        }
        book.applySnapshot(parsed);
        // The snapshot supersedes anything the stream replayed, so the resume
        // cursor is meaningless now: ask for the live edge next time rather
        // than for frames that predate what we just fetched.
        book.resetCursor();
      } catch (error) {
        if (stopping.signal.aborted) return;
        warn(`snapshot failed (${why}): ${describe(error)}`);
      } finally {
        // Stamped on the way out, success or not, so a *failing* snapshot is
        // throttled too. Timing only the successes would let a persistent
        // failure retry as fast as the caller asks.
        lastSnapshotAt = Date.now();
        snapshotInFlight = null;
      }
    })();
    snapshotInFlight = run;
    return run;
  };

  await resnapshot("initial");

  const streamable = config.wsUrl !== null && rest.hasCredentials;
  if (streamable && config.wsUrl !== null) {
    const subscriptions: Subscription[] = [
      { channel: "book", market: config.market },
      { channel: "trades", market: config.market },
      { channel: "fills" },
      { channel: "orders" },
    ];
    stream = new MarketStream(
      config.wsUrl,
      rest,
      subscriptions,
      (sub) => (sub.channel === "book" ? book.resumeCursor : null),
      (event) => onStreamEvent(event),
      stopping.signal,
    );
    stream.start();
    log(`streaming from ${config.wsUrl}`);
  } else {
    explainNoStream(rest);
    void pollLoop();
  }

  function onStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case "open":
        log("stream connected");
        // A fresh connection has no continuity with the last one. Re-snapshot
        // rather than assume the replay covered the gap.
        void resnapshot("reconnected");
        return;
      case "closed":
        warn(`stream closed: ${event.reason}`);
        book.markGap();
        return;
      case "subscribed":
        return;
      case "gap":
        book.markGap();
        book.resetCursor();
        void resnapshot(`gap on ${event.channel}`);
        return;
      case "event":
        onChannelEvent(event.channel, event.seq, event.payload);
        return;
      case "error":
        warn(`stream: ${event.message}`);
        return;
      case "gave-up":
        warn(`${event.message} — falling back to REST polling`);
        book.markGap();
        void pollLoop();
        return;
    }
  }

  function onChannelEvent(channel: string, seq: bigint, payload: unknown): void {
    if (channel === "book") {
      const outcome = book.applyFrame(seq, payload);
      if (outcome === "unrecognised") {
        // The `book` payload is forwarded verbatim by the API and is not pinned
        // by the spec, so this is an expected branch, not a failure. Re-snapshot
        // (throttled) and keep going.
        void resnapshot("unrecognised book frame");
      }
      return;
    }
    if (channel === "fills") {
      renderFill(payload);
      return;
    }
    if (channel === "orders") {
      renderOrderUpdate(payload);
    }
  }

  async function pollLoop(): Promise<void> {
    if (polling) return;
    polling = true;
    while (!stopping.signal.aborted) {
      try {
        await sleep(POLL_INTERVAL_MS, stopping.signal);
      } catch {
        return; // Aborted mid-sleep: that is the exit.
      }
      if (stopping.signal.aborted) return;
      await resnapshot("poll");
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  let lastRendered = "";
  const render = (): void => {
    const top = book.top();
    if (top === null) {
      return;
    }
    const fresh = book.isFresh();
    const spread = top.ask.price - top.bid.price;
    // Display only, so plain `toFixed` on the wire's doubles is fine here —
    // it just lines the columns up on the market's own tick precision. Every
    // number that becomes an order goes through `decimal.ts` instead.
    const ticks = spec.tickSize.scale;
    // Only shown with `--trade`, and only the id's first segment: enough to
    // match against the exchange's own UI without filling the line with a UUID.
    const resting = trader.restingOrderId;
    const orderNote = !config.tradingEnabled
      ? ""
      : `  order ${resting === null ? (trader.isPlacing ? "sending…" : "none") : resting.slice(0, 8)}`;
    const line =
      `${config.market}  bid ${top.bid.price.toFixed(ticks)} × ${top.bid.size}  ` +
      `ask ${top.ask.price.toFixed(ticks)} × ${top.ask.size}  ` +
      `mid ${dec.toString(top.mid)}  spread ${spread.toFixed(ticks)}  ` +
      `${fresh ? "live" : `STALE (${Math.round(book.ageMs / 1000)}s)`}${orderNote}`;
    if (line !== lastRendered) {
      lastRendered = line;
      log(line);
    }

    // The order is placed from the render tick because that is the only place
    // the book is known to be fresh *now*. `place` is idempotent by its own
    // guards, so calling it every tick is safe: it returns immediately once an
    // order rests or one is in flight.
    if (config.tradingEnabled && fresh && !tearingDown) {
      void trader.place(top);
    }
  };

  renderTimer = setInterval(render, 1_000);
  render();

  if (config.tradingEnabled) {
    log(
      `--trade: will rest one PostOnly Buy ${config.orderDistanceBps} bps below ` +
        "the mid, and cancel it on exit",
    );
  } else {
    log("read-only. Pass --trade to place (and cancel) one resting order.");
  }

  // Park until shutdown. The render interval is what holds the event loop open
  // (see `renderTimer`), so the process lives exactly as long as it is
  // rendering and exits promptly once `stop` clears it.
  await new Promise<void>((resolve) => {
    stopping.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function renderFill(payload: unknown): void {
  if (payload === null || typeof payload !== "object") return;
  const fill = payload as Record<string, unknown>;
  log(
    `FILL ${String(fill["side"] ?? "?")} ${String(fill["size"] ?? "?")} @ ` +
      `${String(fill["price"] ?? "?")} fee ${String(fill["fee"] ?? "?")} ` +
      `(${String(fill["taker_or_maker"] ?? "?")})`,
  );
}

function renderOrderUpdate(payload: unknown): void {
  if (payload === null || typeof payload !== "object") return;
  const order = payload as Record<string, unknown>;
  log(
    `ORDER ${String(order["status"] ?? "?")} ${String(order["side"] ?? "?")} ` +
      `${String(order["quantity"] ?? "?")} @ ${String(order["price"] ?? "?")}`,
  );
}

/** Say exactly why the stream is off, because "no live data" is not a diagnosis. */
function explainNoStream(rest: RestClient): void {
  if (!rest.hasCredentials) {
    log(
      "no credentials: polling public market data over REST. The WebSocket " +
        "upgrade needs a token from POST /ws/token, which is a signed call.",
    );
    return;
  }
  log(
    "NEXUS_EXCHANGE_WS_URL is not set: polling over REST instead. This app " +
      "will not guess a WebSocket origin — see the README's \"About the host\".",
  );
}

/**
 * One readable line from anything throwable.
 *
 * No length cap: by the time an error reaches here it has already been bounded
 * by `rest.ts`, and the tail of the message is where the actionable hint lives.
 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

try {
  await main();
} catch (error) {
  if (error instanceof MissingCredentialsError) {
    console.error(`\n${error.message}`);
    console.error("Copy .env.example to .env and add a testnet key.");
    process.exit(1);
  }
  if (error instanceof ApiError || error instanceof Error) {
    console.error(`\n${describe(error)}`);
    process.exit(1);
  }
  throw error;
}
