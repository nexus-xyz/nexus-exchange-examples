// The WebSocket half: one connection, kept alive, with nothing clever in it.
//
// This class moves frames and nothing else. It does not interpret them — that
// is `frames.ts` — and it does not decide what a lost connection means for the
// book — that is `index.ts`. What it owns is the connection lifecycle, and the
// three ways that lifecycle goes wrong in practice:
//
//   * **Stale callbacks.** A replaced socket can still fire `onclose` after the
//     next one is open. Every handler is fenced behind `this.socket === socket`,
//     so a dead connection cannot start a second reconnect loop.
//
//   * **Silence.** TCP will not tell you the peer went away, and a proxy in
//     front of the venue will not either — measured against testnet, an idle
//     `/stream` connection is dropped with a bare `1006` after ~30 s and no
//     close frame. So a watchdog decides: a book that the server republishes
//     every second has no business being quiet for ten, and a quiet connection
//     is closed and replaced rather than trusted.
//
//   * **Reconnect storms.** Exponential backoff with equal jitter, capped. It
//     never gives up: the stream is public and costs nothing to retry, unlike a
//     token-gated socket where every attempt spends a credential. Only a
//     connection that *delivered frames* and stayed up resets the backoff — one
//     that opens and then says nothing is a failure, however cleanly it opened.
//
// The subscribe dialect is picked from the URL: `GET /stream` reads exactly one
// untagged `{"subscribe": [...]}` on connect and ignores anything after it;
// a `/ws`-style endpoint takes one `op` envelope per channel.

export type StreamEvent =
  | { readonly type: "open"; readonly attempt: number }
  | { readonly type: "message"; readonly data: unknown }
  | { readonly type: "closed"; readonly reason: string; readonly uptimeMs: number; readonly frames: number }
  | { readonly type: "reconnecting"; readonly inMs: number; readonly attempt: number }
  | { readonly type: "silent"; readonly forMs: number };

/** No frame for this long means the connection is not delivering, whatever it claims. */
export const LIVENESS_TIMEOUT_MS = 10_000;
/** A connection must deliver and survive this long to count as having worked. */
const MIN_STABLE_CONNECTION_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class BookStream {
  private socket: WebSocket | null = null;
  private closed = false;
  private failures = 0;
  private attempts = 0;
  private openedAt = 0;
  private framesThisConnection = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly market: string,
    private readonly emit: (event: StreamEvent) => void,
  ) {}

  start(): void {
    this.connect();
  }

  /** Drop the current connection and resubscribe fresh — the `out_of_sync` remedy. */
  reconnectNow(reason: string): void {
    if (this.socket === null || this.closed) return;
    this.abandon(this.socket, reason);
  }

  /** Tear everything down. Idempotent, and safe to call from a signal handler. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      detach(socket);
      safeClose(socket, 1000, "client shutting down");
    }
  }

  private connect(): void {
    if (this.closed || this.socket !== null) return;
    this.attempts += 1;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.onClosed(`could not open: ${error instanceof Error ? error.message : String(error)}`, 0, 0);
      return;
    }
    this.socket = socket;
    this.framesThisConnection = 0;
    this.openedAt = 0;
    // The watchdog covers the handshake too: an upgrade that never completes
    // is as silent as a connection that stopped delivering.
    this.armLiveness();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = Date.now();
      this.emit({ type: "open", attempt: this.attempts });
      for (const frame of this.subscribeFrames()) {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // Lost a race with a close; `onclose` drives the reconnect.
        }
      }
      this.armLiveness();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.framesThisConnection += 1;
      this.armLiveness();
      if (typeof event.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // Not JSON: nothing to route, and not worth dying over.
      }
      this.emit({ type: "message", data });
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      // `onclose` follows `onerror`; make sure the socket really closes.
      safeClose(socket);
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      detach(socket);
      const uptime = this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
      this.onClosed(event.reason || `code ${event.code}`, uptime, this.framesThisConnection);
    };
  }

  private subscribeFrames(): unknown[] {
    const path = new URL(this.url).pathname.replace(/\/+$/, "");
    return path.endsWith("/ws")
      ? [{ op: "subscribe", channel: "book", market: this.market }]
      : [{ subscribe: [`book:${this.market}`] }];
  }

  private onClosed(reason: string, uptimeMs: number, frames: number): void {
    this.clearTimers();
    if (this.closed) return;
    this.emit({ type: "closed", reason, uptimeMs, frames });
    if (uptimeMs >= MIN_STABLE_CONNECTION_MS && frames > 0) this.failures = 0;
    else this.failures += 1;
    const ceiling = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, this.failures - 1),
    );
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.emit({ type: "reconnecting", inMs: delay, attempt: this.attempts + 1 });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armLiveness(): void {
    if (this.livenessTimer !== null) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      const socket = this.socket;
      if (this.closed || socket === null) return;
      this.emit({ type: "silent", forMs: LIVENESS_TIMEOUT_MS });
      this.abandon(socket, "liveness timeout");
    }, LIVENESS_TIMEOUT_MS);
  }

  /**
   * Give up on a socket *now*, rather than when it agrees to close.
   *
   * `close()` starts a handshake the peer has to answer, and a peer that has
   * stopped delivering has usually stopped answering too: measured on testnet,
   * a client-initiated close on a silent `/stream` connection took ~30 s to
   * reach `onclose`. Waiting for it would turn a 10 s watchdog into a 40 s
   * outage, so the socket is detached first and the reconnect path runs at
   * once; the close is sent as a courtesy and its outcome ignored.
   */
  private abandon(socket: WebSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    detach(socket);
    safeClose(socket, 4000, reason);
    const uptime = this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
    this.onClosed(reason, uptime, this.framesThisConnection);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer !== null) clearTimeout(this.livenessTimer);
    this.reconnectTimer = null;
    this.livenessTimer = null;
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
    // Already closing or closed.
  }
}
