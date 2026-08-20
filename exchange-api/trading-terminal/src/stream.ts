// The WebSocket half: the `op`-envelope protocol, by hand.
//
// Protocol, in full. Every frame in both directions is a JSON object tagged
// with `op`:
//
//   → {"op":"subscribe","channel":"book","market":"BTC-USDX-PERP","since":42}
//   → {"op":"unsubscribe","channel":"book","market":"BTC-USDX-PERP"}
//   ← {"op":"subscribed","channel":"book","market":"…","seq_at_join":42}
//   ← {"op":"event","channel":"book","market":"…","seq":43,"payload":{…}}
//   ← {"op":"out_of_sync","channel":"book","market":"…","oldest_seq":100}
//   ← {"op":"error","message":"…"}
//
// The connection itself is authenticated, *including* for public channels: the
// upgrade requires a `?token=` minted by `POST /ws/token`. Those tokens are
// single-use and live 60 seconds, so one is minted per connection attempt and
// never reused — a cached token is a guaranteed failed reconnect.
//
// Concurrency
// -----------
// Node is single-threaded, so nothing here can deadlock on a lock — there are
// no locks. The two hazards that are real in an async client like this one are
// both handled explicitly:
//
//   * **Stale callbacks.** A socket we have already replaced can still fire its
//     `onclose` after we built the next one. Every handler is fenced behind
//     `this.socket === socket`, so a dead connection cannot drive a second
//     reconnect loop and end up with two live sockets.
//
//   * **A silently half-open connection.** TCP will not tell you the peer went
//     away; `onclose` simply never fires and the app waits forever on a socket
//     that will never deliver again. A liveness watchdog treats a long silence
//     as a death and forces the reconnect that the socket declined to trigger.
//
//   * **Redelivery across a reconnect.** A resubscribe is a *join*, and a join
//     can hand back frames that were already delivered on the previous
//     connection — either because we asked for a replay with `since`, or
//     because the server chose to backfill from its own buffer. An event
//     stream is not idempotent at the consumer: rendering the same `fills`
//     frame twice is a fill that never happened. So the sequence gate below
//     drops any frame that does not advance its channel, and it lives *here*
//     rather than in each consumer — a fifth channel added by a reader is
//     protected without having to know that it needed to be.
//
// Reconnects use exponential backoff with equal jitter, and give up after a
// bounded number of consecutive failures rather than spinning forever against
// an endpoint that is not there — `index.ts` then falls back to REST polling.

import { ApiError } from "./rest.js";
import type { RestClient } from "./rest.js";

export interface Subscription {
  readonly channel: string;
  readonly market?: string;
}

export type StreamEvent =
  | { readonly type: "open" }
  | { readonly type: "closed"; readonly reason: string }
  | {
      readonly type: "subscribed";
      readonly channel: string;
      readonly market: string | undefined;
      /** `seq_at_join`, or `null` when the server did not send one. */
      readonly seq: bigint | null;
    }
  | {
      readonly type: "event";
      readonly channel: string;
      readonly market: string | undefined;
      readonly seq: bigint;
      readonly payload: unknown;
    }
  | { readonly type: "gap"; readonly channel: string; readonly market: string | undefined }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "gave-up"; readonly message: string };

/** Silence longer than this means the socket is dead, whatever it claims. */
const LIVENESS_TIMEOUT_MS = 45_000;

/**
 * How long a connection must survive before it counts as having worked.
 *
 * Resetting the failure count the moment a socket opens looks right and is not:
 * a server that completes the upgrade and then drops the connection — a token
 * the socket layer accepted and the application layer refused, say — would
 * reset the backoff on every attempt, turning the reconnect loop into a hot
 * loop that never escalates and never gives up. Only a connection that stayed
 * up counts.
 */
const MIN_STABLE_CONNECTION_MS = 30_000;

/**
 * Consecutive suppressed frames on a channel before the gate assumes it is
 * wrong rather than the server.
 *
 * The gate never lowers its high-water mark, which is what makes it a reliable
 * duplicate filter — but it also means that if a server ever restarts its
 * sequence numbering, every subsequent frame would score as a duplicate and the
 * channel would go silent *while still receiving traffic*: the liveness
 * watchdog counts frames arriving, not frames delivered, so nothing else here
 * would notice. So a long run of suppressions is treated as evidence that the
 * numbering changed underneath us — the gate resets and signals a gap, which
 * puts the consumer back on a REST snapshot. A handful of redelivered frames
 * after a reconnect is the common case and stays suppressed; a channel wedged
 * forever is not a failure mode worth trading for it.
 */
const MAX_SUPPRESSED_FRAMES = 64;

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** Consecutive failed connections before we stop trying. */
const MAX_CONSECUTIVE_FAILURES = 6;

/** Coerce an untrusted `seq` to a non-negative bigint, or `null`. */
function toSeq(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  // Decimal strings matter: `seq` is a u64 server-side, and values past 2^53
  // arrive as strings precisely so they survive JSON intact.
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

export class MarketStream {
  private socket: WebSocket | null = null;
  private closed = false;
  /** Fences the async window between deciding to connect and having a socket. */
  private connecting = false;
  private failures = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  /** When the current socket opened, or 0. See `MIN_STABLE_CONNECTION_MS`. */
  private openedAt = 0;
  /**
   * Subscriptions by channel, for routing.
   *
   * One subscription per channel is an invariant of this class, and the
   * sequence gate is keyed on it: `seq` is monotonic per (channel, market), so
   * two subscriptions to one channel on different markets would share a gate
   * and starve each other. The constructor refuses that rather than letting it
   * become a silent data-loss bug in whatever a reader builds next.
   */
  private readonly byChannel: Map<string, Subscription>;
  /**
   * Highest `seq` accepted per channel. A frame at or below it has been
   * delivered before, and must not reach the consumer a second time.
   */
  private readonly seqFloor = new Map<string, bigint>();
  /** The `since` cursor last sent for a channel, or `null` if none was. */
  private readonly sentCursor = new Map<string, bigint | null>();
  /** Consecutive frames dropped per channel. See `MAX_SUPPRESSED_FRAMES`. */
  private readonly suppressed = new Map<string, number>();

  constructor(
    private readonly url: string,
    private readonly rest: RestClient,
    private readonly subscriptions: readonly Subscription[],
    /** Resume cursor for a channel, or `null` to resume from the live edge. */
    private readonly cursorFor: (sub: Subscription) => bigint | null,
    private readonly emit: (event: StreamEvent) => void,
    private readonly shutdownSignal: AbortSignal,
  ) {
    this.byChannel = new Map();
    for (const sub of subscriptions) {
      if (this.byChannel.has(sub.channel)) {
        throw new Error(
          `duplicate subscription to channel "${sub.channel}": this client ` +
            "keeps one sequence cursor per channel, so two would collide",
        );
      }
      this.byChannel.set(sub.channel, sub);
    }
  }

  start(): void {
    if (this.closed) return;
    void this.connect();
  }

  /** Tear everything down. Idempotent, and safe to call from a signal handler. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer("reconnect");
    this.clearTimer("liveness");
    this.dropSocket(1000, "client shutting down");
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.socket !== null) return;
    this.connecting = true;
    try {
      let token: string;
      try {
        token = await this.mintToken();
      } catch (error) {
        // A revoked key or a wrong secret answers `401` every time. Backing off
        // and asking again five more times cannot change the answer — it just
        // delays the fallback and fills the log with the same line. Anything the
        // server marked non-transient is fatal for the stream immediately.
        const permanent = error instanceof ApiError && !error.transient;
        this.onFailure(
          `could not mint a WebSocket token: ${describe(error)}`,
          permanent,
        );
        return;
      }

      // Minting is an await, and the app may have shut down inside it. Opening
      // a socket now would orphan it.
      if (this.closed || this.shutdownSignal.aborted) return;

      const separator = this.url.includes("?") ? "&" : "?";
      const target = `${this.url}${separator}token=${encodeURIComponent(token)}`;

      let socket: WebSocket;
      try {
        socket = new WebSocket(target);
      } catch (error) {
        this.onFailure(`could not open the socket: ${describe(error)}`);
        return;
      }
      this.socket = socket;
      this.attach(socket);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Mint a single-use upgrade token.
   *
   * `/ws/token` has no `/api/v1` variant, so it is signed as the bare path —
   * see the prefix discussion in `signing.ts`.
   */
  private async mintToken(): Promise<string> {
    const response = await this.rest.request<{ token?: unknown }>({
      method: "POST",
      path: "/ws/token",
      signed: true,
      // Safe to repeat: a token nobody connects with simply expires in 60s.
      idempotent: true,
    });
    const token = response.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("POST /ws/token returned no token");
    }
    return token;
  }

  private attach(socket: WebSocket): void {
    // Every handler starts by checking it is still the live socket. Without
    // this fence a stale `onclose` schedules a second reconnect loop, and from
    // then on the client has two sockets racing to be `this.socket`.
    socket.onopen = () => {
      if (this.socket !== socket) return void safeClose(socket);
      if (this.closed) return void safeClose(socket);
      this.openedAt = Date.now();
      this.emit({ type: "open" });
      this.armLiveness();
      for (const sub of this.subscriptions) this.sendSubscribe(socket, sub);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      // Any frame at all is proof of life, including one we cannot parse.
      this.armLiveness();
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // Not JSON. Nothing to route, and not worth dying over.
      }
      try {
        this.route(parsed);
      } catch (error) {
        // A malformed-but-parseable frame, or a throwing consumer, must never
        // escape `onmessage` — an unhandled rejection there kills the process.
        this.emit({ type: "error", message: describe(error) });
      }
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      // Per the WHATWG spec `onclose` follows `onerror`; just make sure the
      // socket really closes so the reconnect path runs.
      safeClose(socket);
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      detach(socket);
      this.clearTimer("liveness");
      // A connection that did real work earns a fresh backoff; one that died on
      // arrival does not. See `MIN_STABLE_CONNECTION_MS`.
      const uptime = this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
      this.openedAt = 0;
      if (uptime >= MIN_STABLE_CONNECTION_MS) this.failures = 0;
      if (this.closed) return;
      const reason = event.reason || `code ${event.code}`;
      this.emit({ type: "closed", reason });
      // Any resumed subscription may now have a hole in it: whatever the server
      // buffered while we were away, we did not see. Say so, and let the
      // consumer re-snapshot rather than trusting accumulated state.
      for (const sub of this.subscriptions) {
        this.emit({ type: "gap", channel: sub.channel, market: sub.market });
      }
      this.onFailure(`connection closed: ${reason}`);
    };
  }

  private route(frame: unknown): void {
    if (frame === null || typeof frame !== "object") return;
    const message = frame as Record<string, unknown>;
    const op = message["op"];
    if (typeof op !== "string") return;

    const channel = typeof message["channel"] === "string" ? message["channel"] : null;
    const market =
      typeof message["market"] === "string" ? message["market"] : undefined;

    switch (op) {
      case "subscribed": {
        if (channel === null) return;
        const seqAtJoin = toSeq(message["seq_at_join"]);
        // Where this join says the channel starts: the cursor we asked to
        // resume from if we sent one, otherwise the server's live edge.
        //
        // It can only ever *raise* the gate. A rejoin that announces a point
        // below what we have already delivered is the exact shape of the
        // redelivery bug — a server backfilling from its own checkpoint, which
        // is behind ours because nothing acknowledges frames — and honouring it
        // would hand the consumer fills it has already seen. Recovery from a
        // genuinely restarted numbering is handled by the suppression counter
        // instead, where it does not cost duplicate suppression to have.
        const proposed = this.sentCursor.get(channel) ?? seqAtJoin;
        if (proposed !== null) {
          const current = this.seqFloor.get(channel);
          this.seqFloor.set(
            channel,
            current === undefined || proposed > current ? proposed : current,
          );
        }
        this.emit({ type: "subscribed", channel, market, seq: seqAtJoin });
        return;
      }
      case "event": {
        if (channel === null) return;
        const seq = toSeq(message["seq"]);
        if (seq === null) return;
        const sub = this.byChannel.get(channel);
        // Not a channel we asked for. Nothing downstream has state for it.
        if (sub === undefined) return;
        // A market-scoped subscription must not be fed another market's frames:
        // applying someone else's book to this one's state is wrong in a way
        // that still looks like a working dashboard. A frame that names no
        // market is the server declining to echo it, not a mismatch.
        if (sub.market !== undefined && market !== undefined && market !== sub.market) {
          return;
        }
        // The gate. A frame that does not advance the channel has been seen
        // before — dropped silently, because redelivery is a normal thing for a
        // resubscribe to do and logging it would be noise, not news.
        const floor = this.seqFloor.get(channel);
        if (floor !== undefined && seq <= floor) {
          const dropped = (this.suppressed.get(channel) ?? 0) + 1;
          if (dropped < MAX_SUPPRESSED_FRAMES) {
            this.suppressed.set(channel, dropped);
            return;
          }
          // Long past the point where this could be a reconnect's backfill.
          // Assume the numbering, not the data, is what changed: reset the gate
          // and tell the consumer its accumulated state is no longer trustworthy.
          this.suppressed.delete(channel);
          this.seqFloor.delete(channel);
          this.emit({
            type: "error",
            message:
              `${channel}: ${dropped} consecutive frames at or below seq ` +
              `${floor} — the server's sequence numbering appears to have ` +
              "restarted; resetting the duplicate filter",
          });
          this.emit({ type: "gap", channel, market });
        }
        this.suppressed.delete(channel);
        this.seqFloor.set(channel, seq);
        this.emit({
          type: "event",
          channel,
          market,
          seq,
          payload: message["payload"],
        });
        return;
      }
      case "out_of_sync": {
        if (channel === null) return;
        this.emit({ type: "gap", channel, market });
        return;
      }
      case "error": {
        const text = message["message"];
        this.emit({
          type: "error",
          message: typeof text === "string" ? text : "unspecified server error",
        });
        return;
      }
      default:
        // `unsubscribed`, and any op a later API version adds. Ignoring an
        // unknown op is the forward-compatible choice.
        return;
    }
  }

  private sendSubscribe(socket: WebSocket, sub: Subscription): void {
    const frame: Record<string, unknown> = {
      op: "subscribe",
      channel: sub.channel,
    };
    if (sub.market !== undefined) frame["market"] = sub.market;
    const cursor = this.cursorFor(sub);
    // Ask the server to replay from where we stopped. `seq` is a u64; anything
    // past the safe-integer range would be mangled by JSON, so it is simply not
    // sent and the stream resumes live — a small gap, correctly signalled,
    // beats a cursor the server reads as a different number.
    const sent =
      cursor !== null && cursor > 0n && cursor <= BigInt(Number.MAX_SAFE_INTEGER)
        ? cursor
        : null;
    if (sent !== null) frame["since"] = Number(sent);
    // Remembered so `subscribed` can put the gate exactly where this asked to
    // resume from, rather than inferring it from the server's live edge.
    this.sentCursor.set(sub.channel, sent);
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // Lost a race with a close. `onclose` drives the reconnect.
    }
  }

  /**
   * (Re)arm the silence watchdog.
   *
   * A connection that stops delivering without closing is indistinguishable
   * from a healthy idle one at the socket layer, so it has to be distinguished
   * here — by deciding that silence past a threshold means death.
   */
  private armLiveness(): void {
    this.clearTimer("liveness");
    if (this.closed) return;
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.closed || this.socket === null) return;
      this.emit({
        type: "error",
        message: `no frames for ${LIVENESS_TIMEOUT_MS / 1000}s — treating the connection as dead`,
      });
      // Closing triggers `onclose`, which is the one place reconnects are
      // scheduled. Keeping that single path is what stops two from racing.
      this.dropSocketToReconnect();
    }, LIVENESS_TIMEOUT_MS);
    // Do not hold the event loop open for a timer that is only a safety net.
    this.livenessTimer.unref();
  }

  private onFailure(message: string, permanent = false): void {
    if (this.closed) return;
    this.failures += 1;
    if (permanent || this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.closed = true;
      this.clearTimer("reconnect");
      this.clearTimer("liveness");
      this.emit({
        type: "gave-up",
        message: permanent
          ? `${message} (not retryable)`
          : `${message} (gave up after ${this.failures} attempts)`,
      });
      return;
    }
    this.emit({ type: "error", message });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const ceiling = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** (this.failures - 1),
    );
    // Equal jitter: bounded to [ceiling/2, ceiling], so never zero (no busy
    // loop) and never synchronised across clients (no thundering herd).
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Close the current socket so `onclose` runs the normal reconnect path. */
  private dropSocketToReconnect(): void {
    const socket = this.socket;
    if (socket === null) return;
    safeClose(socket, 4000, "liveness timeout");
  }

  private dropSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    detach(socket);
    safeClose(socket, code, reason);
  }

  private clearTimer(which: "reconnect" | "liveness"): void {
    const timer = which === "reconnect" ? this.reconnectTimer : this.livenessTimer;
    if (timer !== null) clearTimeout(timer);
    if (which === "reconnect") this.reconnectTimer = null;
    else this.livenessTimer = null;
  }
}

function detach(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

function safeClose(socket: WebSocket, code?: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing or closed. Nothing to do.
  }
}

/**
 * One readable line from a thrown value, with any upgrade token removed.
 *
 * The token lives in the connection URL, and a `WebSocket` constructor or DNS
 * error is entirely likely to quote that URL back. A live credential in a log
 * line is a credential you have to rotate, so it is scrubbed on the way out
 * rather than trusted not to appear.
 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/([?&]token=)[^&\s]*/gi, "$1<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
