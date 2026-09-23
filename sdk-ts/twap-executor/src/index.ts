// A TWAP executor: one parent order, worked as timed IOC child orders.
//
// Run it with:  npm start                         (dry run: live data, no writes)
//               npm start -- --live --limit P     (places real testnet orders)
//               npm start -- --resume <run-id>    (continue a run that died)
//
// The shape, in order of what matters:
//
//   1. Every child carries a client id derived from (run id, slice index), and
//      the journal records the intent *before* the order is sent. A crash can
//      therefore leave a slice "maybe sent", never "sent and forgotten".
//   2. A resume asks the venue (open orders, order history, fills) what those
//      ids became before it sends anything. The venue's own `client_id` dedupe
//      is a backstop behind that, not a replacement for it: its retention is
//      "sized to cover a retry window rather than a session".
//   3. Children are IOC limit orders at the touch, never through the parent's
//      limit. An IOC can't rest, so a crashed run leaves nothing on the book.
//      The exit sweep still checks rather than trusting that.
//   4. Every call is paced on its spec weight against budgets read from the
//      venue, and an order submission is never retried.

import { randomBytes } from "node:crypto";

import { NexusExchangeError } from "@nexus-xyz/exchange-ts";

import { ConfigError, HelpRequested, USAGE, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";
import * as journalStore from "./journal.js";
import type { Journal, SliceRecord } from "./journal.js";
import { Pacer } from "./pacer.js";
import {
  PlanError,
  buildSchedule,
  childLots,
  clientIdFor,
  midOf,
  priceChild,
  readMarketRules,
  readOrder,
  readTouch,
  reconcile,
  summarise,
} from "./plan.js";
import type { FillRecord, MarketRules, Parent, Schedule } from "./plan.js";
import { Venue, describe } from "./venue.js";
import type { ChildOrder } from "./venue.js";
import { weightsProvenance } from "./weights.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
/** Something is still unresolved: an order whose outcome is unknown, or one still resting. */
const EXIT_UNRESOLVED = 3;
const EXIT_INTERRUPTED = 130;

/**
 * Aborted by SIGINT/SIGTERM. The handler does only this. Every scheduler wait
 * notices it, and the single cleanup path in `main` is the only code that
 * undoes anything. Cleanup itself does not watch it: a Ctrl-C during the
 * sweep must not be what leaves an order resting.
 */
const interrupted = new AbortController();

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

/** A sleep the scheduler uses: ends early on an interrupt. */
function waitUntil(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (interrupted.signal.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      interrupted.signal.removeEventListener("abort", done);
      resolve();
    }
    interrupted.signal.addEventListener("abort", done, { once: true });
  });
}

/** A sleep the pacer and retries use: not interruptible, so cleanup can pace too. */
function plainSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const fmt = dec.formatTrimmed;

/** An execution from a placement response (`ExecutionFill`: `quantity`, not `size`). */
function readExecution(raw: unknown): FillRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : null;
  const price = typeof r["price"] === "string" ? r["price"] : null;
  const size = typeof r["quantity"] === "string" ? r["quantity"] : typeof r["size"] === "string" ? r["size"] : null;
  return id === null || price === null || size === null ? null : { id, price, size };
}

function sumFills(fills: readonly FillRecord[]): Dec {
  return fills.reduce((acc, f) => dec.add(acc, dec.parse(f.size)), dec.ZERO);
}

/** Lots the parent has done so far. A dry run counts what it *would* have sent. */
function progressLots(journal: Journal, lot: Dec): bigint {
  let total = dec.ZERO;
  for (const s of journal.slices) {
    if (journal.live) total = dec.add(total, dec.parse(s.filled));
    else if (s.state === "done" && s.quantity !== null) total = dec.add(total, dec.parse(s.quantity));
  }
  return dec.countSteps(total, lot).count;
}

function parentOf(journal: Journal): Parent {
  return {
    market: journal.parent.market,
    side: journal.parent.side,
    size: dec.parse(journal.parent.size),
    durationMs: journal.parent.durationMs,
    slices: journal.parent.slices,
    limit: journal.parent.limit === null ? null : dec.parse(journal.parent.limit),
  };
}

class Run {
  private schedule!: Schedule;
  private rules: MarketRules | null = null;
  private lot!: Dec;

  constructor(
    private readonly config: Config,
    private readonly venue: Venue,
    private readonly pacer: Pacer,
    private journal: Journal,
  ) {}

  get runId(): string {
    return this.journal.runId;
  }

  private save(): void {
    journalStore.save(this.journal);
  }

  async prepare(fresh: boolean): Promise<void> {
    const parent = parentOf(this.journal);
    if (this.venue.hasCredentials) {
      const markets = await this.venue.markets();
      const rules = markets.map(readMarketRules).find((r) => r?.marketId === parent.market) ?? null;
      if (rules === null) {
        const ids = markets.map((m) => readMarketRules(m)?.marketId).filter(Boolean).join(", ");
        throw new PlanError(`market ${parent.market} is not listed here. Available: ${ids}`);
      }
      this.rules = rules;
      log(
        `market  ${rules.marketId}: tick ${fmt(rules.tick)}, lot ${fmt(rules.lot)}, ` +
          `min size ${fmt(rules.minSize)}`,
      );
    } else {
      log(`market  ${parent.market}: rules unread. GET /markets is signed, so lot and minimum size are unchecked`);
    }
    this.schedule = buildSchedule(parent, this.rules);
    this.lot = this.rules?.lot ?? { units: 1n, scale: parent.size.scale };

    if (fresh) {
      const book = await this.venue.book(parent.market);
      const touch = readTouch(book, this.rules?.tick ?? null);
      const mid = midOf(touch, this.rules?.tick ?? null);
      this.journal.arrival = {
        bid: touch.bid === null ? null : dec.format(touch.bid),
        ask: touch.ask === null ? null : dec.format(touch.ask),
        mid: mid === null ? null : dec.format(mid),
      };
      this.journal.slices = this.schedule.slots.map((slot) => ({
        index: slot.index,
        clientId: clientIdFor(this.runId, slot.index),
        dueAt: this.journal.startAt + slot.offsetMs,
        state: "pending",
        orderId: null,
        quantity: null,
        price: null,
        filled: "0",
        fills: [],
        note: "",
      }));
      this.save();
    }
    const a = this.journal.arrival;
    log(
      `arrival bid ${a.bid ?? "—"} / ask ${a.ask ?? "—"} → mid ${a.mid === null ? "unavailable (one side empty)" : fmt(dec.parse(a.mid))}`,
    );
    const lots = this.schedule.slots.map((s, i) => s.cumulativeLots - (this.schedule.slots[i - 1]?.cumulativeLots ?? 0n));
    log(
      `plan    ${parent.side} ${fmt(parent.size)} ${parent.market} over ${parent.durationMs / 1000}s in ` +
        `${parent.slices} IOC children of ${lots.map((l) => fmt(dec.times(this.lot, l))).join(" / ")}, ` +
        `limit ${parent.limit === null ? "none (dry run only)" : fmt(parent.limit)}`,
    );
    log(`ids     ${clientIdFor(this.runId, 0)} … ${clientIdFor(this.runId, parent.slices - 1)}  (journal ${journalStore.journalPath(this.runId)})`);
  }

  /**
   * Ask the venue what every `sending` slice became.
   *
   * `sending` is the only ambiguous state: the intent was written, and the
   * process may or may not have got the order out before it died. Three reads
   * answer it, open orders (weight 1), order history (5) and fills (5), which
   * is eleven tokens no matter how many slices are in doubt. A lookup per slice
   * would cost that per slice.
   */
  async reconcileSending(when: string): Promise<void> {
    const doubtful = this.journal.slices.filter((s) => s.state === "sending");
    if (doubtful.length === 0) return;
    if (!this.journal.live) {
      // A dry run never sends, so a dry-run `sending` is only a journaled
      // intent. It's re-evaluated under the same client id. With credentials
      // it's still worth asking, to show the lookup comes back empty.
      if (this.venue.hasCredentials) await this.lookup(doubtful, when, true);
      for (const s of doubtful) {
        s.state = "pending";
        s.note = "dry run: journaled but never sent; re-evaluated under the same client id";
        log(`resume  slice ${s.index} (${s.clientId}) was mid-send when the run died: dry run, so nothing reached the venue`);
      }
      this.save();
      return;
    }
    await this.lookup(doubtful, when, false);
  }

  private async lookup(slices: SliceRecord[], when: string, readOnly: boolean): Promise<void> {
    log(`${when} asking the venue about ${slices.map((s) => s.clientId).join(", ")} (open orders + history + fills)`);
    const [open, history, fills] = [await this.venue.openOrders(), await this.venue.orderHistory(), await this.venue.fills()];
    const results = reconcile(
      slices.map((s) => s.clientId),
      open,
      history,
      fills,
    );
    for (const result of results) {
      const slice = slices.find((s) => s.clientId === result.clientId);
      if (slice === undefined || readOnly) {
        log(`${when} ${result.clientId}: ${result.foundIn === null ? "no record at the venue" : `found (${result.foundIn})`}`);
        continue;
      }
      if (result.order === null) {
        // Not in open orders, not in history, no fills. It never landed, so the
        // slice is sent again, under the *same* id. If it did land and the
        // indexer simply hadn't caught up, the venue's dedupe answers 200/409
        // instead of placing a second order.
        slice.state = "pending";
        slice.note = "reconciled: no record at the venue, so it never landed";
        log(`${when} slice ${slice.index} (${slice.clientId}): no record at the venue, so it will be sent again under the same id`);
        continue;
      }
      slice.orderId = result.order.id;
      slice.fills = [...result.fills];
      slice.filled = result.order.filled ?? dec.format(sumFills(result.fills));
      slice.state = "done";
      slice.note = `reconciled: ${result.order.status ?? "unknown status"} in ${result.foundIn}`;
      log(
        `${when} slice ${slice.index} (${slice.clientId}): the venue has it. ${result.order.id} ` +
          `${result.order.status ?? "?"}, filled ${slice.filled}. Adopted, not re-sent`,
      );
      if (result.foundIn === "open") {
        // An IOC should never be resting. If one is, it's ours and it goes.
        await this.venue.cancel(result.order.id, this.journal.parent.market);
        log(`${when} slice ${slice.index} was resting, which an IOC should not be. Cancelled it`);
      }
    }
    this.save();
  }

  /** Work the schedule from wherever the journal says it is. */
  async execute(): Promise<void> {
    const parent = parentOf(this.journal);
    for (const slice of this.journal.slices) {
      if (interrupted.signal.aborted) return;
      if (slice.state !== "pending") continue;
      const slot = this.schedule.slots[slice.index];
      if (slot === undefined) continue;

      // If the *next* slice is also already due (the process was down, or a
      // slice ran long) this one is marked missed and its quantity rolls into
      // the next through the cumulative target. Sending both back to back
      // would be a burst, and the whole point of a TWAP is not bursting.
      const next = this.journal.slices[slice.index + 1];
      if (next !== undefined && next.state === "pending" && next.dueAt <= Date.now()) {
        slice.state = "missed";
        slice.note = "a later slice was already due; quantity rolls forward";
        log(`slice ${slice.index}  missed: slice ${next.index} is already due, so its quantity rolls forward`);
        this.save();
        continue;
      }

      await waitUntil(slice.dueAt - Date.now());
      if (interrupted.signal.aborted) return;

      const lots = childLots(this.schedule, slot, progressLots(this.journal, this.lot));
      const quantity = dec.times(this.lot, lots);
      if (lots === 0n) {
        this.skip(slice, "on schedule, nothing to catch up");
        continue;
      }
      if (this.rules !== null && dec.compare(quantity, this.rules.minSize) < 0) {
        this.skip(slice, `${fmt(quantity)} is below the ${fmt(this.rules.minSize)} minimum; rolls forward`);
        continue;
      }

      const touch = readTouch(await this.venue.book(parent.market), this.rules?.tick ?? null);
      const decision = priceChild(parent.side, touch, parent.limit);
      if (decision.kind === "skip") {
        this.skip(slice, `${decision.reason}; ${fmt(quantity)} rolls forward`);
        continue;
      }

      const order: ChildOrder = {
        market_id: parent.market,
        side: parent.side,
        order_type: "Limit",
        price: fmt(decision.price),
        quantity: fmt(quantity),
        time_in_force: "IOC",
        client_id: slice.clientId,
      };

      // WRITE-AHEAD. From here until the outcome is recorded, a crash leaves
      // this slice `sending`, and a resume asks the venue about it.
      slice.state = "sending";
      slice.quantity = order.quantity;
      slice.price = order.price ?? null;
      this.save();

      if (!this.journal.live) {
        this.killIfAsked(slice.index);
        slice.state = "done";
        slice.note = `dry run: would send IOC ${order.side} ${order.quantity} @ ${order.price}`;
        this.save();
        log(`slice ${slice.index}  would send ${order.client_id}: IOC ${order.side} ${order.quantity} @ ${order.price}`);
        continue;
      }

      const outcome = await this.venue.place(order);
      this.killIfAsked(slice.index);
      await this.record(slice, outcome);
    }
  }

  private skip(slice: SliceRecord, reason: string): void {
    slice.state = "skipped";
    slice.note = reason;
    this.save();
    log(`slice ${slice.index}  skipped: ${reason}`);
  }

  /**
   * `--kill-after N`: SIGKILL right after slice N's order has gone out and
   * *before* its outcome is written down. The worst possible moment: the
   * venue knows what happened and the journal doesn't. It's what `--resume`
   * exists for, so it's what the demonstration does.
   */
  private killIfAsked(index: number): void {
    if (this.config.killAfter !== index) return;
    log(`--kill-after ${index}: SIGKILL now, before the outcome of slice ${index} is recorded`);
    process.kill(process.pid, "SIGKILL");
  }

  private async record(slice: SliceRecord, outcome: Awaited<ReturnType<Venue["place"]>>): Promise<void> {
    if (outcome.kind === "accepted") {
      const order = readOrder(outcome.response.order);
      const fills = (outcome.response.fills ?? []).map(readExecution).filter((f): f is FillRecord => f !== null);
      slice.orderId = order?.id ?? null;
      slice.fills = fills;
      slice.filled = order?.filled ?? dec.format(sumFills(fills));
      slice.state = "done";
      slice.note = `${outcome.replay ? "replayed (200): the venue already held this id" : "accepted"}, ${order?.status ?? "?"}`;
      log(
        `slice ${slice.index}  ${slice.clientId} IOC ${slice.quantity} @ ${slice.price}: ${order?.status ?? "?"}, ` +
          `filled ${slice.filled}${outcome.replay ? " (replay)" : ""}`,
      );
      if (order !== null && (order.status === "Open" || order.status === "PartiallyFilled") && dec.compare(dec.parse(slice.filled), dec.parse(slice.quantity ?? "0")) < 0) {
        await this.venue.cancel(order.id, this.journal.parent.market);
        log(`slice ${slice.index}  was left resting, which an IOC should not be. Cancelled it`);
      }
    } else if (outcome.kind === "refused") {
      if (outcome.status === 409) {
        // DuplicateClientId: this id already made an order that's no longer
        // resting. That is an answer, not an error. Look it up.
        log(`slice ${slice.index}  409: the venue already used ${slice.clientId}. Reconciling instead of re-sending`);
        await this.lookup([slice], "        ", false);
        return;
      }
      slice.state = "refused";
      slice.note = `${outcome.status}${outcome.code === null ? "" : ` ${outcome.code}`}: ${outcome.detail}`;
      log(
        `slice ${slice.index}  refused (${outcome.status}${outcome.code === null ? "" : ` ${outcome.code}`}). ` +
          `Not placed, not retried; the quantity rolls forward. ${outcome.detail}`,
      );
    } else {
      slice.note = `outcome unknown: ${outcome.detail}`;
      log(`slice ${slice.index}  no answer (${outcome.detail}). It may exist; asking rather than re-sending`);
      await this.lookup([slice], "        ", false);
    }
    this.save();
  }

  /**
   * On every exit path: cancel anything of this run's that is resting, then
   * prove it by reading again.
   *
   * Scoped by client id prefix, not a cancel-all: the account may have orders
   * this run has nothing to do with. An IOC child should never be here, which
   * is exactly why the sweep reads instead of assuming.
   */
  async sweep(): Promise<boolean> {
    if (!this.venue.hasCredentials) return true;
    const prefix = `twap-${this.runId}-`;
    const mine = (await this.venue.openOrders()).map(readOrder).filter((o) => o?.clientId?.startsWith(prefix));
    if (!this.journal.live) {
      log(`sweep   dry run: ${mine.length} resting order(s) carry this run's ids (none expected; nothing cancelled)`);
      return true;
    }
    for (const order of mine) {
      if (order === null) continue;
      try {
        await this.venue.cancel(order.id, order.market ?? this.journal.parent.market);
        log(`sweep   cancelled ${order.id} (${order.clientId})`);
      } catch (error) {
        log(`sweep   FAILED to cancel ${order.id}: ${describe(error)}`);
      }
    }
    const left = (await this.venue.openOrders()).map(readOrder).filter((o) => o?.clientId?.startsWith(prefix));
    log(
      left.length === 0
        ? `sweep   verified: no order carrying ${prefix}* is resting`
        : `sweep   WARNING: ${left.length} order(s) of this run are STILL resting. Cancel them by hand`,
    );
    return left.length === 0;
  }

  summary(): boolean {
    const parent = parentOf(this.journal);
    const fills = this.journal.slices.flatMap((s) => s.fills);
    const mid = this.journal.arrival.mid === null ? null : dec.parse(this.journal.arrival.mid);
    const s = summarise(parent.side, parent.size, fills, mid, this.rules?.tick ?? null);
    const counts = new Map<string, number>();
    for (const slice of this.journal.slices) counts.set(slice.state, (counts.get(slice.state) ?? 0) + 1);
    const pct = dec.isPositive(s.target) ? fmt(dec.divRound(dec.mul(s.filled, { units: 100n, scale: 0 }), s.target, 1)) : "0";
    console.log("");
    log(`summary run ${this.runId} (${this.journal.live ? "live" : "dry run"})`);
    log(`  slices   ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`);
    log(`  filled   ${fmt(s.filled)} of ${fmt(s.target)} (${pct}%)${this.journal.live ? "" : ". A dry run fills nothing"}`);
    log(`  vwap     ${s.vwap === null ? "—  (no fills)" : fmt(s.vwap)}`);
    log(`  arrival  ${s.arrivalMid === null ? "—  (no two-sided book at start)" : fmt(s.arrivalMid)}`);
    log(
      `  slippage ${s.slippageBps === null ? "—  (needs both a VWAP and an arrival mid)" : `${fmt(s.slippageBps)} bps vs arrival (positive = worse)`}`,
    );
    for (const line of this.pacer.describe()) log(`  ${line}`);
    const unresolved = this.journal.slices.filter((x) => x.state === "sending");
    if (unresolved.length > 0) {
      log(`  UNRESOLVED: ${unresolved.map((x) => x.clientId).join(", ")}. Run --resume ${this.runId} to reconcile`);
    }
    const final = this.journal.slices.every((x) => x.state !== "pending" && x.state !== "sending");
    if (final) {
      this.journal.finishedAt = Date.now();
      this.save();
    } else {
      log(`  incomplete: npm start -- --resume ${this.runId}${this.journal.live ? " --live" : ""}`);
    }
    return unresolved.length === 0;
  }
}

function newJournal(config: Config, runId: string): Journal {
  const p = config.parent;
  if (p === null) throw new ConfigError("no parent order given");
  return {
    version: 1,
    runId,
    live: config.live,
    baseUrl: config.baseUrl,
    createdAt: Date.now(),
    parent: {
      market: p.market,
      side: p.side,
      size: dec.format(p.size),
      durationMs: p.durationSeconds * 1000,
      slices: p.slices,
      limit: p.limit === null ? null : dec.format(p.limit),
    },
    startAt: Date.now(),
    arrival: { bid: null, ask: null, mid: null },
    slices: [],
    finishedAt: null,
  };
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2));
  const pacer = new Pacer(config.utilisation, (m) => log(`pace    ${m}`));
  const venue = new Venue(config, pacer, plainSleep, (m) => log(`retry   ${m}`));

  log(
    `twap-executor on ${config.baseUrl} ` +
      (!config.baseUrlOverridden
        ? "(testnet, play funds)"
        : config.funds === "play"
          ? "(override, declared play funds by NEXUS_EXCHANGE_FUNDS)"
          : "(override, funds unknown: undeclared target)"),
  );
  log(config.live ? "--live: this run places real IOC orders" : "dry run: live data, no writes of any kind. Pass --live to trade");
  log(`weights from spec ${weightsProvenance}`);

  if (venue.hasCredentials) {
    try {
      pacer.applyStatus(await venue.rateLimit());
      log(`tier    ${pacer.tierName}`);
    } catch (error) {
      log(`pace    could not read GET /account/rate-limit (${describe(error)}); keeping the assumed rates`);
    }
  } else {
    log("tier    no credentials: public reads only, paced on the per-IP bucket the response headers report");
  }

  let journal: Journal;
  if (config.resume) {
    journal = journalStore.load(config.runId ?? "");
    if (journal.live !== config.live) {
      throw new ConfigError(
        `run ${journal.runId} was a ${journal.live ? "live" : "dry"} run. Resume it the same way: ` +
          `${journal.live ? "add" : "drop"} --live`,
      );
    }
    if (journal.baseUrl !== config.baseUrl) {
      throw new ConfigError(`run ${journal.runId} was against ${journal.baseUrl}; this is ${config.baseUrl}`);
    }
    log(`resume  run ${journal.runId}, started ${new Date(journal.startAt).toISOString()}`);
  } else {
    const runId = config.runId ?? randomBytes(4).toString("hex");
    if (journalStore.exists(runId)) {
      throw new ConfigError(`run ${runId} already has a journal. Use --resume ${runId}, or pick another --run-id`);
    }
    journal = newJournal(config, runId);
    log(`run     ${runId} (new)`);
  }
  for (const line of pacer.describe()) log(line);

  const run = new Run(config, venue, pacer, journal);
  let clean = true;
  try {
    await run.prepare(!config.resume);
    if (config.resume) await run.reconcileSending("resume ");
    await run.execute();
    await run.reconcileSending("final  ");
  } finally {
    // Cleanup runs on success, error and Ctrl-C alike, and none of it watches
    // the interrupt signal.
    try {
      clean = await run.sweep();
    } catch (error) {
      clean = false;
      log(`sweep   could not complete: ${describe(error)}. Check this run's orders by hand`);
    }
    clean = run.summary() && clean;
  }
  if (interrupted.signal.aborted) return EXIT_INTERRUPTED;
  return clean ? EXIT_OK : EXIT_UNRESOLVED;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted.signal.aborted) return;
    console.log(`\n${signal}: stopping the schedule and sweeping. A second ${signal} exits at once.`);
    process.once(signal, () => process.exit(EXIT_INTERRUPTED));
    interrupted.abort();
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof HelpRequested) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  if (error instanceof ConfigError || error instanceof PlanError) {
    console.error(`\n${error.message}`);
    process.exit(EXIT_ERROR);
  }
  if (error instanceof NexusExchangeError) {
    console.error(
      `\nThe Exchange API call failed: ${describe(error)}\n\n` +
        "If this host isn't serving the API for you, point the example at another deployment\n" +
        "(the base, without /api/v1): NEXUS_EXCHANGE_API_URL=https://<host>/<prefix> npm start",
    );
    process.exit(EXIT_ERROR);
  }
  throw error;
}
