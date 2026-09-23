// The bracket, end to end: read, plan, check, and (with --live) place and manage.
//
// Split from `index.ts` so the tests can run the whole flow in-process against
// a loopback venue, with the real SDK doing every request.

import { randomBytes } from "node:crypto";

import type { OrderResponse, WebSocketCtor } from "@nexus-xyz/exchange-ts";

import {
  PlanError,
  checkPlan,
  clientIdFor,
  completePlan,
  entryOrder,
  exitOrders,
  readFill,
  readMarketRules,
  readOrder,
  readPositionSize,
} from "./bracket.js";
import type { BracketOrder, MarketRules, Plan, VenueFill, VenueOrder } from "./bracket.js";
import type { Config } from "./config.js";
import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";
import { Venue, describe } from "./venue.js";
import { Watcher, summarise } from "./watch.js";
import type { Legs, Outcome } from "./watch.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** The plan was refused before anything was sent. */
export const EXIT_REFUSED = 2;
/** Something needs a human: the position is not protected, or an order's fate is unknown. */
export const EXIT_UNRESOLVED = 3;
/** Interrupted, with the exits left resting. The shell's code for SIGINT. */
export const EXIT_INTERRUPTED = 130;

export type Phase = "reading" | "placing" | "managing" | "finished";

export interface Deps {
  readonly log: (message: string) => void;
  /** Aborted by the first SIGINT/SIGTERM. Only the manage loop watches it. */
  readonly signal: AbortSignal;
  readonly onPhase?: (phase: Phase) => void;
  readonly WebSocketImpl?: WebSocketCtor;
  readonly settleMs?: number;
}

const fmt = dec.formatTrimmed;

function bodyLine(order: BracketOrder): string {
  return JSON.stringify(order);
}

/** The price everything is checked against: the mark, else the book's mid, else nothing. */
async function reference(venue: Venue, market: string, tick: Dec | null, log: Deps["log"]): Promise<{ mark: Dec | null; ref: Dec | null }> {
  const markText = await venue.markPrice(market);
  if (markText !== null) {
    const mark = dec.parse(markText);
    log(`mark    ${fmt(mark)}`);
    return { mark, ref: mark };
  }
  const book = await venue.book(market);
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (bid !== undefined && ask !== undefined) {
    const mid = dec.divRound(dec.add(dec.fromJsonNumber(bid[0]), dec.fromJsonNumber(ask[0])), { units: 2n, scale: 0 }, (tick?.scale ?? 2) + 1);
    log(`mark    unavailable; using the book mid ${fmt(mid)} as the reference (triggers fire off the mark, so this is a stand-in)`);
    return { mark: null, ref: mid };
  }
  log("mark    unavailable (the venue answered 503) and the book is empty: no reference price, so the trigger-vs-mark checks can't run");
  return { mark: null, ref: null };
}

/** What the entry actually filled: the larger of the order record and its fills, response and REST both. */
async function entryFilled(venue: Venue, response: OrderResponse | null, entryId: string): Promise<Dec> {
  let filled = dec.ZERO;
  if (response !== null) {
    const order = readOrder(response.order);
    if (order !== null) filled = dec.max(filled, order.filled);
    const own = (response.fills as unknown[]).map((f) => readFill(f, entryId)).filter((f): f is VenueFill => f !== null);
    filled = dec.max(filled, own.reduce((a, f) => dec.add(a, f.size), dec.ZERO));
  }
  const [history, fills] = await Promise.all([venue.orderHistory(), venue.fills()]);
  const record = history.map(readOrder).find((o) => o?.id === entryId) ?? null;
  if (record !== null) filled = dec.max(filled, record.filled);
  const restFills = fills.map((f) => readFill(f)).filter((f): f is VenueFill => f?.orderId === entryId);
  return dec.max(filled, restFills.reduce((a, f) => dec.add(a, f.size), dec.ZERO));
}

/** Resolve an `unknown` placement by its client id, never by sending again. */
async function findByClientId(venue: Venue, clientId: string): Promise<VenueOrder | null> {
  const [open, history] = await Promise.all([venue.openOrders(), venue.orderHistory()]);
  for (const raw of [...open, ...history]) {
    const order = readOrder(raw);
    if (order?.clientId === clientId) return order;
  }
  return null;
}

/** Place one order and come back with its venue id, or say why there isn't one. */
async function placeOne(
  venue: Venue,
  order: BracketOrder,
  what: string,
  log: Deps["log"],
): Promise<{ id: string; response: OrderResponse | null } | { id: null; why: string; unknown: boolean }> {
  const result = await venue.place(order);
  if (result.kind === "accepted") {
    const placed = readOrder(result.response.order);
    if (placed !== null) {
      log(`${what} placed: ${placed.id} ${placed.status ?? ""}`.trimEnd());
      return { id: placed.id, response: result.response };
    }
  }
  if (result.kind === "refused") {
    log(`${what} refused (${result.status || "local"}): ${result.detail}`);
    return { id: null, why: result.detail, unknown: false };
  }
  log(`${what}: no usable answer (${result.kind === "unknown" ? result.detail : "response had no order id"}); looking it up by client id ${order.client_id}`);
  const found = await findByClientId(venue, order.client_id);
  if (found !== null) {
    log(`${what} found by client id: ${found.id} ${found.status ?? ""}`.trimEnd());
    return { id: found.id, response: null };
  }
  return { id: null, why: `no order with client id ${order.client_id} is visible`, unknown: true };
}

function printPlan(plan: Plan, rules: MarketRules | null, ref: Dec | null, runId: string, log: Deps["log"]): void {
  const long = plan.side === "Buy";
  log(`plan    ${plan.side} ${fmt(plan.size)} ${plan.market} IOC at worst ${fmt(plan.limit)}, then two reduce-only ${long ? "Sell" : "Buy"} exits:`);
  const pct = (p: Dec): string => (ref === null ? "" : ` (${fmt(dec.divRound(dec.mul(dec.sub(p, ref), { units: 10000n, scale: 0 }), ref, 1))} bps from reference)`);
  log(`        take-profit TakeProfitMarket trigger ${fmt(plan.tp)}${pct(plan.tp)}`);
  log(`        stop-loss   StopMarket       trigger ${fmt(plan.sl)}${pct(plan.sl)}`);
  if (plan.derived.length > 0) log(`        derived for this dry run: ${plan.derived.join("; ")}`);
  if (rules === null) log("        tick, lot and minimum size unchecked: GET /markets is signed and there are no credentials");
  log(`ids     ${clientIdFor(runId, "entry")}, ${clientIdFor(runId, "tp")}, ${clientIdFor(runId, "sl")}`);
}

function reportProtected(legs: Legs, outcome: Extract<Outcome, { kind: "protected" }>, log: Deps["log"]): void {
  log("interrupted. The exits are left resting, so the position stays protected:");
  log(`  take-profit ${legs.tp.id} trigger ${fmt(legs.tp.trigger)}`);
  log(`  stop-loss   ${legs.sl.id} trigger ${fmt(legs.sl.trigger)}`);
  if (outcome.snapshot !== null) log(`  last read: ${summarise(outcome.snapshot)}`);
  log(`  Nothing links them now. If one fills, cancel the other yourself: DELETE /orders/{id}?market_id=${legs.market}.`);
}

export async function runBracket(config: Config, deps: Deps): Promise<number> {
  const { log } = deps;
  const phase = (p: Phase): void => deps.onPhase?.(p);
  phase("reading");

  const venue = new Venue(config);
  const runId = config.runId ?? randomBytes(4).toString("hex");
  const f = config.bracket;
  log(
    `target  ${config.baseUrl} (${!config.baseUrlOverridden ? "testnet, play funds" : config.funds === "play" ? "overridden host, declared play funds" : "overridden host, funds not declared"}); ` +
      `ws ${config.wsUrl}/ws`,
  );
  log(`mode    ${config.live ? "LIVE: places the bracket and manages it" : "dry run: reads live data, sends no write of any kind"}`);

  let rules: MarketRules | null = null;
  if (venue.hasCredentials) {
    const markets = await venue.markets();
    rules = markets.map(readMarketRules).find((r) => r?.marketId === f.market) ?? null;
    if (rules === null) {
      log(`market ${f.market} is not listed here. Available: ${markets.map((m) => readMarketRules(m)?.marketId).filter(Boolean).join(", ")}`);
      return EXIT_REFUSED;
    }
    log(`market  ${rules.marketId}: tick ${fmt(rules.tick)}, lot ${fmt(rules.lot)}, min size ${fmt(rules.minSize)}`);
  }

  const { mark, ref } = await reference(venue, f.market, rules?.tick ?? null, log);
  let plan: Plan;
  try {
    plan = completePlan(f, ref, rules?.tick ?? null);
  } catch (error) {
    if (error instanceof PlanError) {
      log(`refused: ${error.message}`);
      return EXIT_REFUSED;
    }
    throw error;
  }
  printPlan(plan, rules, ref, runId, log);

  const problems = checkPlan(plan, rules, mark);
  for (const p of problems) log(`check   FAIL ${p}`);
  if (problems.length === 0) log(`check   ok: triggers on the right side of the entry limit${mark === null ? "" : " and the mark"}${rules === null ? "" : ", prices on tick, size on lot"}`);

  const blockers: string[] = [...problems];
  if (venue.hasCredentials) {
    const [cod, positions, open] = await Promise.all([venue.cancelOnDisconnect(), venue.positions(), venue.openOrders()]);
    // COD cancels resting orders when this app's socket drops, and the exits
    // are resting orders. The moment the socket drops is exactly the moment
    // the stop has to still be there.
    log(`account cancel-on-disconnect ${cod.active ? "ACTIVE" : cod.enabled ? "enabled but switched off venue-side" : "off"}`);
    if (cod.active) blockers.push("cancel-on-disconnect is active: a dropped socket would cancel the exits, the one time they must survive");
    const held = readPositionSize(positions, f.market);
    const resting = open.map(readOrder).filter((o) => o?.market === f.market).length;
    log(`account ${f.market}: position ${held === null ? "unreadable" : fmt(held)}, ${resting} open order(s)`);
    if (held === null || !dec.isZero(held)) blockers.push(`the account must be flat in ${f.market}: reduce-only exits sized to this entry would also act on the existing position`);
    if (resting > 0) blockers.push(`the account has ${resting} open order(s) in ${f.market}; this app only manages a bracket it placed into a clean market`);
  } else {
    log("account unread: no credentials, so cancel-on-disconnect, the position and open orders are unchecked");
  }

  const entry = entryOrder(plan, runId);
  if (!config.live) {
    const exits = exitOrders(plan, runId, plan.size);
    log("would send, in this order (exit quantity is the entry's *filled* size; shown here as if it fills in full):");
    log(`  POST /orders ${bodyLine(entry)}`);
    log(`  POST /orders ${bodyLine(exits.sl)}`);
    log(`  POST /orders ${bodyLine(exits.tp)}`);
    log(`  then hold /ws orders+fills, and cancel the survivor with DELETE /api/v1/orders/{id}?market_id=${plan.market}`);
    for (const b of blockers.filter((b) => !problems.includes(b))) log(`live would refuse: ${b}`);
    log(problems.length > 0 ? "dry run: nothing was sent, and --live would refuse this plan." : "dry run: nothing was sent.");
    return problems.length > 0 ? EXIT_REFUSED : EXIT_OK;
  }
  if (blockers.length > 0) {
    for (const b of blockers.filter((b) => !problems.includes(b))) log(`refused: ${b}`);
    log("nothing was sent.");
    return EXIT_REFUSED;
  }

  // From here the process has, or may have, a position. A signal is noticed
  // only by the manage loop, so the exits always get placed first.
  phase("placing");
  const placedEntry = await placeOne(venue, entry, "entry", log);
  if (placedEntry.id === null) {
    if (placedEntry.unknown) {
      log(`the entry's outcome is unknown and it was not resent. Check ${plan.market} on the account before running again.`);
      return EXIT_UNRESOLVED;
    }
    return EXIT_ERROR;
  }
  const filled = await entryFilled(venue, placedEntry.response, placedEntry.id);
  log(`entry filled ${fmt(filled)} of ${fmt(plan.size)}${dec.compare(filled, plan.size) < 0 ? " (IOC: the rest was cancelled by the venue)" : ""}`);
  if (!dec.isPositive(filled)) {
    log("nothing filled, so there is nothing to protect. Done.");
    phase("finished");
    return EXIT_OK;
  }

  const exits = exitOrders(plan, runId, filled);
  // The stop goes first. Between the two placements the position has exactly
  // one exit, and that one had better be the one that limits the loss.
  const sl = await placeOne(venue, exits.sl, `stop-loss ${exits.sl.quantity} @ trigger ${exits.sl.trigger_price}`, log);
  if (sl.id === null) {
    log(`UNPROTECTED: position ${fmt(filled)} ${plan.market} has no stop. ${sl.unknown ? "The stop's outcome is unknown and it was not resent." : ""}`.trimEnd());
    log("If the venue refused the trigger as already crossed, its reading of 'adverse' differs from this app's (see README).");
    return EXIT_UNRESOLVED;
  }
  const tp = await placeOne(venue, exits.tp, `take-profit ${exits.tp.quantity} @ trigger ${exits.tp.trigger_price}`, log);
  if (tp.id === null) {
    log(`the position is protected by the stop ${sl.id}, but has no take-profit, so there is nothing to cancel against. Exiting with the stop resting.`);
    return EXIT_UNRESOLVED;
  }

  const legs: Legs = {
    market: plan.market,
    tp: { id: tp.id, quantity: filled, trigger: plan.tp },
    sl: { id: sl.id, quantity: filled, trigger: plan.sl },
  };
  phase("managing");
  log("managing: one-cancels-other over /ws orders+fills, every decision from a REST read. Ctrl-C leaves both exits resting.");
  const watcher = new Watcher(venue, legs, {
    wsUrl: config.wsUrl,
    reconcileMs: config.reconcileMs,
    signal: deps.signal,
    log,
    ...(deps.WebSocketImpl === undefined ? {} : { WebSocketImpl: deps.WebSocketImpl }),
    ...(deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
  });
  const outcome = await watcher.run();
  phase("finished");
  switch (outcome.kind) {
    case "done":
      log(`done: ${outcome.why}. Nothing of this bracket is resting.`);
      return EXIT_OK;
    case "unprotected":
      log(`UNPROTECTED: ${outcome.why}. Not replacing the stop automatically; a human should look.`);
      return EXIT_UNRESOLVED;
    case "protected":
      reportProtected(legs, outcome, log);
      return EXIT_INTERRUPTED;
    case "error":
      log(`stopped managing: ${outcome.why}. Both exits were left resting.`);
      return EXIT_UNRESOLVED;
  }
}

export { describe };
