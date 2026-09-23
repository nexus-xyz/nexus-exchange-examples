// A local L2 order-book replica for one Nexus Exchange market, on the raw API.
//
// Run it with:  npm start                 (until Ctrl-C)
//               npm start -- --seconds 60 (bounded, then a summary)
//
// This file is the wiring. The decisions live in the modules it composes:
// `frames.ts` (what the stream sends), `replica.ts` (sequence ordering, and the
// cross-check verdicts), `stream.ts` (the connection), `rest.ts` (the snapshot).
//
// The loop, in one paragraph: take a REST snapshot; connect to the public
// stream and apply every book frame that advances the sequence; on anything
// that says continuity was lost — the server's `gap` or `out_of_sync`, a
// reconnect, a frame we cannot read — flag the replica and re-fetch REST; and
// every N seconds, independently, fetch REST and compare. The comparison is
// printed whatever it says. A replica that only ever reports agreement is not
// being checked.

import * as dec from "./decimal.js";
import { classify } from "./frames.js";
import { loadConfig } from "./config.js";
import { ApiError, RestClient, toSnapshot } from "./rest.js";
import { crossCheck, Replica } from "./replica.js";
import { BookStream, LIVENESS_TIMEOUT_MS } from "./stream.js";
import type { Frame } from "./frames.js";
import type { CrossCheck } from "./replica.js";
import type { StreamEvent } from "./stream.js";

/** Floor between REST resyncs, so a burst of bad frames is a slow poll, not a REST flood. */
const MIN_RESYNC_INTERVAL_MS = 1_000;
/** With nothing to print, say so at least this often — silence must be visible. */
const HEARTBEAT_MS = 10_000;
/** Consecutive stale frames before concluding the server's numbering restarted. */
const MAX_CONSECUTIVE_STALE = 5;
/** Cross-checks in a row that find the replica behind REST, without it advancing, before resyncing. */
const MAX_BEHIND_CHECKS = 3;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(message: string): void {
  console.log(`${stamp()}  ${message}`);
}

function warn(message: string): void {
  log(`!  ${message}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Median / p95 / max of a sample, for the "what did the stream actually send" summary. */
function spread(samples: readonly number[]): string {
  if (samples.length === 0) return "n/a";
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);
  return `median ${ms(at(0.5))}, p95 ${ms(at(0.95))}, max ${ms(sorted[sorted.length - 1] ?? 0)}`;
}

/** Name the deployment rather than let a transcript imply it. */
function network(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  if (host === "api.testnet.nexus.xyz") return "testnet";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
  return `unrecognised host ${host}`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  const shutdown = new AbortController();
  const rest = new RestClient(config.baseUrl, shutdown.signal);
  const replica = new Replica(config.market);
  const startedAt = Date.now();

  const stats = {
    connections: 0,
    frames: 0,
    applied: 0,
    changed: 0,
    stale: 0,
    unsequenced: 0,
    jumps: 0,
    gaps: 0,
    missed: 0,
    outOfSync: 0,
    unrecognised: 0,
    rejectedLevels: 0,
    crossed: 0,
    resyncs: 0,
    ignored: 0,
    checks: new Map<CrossCheck["verdict"], number>(),
    interArrival: [] as number[],
    lastBookFrameAt: 0,
  };

  log(`Nexus Exchange book replica — ${config.market}`);
  log(`REST   ${config.baseUrl}  (${network(config.baseUrl)}, public data, no credentials)`);
  log(`stream ${config.streamUrl}`);

  // ── The view ────────────────────────────────────────────────────────────
  let lastLine = "";
  let lastPrintAt = 0;

  function status(): string {
    const top = replica.top();
    if (replica.isResyncing) return "RESYNCING";
    if (top.bid === undefined && top.ask === undefined) return "EMPTY";
    if (replica.isCrossed) return "CROSSED";
    return "live";
  }

  function level(side: "bid" | "ask"): string {
    const l = replica.top()[side];
    return l === undefined ? "—" : `${dec.toString(l.price)} × ${dec.toString(l.size)}`;
  }

  /** Print the top of book when it (or the replica's state) changed — not on every frame. */
  function render(force = false): void {
    const top = replica.top();
    const book = replica.snapshot;
    const line =
      `${config.market}  bid ${level("bid")}  ask ${level("ask")}` +
      `  spread ${top.spread === null ? "—" : dec.toString(top.spread)}` +
      `  depth ${book.bids.length}/${book.asks.length}  ${status()}`;
    if (!force && line === lastLine) return;
    lastLine = line;
    lastPrintAt = Date.now();
    log(`${line}  seq ${replica.seq ?? "—"} via ${replica.source ?? "—"}`);
  }

  // ── Resync: the one path back to a trusted book ─────────────────────────
  let resyncInFlight: Promise<void> | null = null;
  let resyncPending: string | null = null;
  let lastResyncAt = 0;

  function resync(reason: string): void {
    replica.markResyncing();
    // Single-flight: a second reason arriving mid-fetch is folded into one
    // follow-up fetch, not a second concurrent one.
    if (resyncInFlight !== null) {
      resyncPending = reason;
      return;
    }
    resyncInFlight = (async () => {
      const wait = lastResyncAt + MIN_RESYNC_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (shutdown.signal.aborted) return;
      lastResyncAt = Date.now();
      stats.resyncs += 1;
      try {
        const book = await rest.orderBook(config.market);
        const outcome = replica.apply(book.nonce, toSnapshot(book), "rest");
        if (outcome.result === "stale" && book.nonce === outcome.held) {
          // Same sequence: two reads of one stored book. They must agree, and
          // if they do not, REST — the read made *after* the doubt — wins.
          const check = crossCheck(replica, book);
          if (check.verdict === "match") {
            replica.resyncSatisfiedByStream();
            log(`resync (${reason}): REST confirms the replica at seq ${outcome.held}`);
          } else {
            replica.apply(book.nonce, toSnapshot(book), "rest", Date.now(), true);
            warn(`resync (${reason}): same seq ${outcome.held}, different book — replaced from REST`);
          }
        } else if (outcome.result === "stale") {
          replica.resyncSatisfiedByStream();
          log(
            `resync (${reason}): REST nonce ${book.nonce} is behind the replica at seq ` +
              `${outcome.held} — the stream already delivered a newer complete book; keeping it`,
          );
        } else {
          log(`resync (${reason}): replaced from REST at nonce ${book.nonce ?? "—"}`);
        }
        render(true);
      } catch (error) {
        if (!shutdown.signal.aborted) warn(`resync (${reason}) failed: ${describe(error)} — will retry`);
        resyncPending ??= reason;
      }
    })().finally(() => {
      resyncInFlight = null;
      const next = resyncPending;
      resyncPending = null;
      if (next !== null && !shutdown.signal.aborted) resync(next);
    });
  }

  // ── Frames ──────────────────────────────────────────────────────────────
  let consecutiveStale = 0;
  let warnedUnrecognised = 0;

  function onFrame(frame: Frame): void {
    switch (frame.kind) {
      case "book": {
        stats.frames += 1;
        const now = Date.now();
        if (stats.lastBookFrameAt !== 0) stats.interArrival.push(now - stats.lastBookFrameAt);
        stats.lastBookFrameAt = now;
        if (frame.rejectedLevels > 0) {
          stats.rejectedLevels += frame.rejectedLevels;
          warn(`seq ${frame.seq}: dropped ${frame.rejectedLevels} unreadable or duplicate level(s)`);
        }
        const outcome = replica.apply(frame.seq, frame.book, "stream", now);
        if (outcome.result === "stale") {
          stats.stale += 1;
          consecutiveStale += 1;
          if (consecutiveStale >= MAX_CONSECUTIVE_STALE) {
            // Every frame is at or below what we hold, and they keep coming:
            // the numbering restarted underneath us (an indexer restart resets
            // it). Refusing them forever would be a replica that goes quiet
            // while traffic is still arriving.
            warn(
              `${consecutiveStale} consecutive frames at or below seq ${outcome.held} ` +
                `(latest ${frame.seq}) — the stream's sequence appears to have restarted`,
            );
            consecutiveStale = 0;
            replica.resetSequence();
            resync("sequence restarted");
          }
          return;
        }
        consecutiveStale = 0;
        stats.applied += 1;
        if (outcome.result === "unsequenced") stats.unsequenced += 1;
        if (outcome.result === "applied" && outcome.jump > 1n) stats.jumps += 1;
        if (outcome.changed) stats.changed += 1;
        if (replica.isCrossed) {
          stats.crossed += 1;
          warn(`seq ${frame.seq}: book is crossed — shown as-is, not repaired`);
        }
        render();
        return;
      }
      case "gap":
        stats.gaps += 1;
        stats.missed += frame.missed ?? 0;
        warn(
          `server reports this connection fell behind: ${frame.missed ?? "an unknown number of"} ` +
            "frame(s) dropped, none replayable",
        );
        resync("gap");
        return;
      case "out_of_sync":
        stats.outOfSync += 1;
        warn(`out_of_sync: the replay buffer starts at seq ${frame.oldestSeq ?? "?"}`);
        resync("out_of_sync");
        stream.reconnectNow("resubscribing after out_of_sync");
        return;
      case "subscribed":
        log(`subscribed${frame.seq === null ? "" : ` at seq ${frame.seq}`}`);
        return;
      case "error":
        warn(`server: ${frame.message}`);
        return;
      case "unrecognised":
        stats.unrecognised += 1;
        if (warnedUnrecognised < 3) {
          warnedUnrecognised += 1;
          warn(`unrecognised book frame (${frame.why}) — not merged on a guess; resyncing`);
        }
        resync("unrecognised frame");
        return;
      case "ignored":
        stats.ignored += 1;
        return;
    }
  }

  // ── Stream ──────────────────────────────────────────────────────────────
  let everOpened = false;
  let connected = false;

  function onStream(event: StreamEvent): void {
    switch (event.type) {
      case "open":
        stats.connections += 1;
        connected = true;
        log(`stream connected (attempt ${event.attempt}), subscribed to book:${config.market}`);
        // Whatever was published while we were away, we did not see.
        if (everOpened) resync("reconnected");
        everOpened = true;
        return;
      case "message":
        onFrame(classify(event.data, config.market));
        return;
      case "closed":
        connected = false;
        replica.markResyncing();
        warn(
          `stream closed (${event.reason}) after ${(event.uptimeMs / 1000).toFixed(1)}s ` +
            `and ${event.frames} frame(s)`,
        );
        return;
      case "reconnecting":
        log(`reconnecting in ${(event.inMs / 1000).toFixed(1)}s`);
        return;
      case "silent":
        warn(`no frames for ${event.forMs / 1000}s — abandoning this connection`);
        return;
    }
  }

  const stream = new BookStream(config.streamUrl, config.market, onStream);

  // ── Cross-check ─────────────────────────────────────────────────────────
  let behindChecks = 0;
  let behindAtSeq: bigint | null = null;

  async function runCrossCheck(): Promise<void> {
    let result: CrossCheck;
    try {
      result = crossCheck(replica, await rest.orderBook(config.market));
    } catch (error) {
      if (!shutdown.signal.aborted) warn(`cross-check: REST read failed: ${describe(error)}`);
      return;
    }
    stats.checks.set(result.verdict, (stats.checks.get(result.verdict) ?? 0) + 1);
    switch (result.verdict) {
      case "match":
        behindChecks = 0;
        log(`cross-check: match at seq ${result.seq} (${result.levels} levels, level for level)`);
        return;
      case "diverged":
        behindChecks = 0;
        warn(`cross-check: DIVERGED at seq ${result.seq} — ${result.detail}`);
        resync("divergence");
        return;
      case "replica-behind": {
        const seq = replica.seq;
        behindChecks = seq !== null && seq === behindAtSeq ? behindChecks + 1 : 1;
        behindAtSeq = seq;
        log(
          `cross-check: replica ${result.by} behind REST` +
            `${result.levelsDiffer ? ", levels differ" : ", levels equal"} — lag, not divergence`,
        );
        if (behindChecks >= MAX_BEHIND_CHECKS) {
          warn(`replica stuck at seq ${seq} for ${behindChecks} checks while REST advanced`);
          behindChecks = 0;
          resync("stream stalled");
        }
        return;
      }
      case "rest-behind":
        behindChecks = 0;
        log(
          `cross-check: REST ${result.by} behind the replica` +
            `${result.levelsDiffer ? ", levels differ" : ", levels equal"} — REST read an older projection`,
        );
        return;
      case "incomparable":
        log(`cross-check: incomparable — ${result.why}`);
        return;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  let stopping = false;
  const timers: NodeJS.Timeout[] = [];

  function summary(): void {
    const seconds = (Date.now() - startedAt) / 1000;
    const checks =
      [...stats.checks.entries()].map(([verdict, n]) => `${verdict} ${n}`).join(", ") || "none";
    console.log("");
    log(`summary after ${seconds.toFixed(0)}s`);
    log(`  connections        ${stats.connections}`);
    log(`  book frames        ${stats.frames} (${(stats.frames / Math.max(seconds, 1)).toFixed(2)}/s)`);
    log(`  frame interval     ${spread(stats.interArrival)}`);
    log(`  content changed    ${stats.changed} of ${stats.applied} applied`);
    log(`  stale (dropped)    ${stats.stale}`);
    log(`  sequence jumps     ${stats.jumps}   (seq > last + 1: fill-time frames, not loss)`);
    log(`  unsequenced        ${stats.unsequenced}`);
    log(`  gaps / missed      ${stats.gaps} / ${stats.missed}`);
    log(`  out_of_sync        ${stats.outOfSync}`);
    log(`  unrecognised       ${stats.unrecognised}`);
    log(`  crossed books      ${stats.crossed}`);
    log(`  levels rejected    ${stats.rejectedLevels}`);
    log(`  REST resyncs       ${stats.resyncs}`);
    log(`  cross-checks       ${checks}`);
  }

  function stop(reason: string): void {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    for (const timer of timers) clearInterval(timer);
    stream.close();
    shutdown.abort(new Error("shutting down"));
    summary();
    // Nothing here holds state worth flushing, so a hard deadline is enough.
    setTimeout(() => process.exit(0), 250).unref();
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  // First snapshot before the stream, so the view has a book to show and a
  // sequence to hold the stream's first frames against.
  try {
    const book = await rest.orderBook(config.market);
    replica.apply(book.nonce, toSnapshot(book), "rest");
    log(`initial REST snapshot at nonce ${book.nonce ?? "—"}`);
    render(true);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new Error(
        `market ${config.market} not found — list the venue's markets with ` +
          `GET ${config.baseUrl}/markets/summary and set NEXUS_MARKET`,
      );
    }
    warn(`initial REST snapshot failed: ${describe(error)} — starting from the stream`);
  }

  stream.start();

  timers.push(
    setInterval(() => void runCrossCheck(), config.crossCheckMs),
    setInterval(() => {
      if (Date.now() - lastPrintAt < HEARTBEAT_MS) return;
      const quiet = stats.lastBookFrameAt === 0 ? "no book frames yet" : `last book frame ${((Date.now() - stats.lastBookFrameAt) / 1000).toFixed(0)}s ago`;
      log(
        `… ${quiet}; ${connected ? "connected" : "not connected"}; ` +
          `replica at seq ${replica.seq ?? "—"}, ${status()}` +
          (stats.lastBookFrameAt === 0 && connected ? ` (watchdog abandons at ${LIVENESS_TIMEOUT_MS / 1000}s)` : ""),
      );
      lastPrintAt = Date.now();
    }, 1_000),
  );
  if (config.runForMs !== null) {
    const ms = config.runForMs;
    timers.push(setTimeout(() => stop(`--seconds ${ms / 1000}`), ms));
  }
}

main().catch((error: unknown) => {
  console.error(`book-replica: ${describe(error)}`);
  process.exit(1);
});
