// The whole of the trading logic, kept pure: numbers in, decisions out.
//
// Nothing in here talks to the venue, reads the clock, or touches the journal.
// That's what lets `plan.test.ts` pin every property the README claims (slices
// sum to the parent exactly, a child never crosses the guard, a resume matches
// the right orders) without a network or a key.

import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";

export class PlanError extends Error {}

export type Side = "Buy" | "Sell";

/** The market parameters a TWAP needs, read off whatever shape the venue served. */
export interface MarketRules {
  readonly marketId: string;
  readonly tick: Dec;
  readonly lot: Dec;
  readonly minSize: Dec;
  readonly maxSize: Dec | null;
}

export interface Parent {
  readonly market: string;
  readonly side: Side;
  readonly size: Dec;
  readonly durationMs: number;
  readonly slices: number;
  /** The worst price any child may trade at. `null` only in a dry run. */
  readonly limit: Dec | null;
}

/**
 * How far one slice may exceed its even share to catch up on earlier shortfall.
 *
 * A slice that found no liquidity (or was skipped, or missed while the process
 * was down) leaves its quantity behind, and the next slice's cumulative target
 * picks it up. Uncapped, one missed hour would arrive as a single order, which
 * is the opposite of what a TWAP is for. At 2x, a shortfall is worked off over
 * the following slices, and anything still left at the end is reported as
 * unfilled rather than dumped.
 */
export const CATCH_UP_CAP = 2n;

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (record[name] !== undefined && record[name] !== null) return record[name];
  return undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

/**
 * Read a `Market` structurally.
 *
 * The SDK types it with spec v0.8.1's names (`market_id`), but the live venue
 * renamed that to CCXT's `id` (ENG-13528) while keeping `tick_size` and
 * friends. Reading both spellings is the honest middle. A cast to the SDK type
 * would read `undefined` for the id on today's venue and find no market at all.
 */
export function readMarketRules(raw: unknown): MarketRules | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "market_id", "id", "symbol"));
  const tick = text(field(r, "tick_size"));
  const lot = text(field(r, "lot_size"));
  const minSize = text(field(r, "min_order_size"));
  const maxSize = text(field(r, "max_order_size"));
  if (id === null || tick === null || lot === null || minSize === null) return null;
  const rules: MarketRules = {
    marketId: id,
    tick: dec.parse(tick),
    lot: dec.parse(lot),
    minSize: dec.parse(minSize),
    maxSize: maxSize === null ? null : dec.parse(maxSize),
  };
  if (!dec.isPositive(rules.tick) || !dec.isPositive(rules.lot)) {
    throw new PlanError(`${id}: tick ${tick} / lot ${lot} cannot be traded on`);
  }
  return rules;
}

/** One slot in the schedule. Quantities are in whole lots. */
export interface SliceSlot {
  readonly index: number;
  /** Milliseconds after the run's start. */
  readonly offsetMs: number;
  /** Lots the parent should have filled once this slice has run. */
  readonly cumulativeLots: bigint;
}

export interface Schedule {
  readonly totalLots: bigint;
  /** The even share, rounded up: the unit `CATCH_UP_CAP` multiplies. */
  readonly baseLots: bigint;
  readonly slots: readonly SliceSlot[];
}

/**
 * Split the parent into `slices` slots over `durationMs`.
 *
 * All the arithmetic is integer division on **lots**, never decimal division
 * on sizes. The cumulative target after slot `i` is
 * `floor(totalLots × (i+1) / slices)`, so the last one is exactly
 * `totalLots` and the per-slot differences always sum to the parent. There's
 * no remainder to lose and no "dust" child at the end.
 *
 * Slot `i` is due at `durationMs × i / slices`: the first immediately, the last
 * one interval before the end.
 */
export function buildSchedule(parent: Parent, rules: MarketRules | null): Schedule {
  if (!Number.isInteger(parent.slices) || parent.slices < 1) {
    throw new PlanError(`slices must be a whole number of at least 1, got ${parent.slices}`);
  }
  if (!dec.isPositive(parent.size)) throw new PlanError("size must be greater than zero");
  // Without market rules (a dry run with no credentials) the lot is taken to
  // be the parent's own last decimal place, so the schedule is still exact.
  // It's printed as unchecked, and `--live` can't reach this path.
  const lot = rules?.lot ?? { units: 1n, scale: parent.size.scale };
  const { count: totalLots, exact } = dec.countSteps(parent.size, lot);
  if (!exact) {
    throw new PlanError(
      `size ${dec.formatTrimmed(parent.size)} is not a multiple of the ${dec.formatTrimmed(lot)} lot size. ` +
        `Nearest below is ${dec.formatTrimmed(dec.floorToMultiple(parent.size, lot))}.`,
    );
  }
  const n = BigInt(parent.slices);
  if (totalLots < n) {
    throw new PlanError(
      `${totalLots} lot(s) cannot be split into ${parent.slices} slices. ` +
        "Use fewer slices or a larger size.",
    );
  }
  if (rules !== null) {
    const even = dec.times(lot, totalLots / n);
    if (dec.compare(even, rules.minSize) < 0) {
      throw new PlanError(
        `an even slice would be ${dec.formatTrimmed(even)}, below ${rules.marketId}'s ` +
          `${dec.formatTrimmed(rules.minSize)} minimum order size. Use fewer slices or a larger size.`,
      );
    }
  }
  const slots: SliceSlot[] = [];
  for (let i = 0; i < parent.slices; i += 1) {
    slots.push({
      index: i,
      offsetMs: Math.floor((parent.durationMs * i) / parent.slices),
      cumulativeLots: (totalLots * BigInt(i + 1)) / n,
    });
  }
  return { totalLots, baseLots: (totalLots + n - 1n) / n, slots };
}

/**
 * Lots the child for `slot` should ask for, given what has filled so far.
 *
 * The cumulative target minus what's filled, so a shortfall rolls forward,
 * capped at `CATCH_UP_CAP` even shares so it rolls forward gently. Zero when
 * the parent is on or ahead of schedule.
 */
export function childLots(schedule: Schedule, slot: SliceSlot, filledLots: bigint): bigint {
  const behind = slot.cumulativeLots - filledLots;
  if (behind <= 0n) return 0n;
  const capped = behind < schedule.baseLots * CATCH_UP_CAP ? behind : schedule.baseLots * CATCH_UP_CAP;
  const left = schedule.totalLots - filledLots;
  return capped < left ? capped : left;
}

/** Top of book, as exact decimals. `null` for an empty side. */
export interface Touch {
  readonly bid: Dec | null;
  readonly ask: Dec | null;
}

/**
 * Read the best bid and ask off a CCXT-shaped book.
 *
 * Levels arrive as JSON numbers, so each is read through its shortest
 * round-trip string (`decimal.fromJsonNumber`). When the tick is known, a
 * price that lands off the grid is refused: the only way the venue's own book
 * shows an off-grid price is that digits were lost on the way here, and a
 * child priced from it would be rejected for the tick anyway.
 */
export function readTouch(
  book: { bids: ReadonlyArray<readonly [number, number]>; asks: ReadonlyArray<readonly [number, number]> },
  tick: Dec | null,
): Touch {
  const read = (level: readonly [number, number] | undefined, side: string): Dec | null => {
    if (level === undefined) return null;
    const price = dec.fromJsonNumber(level[0]);
    if (tick !== null && !dec.isMultiple(price, tick)) {
      throw new PlanError(
        `best ${side} ${dec.format(price)} is not on the ${dec.formatTrimmed(tick)} tick grid: ` +
          "the book's JSON number lost precision on the way in. Refusing to price from it.",
      );
    }
    return price;
  };
  return { bid: read(book.bids[0], "bid"), ask: read(book.asks[0], "ask") };
}

/** The mid, to two more places than the tick. `null` unless both sides exist. */
export function midOf(touch: Touch, tick: Dec | null): Dec | null {
  if (touch.bid === null || touch.ask === null) return null;
  const digits = (tick?.scale ?? Math.max(touch.bid.scale, touch.ask.scale)) + 2;
  return dec.divRound(dec.add(touch.bid, touch.ask), { units: 2n, scale: 0 }, digits);
}

export type PriceDecision =
  | { readonly kind: "price"; readonly price: Dec }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * The limit price for one IOC child, or why there shouldn't be one.
 *
 * **At the touch, and never through the guard.** A buy is priced at the best
 * ask and a sell at the best bid, so a child takes what is displayed at the
 * top of the book and no deeper. When the touch is already beyond the
 * parent's limit, the slice is skipped: its quantity rolls into the next
 * slice, which is the TWAP waiting for the market to come back, not chasing
 * it. Because the child is IOC, the venue enforces the same bound on its side.
 * An IOC limit order cannot fill worse than its price, and its unfilled
 * remainder is cancelled rather than left resting.
 */
export function priceChild(side: Side, touch: Touch, limit: Dec | null): PriceDecision {
  const touchPrice = side === "Buy" ? touch.ask : touch.bid;
  if (touchPrice === null) {
    return { kind: "skip", reason: `no ${side === "Buy" ? "asks" : "bids"} on the book` };
  }
  if (limit !== null) {
    const beyond = side === "Buy" ? dec.compare(touchPrice, limit) > 0 : dec.compare(touchPrice, limit) < 0;
    if (beyond) {
      return {
        kind: "skip",
        reason:
          `best ${side === "Buy" ? "ask" : "bid"} ${dec.formatTrimmed(touchPrice)} is beyond ` +
          `the ${dec.formatTrimmed(limit)} limit`,
      };
    }
  }
  return { kind: "price", price: touchPrice };
}

/** One execution, as this app records it. */
export interface FillRecord {
  readonly id: string;
  readonly price: string;
  readonly size: string;
}

export interface Summary {
  readonly target: Dec;
  readonly filled: Dec;
  /** `null` when nothing filled. */
  readonly vwap: Dec | null;
  readonly arrivalMid: Dec | null;
  /**
   * Signed so that **positive is worse**: a buy that paid above arrival, or a
   * sell that received below it. `null` without both a VWAP and an arrival mid.
   */
  readonly slippageBps: Dec | null;
}

/**
 * Filled vs target, VWAP vs arrival mid, slippage.
 *
 * VWAP is `Σ(price × size) / Σ size`, with both sums exact and the single
 * division rounded half-away-from-zero, four places past the tick. Slippage
 * is `(vwap − mid) / mid × 10,000`, to two places, negated for a sell.
 */
export function summarise(
  side: Side,
  target: Dec,
  fills: readonly FillRecord[],
  arrivalMid: Dec | null,
  tick: Dec | null,
): Summary {
  let filled = dec.ZERO;
  let notional = dec.ZERO;
  for (const fill of fills) {
    const size = dec.parse(fill.size);
    filled = dec.add(filled, size);
    notional = dec.add(notional, dec.mul(dec.parse(fill.price), size));
  }
  const digits = (tick?.scale ?? 2) + 4;
  const vwap = dec.isZero(filled) ? null : dec.divRound(notional, filled, digits);
  let slippageBps: Dec | null = null;
  if (vwap !== null && arrivalMid !== null && dec.isPositive(arrivalMid)) {
    const diff = side === "Buy" ? dec.sub(vwap, arrivalMid) : dec.sub(arrivalMid, vwap);
    slippageBps = dec.divRound(dec.mul(diff, { units: 10_000n, scale: 0 }), arrivalMid, 2);
  }
  return { target, filled, vwap, arrivalMid, slippageBps };
}

/** An order as reconcile needs it, read across the venue's two vocabularies. */
export interface VenueOrder {
  readonly id: string;
  readonly clientId: string | null;
  readonly market: string | null;
  readonly status: string | null;
  readonly filled: string | null;
}

/**
 * Read an order's identity structurally.
 *
 * Spec v0.8.1 and the SDK say `market_id` / `filled_qty` and carry no client
 * id. The live venue serves CCXT's vocabulary (`symbol`, `filled`,
 * `clientOrderId`, ENG-13314/ENG-14207). A reconcile that reads only one
 * spelling silently matches nothing on the other, and "matched nothing" reads
 * as "never placed", which is the double-send this whole design exists to
 * prevent.
 */
export function readOrder(raw: unknown): VenueOrder | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "id", "order_id"));
  if (id === null) return null;
  return {
    id,
    clientId: text(field(r, "clientOrderId", "client_order_id", "client_id")),
    market: text(field(r, "symbol", "market_id")),
    status: text(field(r, "status")),
    filled: text(field(r, "filled", "filled_qty")),
  };
}

/** Read an account fill (`GET /fills`), which keeps `size` and `order_id`. */
export function readFill(raw: unknown): (FillRecord & { readonly orderId: string }) | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "id"));
  const orderId = text(field(r, "order_id"));
  const price = text(field(r, "price"));
  const size = text(field(r, "size", "quantity", "amount"));
  if (id === null || orderId === null || price === null || size === null) return null;
  return { id, orderId, price, size };
}

export interface Reconciled {
  readonly clientId: string;
  /** Where it was found, or `null` if the venue has no record of it. */
  readonly foundIn: "open" | "history" | null;
  readonly order: VenueOrder | null;
  readonly fills: readonly FillRecord[];
}

/**
 * Match the client ids a run *might* have placed against what the venue holds.
 *
 * The client id is what makes this a lookup rather than a guess. Without it,
 * the only way to tell "sent and filled" from "never sent" is comparing
 * prices and sizes, and a TWAP's children are identical by construction.
 *
 * Open orders are checked before history, because an order can move from one
 * to the other between the two reads. Seeing it resting is the fresher fact.
 * Fills are attached by venue order id, since that's the key `/fills` carries.
 */
export function reconcile(
  clientIds: readonly string[],
  open: readonly unknown[],
  history: readonly unknown[],
  fills: readonly unknown[],
): Reconciled[] {
  const byClient = new Map<string, { order: VenueOrder; where: "open" | "history" }>();
  for (const [where, list] of [
    ["history", history],
    ["open", open],
  ] as const) {
    for (const raw of list) {
      const order = readOrder(raw);
      if (order?.clientId != null) byClient.set(order.clientId, { order, where });
    }
  }
  const fillsByOrder = new Map<string, FillRecord[]>();
  for (const raw of fills) {
    const fill = readFill(raw);
    if (fill === null) continue;
    const list = fillsByOrder.get(fill.orderId) ?? [];
    list.push({ id: fill.id, price: fill.price, size: fill.size });
    fillsByOrder.set(fill.orderId, list);
  }
  return clientIds.map((clientId) => {
    const hit = byClient.get(clientId);
    if (hit === undefined) return { clientId, foundIn: null, order: null, fills: [] };
    return { clientId, foundIn: hit.where, order: hit.order, fills: fillsByOrder.get(hit.order.id) ?? [] };
  });
}

/** Deterministic child id: the same run and slice always produce the same key. */
export function clientIdFor(runId: string, index: number): string {
  return `twap-${runId}-${index}`;
}
