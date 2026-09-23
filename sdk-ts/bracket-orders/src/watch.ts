// One-cancels-other, kept up while the bracket is live.
//
// The shape: the WebSocket is the doorbell, REST is the ledger.
//
//  * Frames on the `orders` and `fills` channels wake the loop. They're never
//    what a decision is made from: their payloads aren't in spec v0.8.1, and a
//    missed frame must not be able to leave both exits live.
//  * Every wake, every reconnect, every `out_of_sync`, and a timer when the
//    socket is quiet all lead to the same thing: read open orders, order
//    history, fills and positions over REST, and hand that snapshot to
//    `decide`. So a reconnect is *always* reconciled before anything is
//    cancelled, because nothing is ever cancelled any other way.
//  * An interrupt ends the loop and cancels nothing. The exits are native
//    conditional orders on the venue, so they keep protecting the position
//    after this process is gone. That's the point of using them.

import { createWsClient } from "@nexus-xyz/exchange-ts";
import type { WebSocketCtor, WsSubscription } from "@nexus-xyz/exchange-ts";

import { decide, legView, readFill, readOrder, readPositionSize } from "./bracket.js";
import type { Decision, ExitKind, Snapshot, VenueFill, VenueOrder } from "./bracket.js";
import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";
import { describe, isTransient } from "./venue.js";
import type { Venue } from "./venue.js";

export interface Leg {
  readonly id: string;
  readonly quantity: Dec;
  readonly trigger: Dec;
}

export interface Legs {
  readonly market: string;
  readonly tp: Leg;
  readonly sl: Leg;
}

export type Outcome =
  | { readonly kind: "done"; readonly why: string }
  | { readonly kind: "unprotected"; readonly why: string }
  /** Interrupted. Both exits (or whatever of them is live) were left resting. */
  | { readonly kind: "protected"; readonly snapshot: Snapshot | null }
  | { readonly kind: "error"; readonly why: string };

export interface WatchOptions {
  readonly wsUrl: string;
  readonly reconcileMs: number;
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
  /** For tests. Defaults to the runtime's global `WebSocket` (Node 22+). */
  readonly WebSocketImpl?: WebSocketCtor;
  /** Pause after a cancel before re-reading, so the read reflects it. */
  readonly settleMs?: number;
}

/** Consecutive failed reconciles before giving up. The exits stay resting either way. */
const MAX_FAILED_READS = 8;

/** Best-effort order id out of an undocumented frame payload, for the log line only. */
function frameOrderId(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  const inner = (r["order"] ?? r["fill"] ?? r) as Record<string, unknown>;
  const id = inner["order_id"] ?? inner["id"];
  return typeof id === "string" ? id : null;
}

export class Watcher {
  private wakeResolve: (() => void) | null = null;
  private dirty = true;
  private reason = "initial reconcile";

  constructor(
    private readonly venue: Venue,
    private readonly legs: Legs,
    private readonly opts: WatchOptions,
  ) {}

  private wake(reason: string): void {
    if (!this.dirty) this.reason = reason;
    this.dirty = true;
    this.wakeResolve?.();
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.dirty || this.opts.signal.aborted) return resolve();
      const done = (): void => {
        clearTimeout(timer);
        this.opts.signal.removeEventListener("abort", done);
        this.wakeResolve = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeResolve = done;
      this.opts.signal.addEventListener("abort", done, { once: true });
    });
  }

  private pump(sub: WsSubscription, channel: string): void {
    void (async () => {
      for await (const event of sub.events) {
        if (event.outOfSync) {
          this.wake(`${channel} stream lost continuity (out_of_sync)`);
          continue;
        }
        const id = frameOrderId(event.data);
        const ours = id === this.legs.tp.id || id === this.legs.sl.id;
        this.wake(`${channel} frame seq=${event.seq}${ours ? ` for ${id === this.legs.tp.id ? "take-profit" : "stop-loss"}` : ""}`);
      }
    })();
  }

  /** One coherent read of everything `decide` needs. */
  async snapshot(): Promise<Snapshot> {
    const [openRaw, historyRaw, fillsRaw, positionsRaw] = await Promise.all([
      this.venue.openOrders(),
      this.venue.orderHistory(),
      this.venue.fills(),
      this.venue.positions(),
    ]);
    const open = openRaw.map(readOrder).filter((o): o is VenueOrder => o !== null);
    const history = historyRaw.map(readOrder).filter((o): o is VenueOrder => o !== null);
    const fills = fillsRaw.map((f) => readFill(f)).filter((f): f is VenueFill => f !== null);
    return {
      tp: legView(this.legs.tp.id, this.legs.tp.quantity, open, history, fills),
      sl: legView(this.legs.sl.id, this.legs.sl.quantity, open, history, fills),
      position: readPositionSize(positionsRaw, this.legs.market),
    };
  }

  async run(): Promise<Outcome> {
    const { log, signal } = this.opts;
    const ws = createWsClient({
      url: this.opts.wsUrl,
      // Every mint after the first is a reconnect. The SDK resubscribes with
      // `since` on its own and doesn't tell its consumer; this is how the
      // watcher finds out, and a reconnect always forces a full REST read.
      tokenProvider: this.venue.tokenProvider(() => {
        if (this.venue.tokensMinted > 1) this.wake("websocket reconnected");
      }),
      ...(this.opts.WebSocketImpl === undefined ? {} : { WebSocketImpl: this.opts.WebSocketImpl }),
    });
    const subs = [ws.subscribe("orders"), ws.subscribe("fills")];
    this.pump(subs[0] as WsSubscription, "orders");
    this.pump(subs[1] as WsSubscription, "fills");

    let last: Snapshot | null = null;
    let lastNote: string | null | undefined;
    let failures = 0;
    try {
      for (;;) {
        if (signal.aborted) return { kind: "protected", snapshot: last };
        await this.idle(this.opts.reconcileMs);
        if (signal.aborted) return { kind: "protected", snapshot: last };

        const quiet = !this.dirty;
        const why = quiet ? `no frames for ${this.opts.reconcileMs / 1000}s` : this.reason;
        this.dirty = false;

        let snap: Snapshot;
        try {
          snap = await this.snapshot();
          failures = 0;
        } catch (error) {
          failures += 1;
          log(`reconcile failed (${describe(error)})${isTransient(error) ? "" : " [not transient]"}`);
          if (!isTransient(error) || failures >= MAX_FAILED_READS) {
            return { kind: "error", why: `could not read the account: ${describe(error)}` };
          }
          await this.idle(Math.min(8_000, 500 * 2 ** failures));
          continue;
        }
        last = snap;
        const decision: Decision = decide(snap);
        if (decision.kind === "hold") {
          // A quiet timer tick that changed nothing isn't worth a line; a
          // frame, a reconnect or a changed note always is.
          if (!quiet || decision.note !== lastNote) {
            log(`reconcile (${why}): ${summarise(snap)}${decision.note === null ? "" : `. ${decision.note}`}`);
          }
          lastNote = decision.note;
          continue;
        }
        log(`reconcile (${why}): ${summarise(snap)}`);
        if (decision.kind === "done") return { kind: "done", why: decision.why };
        if (decision.kind === "unprotected") return { kind: "unprotected", why: decision.why };

        // Cancel. Not interruptible: a Ctrl-C mid-OCO must not be what leaves
        // both exits live. Then read again to confirm, rather than assuming.
        for (const leg of decision.legs) {
          const target = this.legs[leg];
          log(`${decision.why}: cancelling ${label(leg)} ${target.id}`);
          try {
            await this.venue.cancel(target.id, this.legs.market);
          } catch (error) {
            log(`cancel of ${label(leg)} failed: ${describe(error)}; will re-read and retry`);
          }
        }
        this.dirty = true;
        this.reason = "confirming the cancel";
        await new Promise((r) => setTimeout(r, this.opts.settleMs ?? 300));
      }
    } finally {
      for (const s of subs) s.unsubscribe();
      ws.close();
    }
  }
}

function label(leg: ExitKind): string {
  return leg === "tp" ? "take-profit" : "stop-loss";
}

export function summarise(s: Snapshot): string {
  const leg = (name: string, v: Snapshot["tp"]) =>
    `${name} ${v.state}${dec.isPositive(v.filled) ? ` (filled ${dec.formatTrimmed(v.filled)})` : ""}`;
  const pos = s.position === null ? "unreadable" : dec.formatTrimmed(s.position);
  return `${leg("tp", s.tp)}, ${leg("sl", s.sl)}, position ${pos}`;
}
