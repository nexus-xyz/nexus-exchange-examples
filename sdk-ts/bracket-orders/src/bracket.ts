// The bracket itself, as pure functions: what to send, how to read what the
// venue sends back, and what one-cancels-other means for a given snapshot.
//
// Nothing here does I/O, so every decision this app makes about someone's
// position can be tested as a table (see bracket.test.ts).

import type { OrderRequest } from "@nexus-xyz/exchange-ts";

import type { BracketFlags, Side } from "./config.js";
import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";

export class PlanError extends Error {}

const fmt = dec.formatTrimmed;

// ── Reading the venue ───────────────────────────────────────────────────────

/**
 * First present field among several spellings.
 *
 * The live venue answers with CCXT field names (`symbol`, `clientOrderId`,
 * `filled`, `amount`) where spec v0.8.1 and the SDK types say `market_id`,
 * `client_id`, `filled_qty`, `quantity`. Reading both is the only way to be
 * right about the wire that exists and the contract that's written down.
 * Same readers as `sdk-ts/twap-executor`.
 */
function field(r: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (r[n] !== undefined && r[n] !== null) return r[n];
  return undefined;
}

/** A decimal field, whether the wire sent a string or a JSON number. */
function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function decimalOf(value: unknown): Dec | null {
  const t = text(value);
  if (t === null) return null;
  try {
    return dec.parse(t);
  } catch {
    return null;
  }
}

export interface MarketRules {
  readonly marketId: string;
  readonly tick: Dec;
  readonly lot: Dec;
  readonly minSize: Dec;
}

export function readMarketRules(raw: unknown): MarketRules | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "market_id", "id", "symbol"));
  const tick = decimalOf(field(r, "tick_size"));
  const lot = decimalOf(field(r, "lot_size"));
  const minSize = decimalOf(field(r, "min_order_size"));
  if (id === null || tick === null || lot === null || minSize === null) return null;
  if (!dec.isPositive(tick) || !dec.isPositive(lot)) {
    throw new PlanError(`${id}: tick ${fmt(tick)} / lot ${fmt(lot)} cannot be traded on`);
  }
  return { marketId: id, tick, lot, minSize };
}

/** Where an order stands, reduced to what one-cancels-other needs to know. */
export type OrderState = "open" | "filled" | "gone" | "unknown";

/**
 * Normalise a status from either vocabulary.
 *
 * Spec: `Open`, `PartiallyFilled`, `Filled`, `Cancelled`, `Expired`,
 * `Rejected`. CCXT: `open`, `closed` (which means *filled*), `canceled`,
 * `expired`, `rejected`. Anything else is `unknown`, and `unknown` is never
 * acted on: it holds the bracket as it is until a read says more.
 */
export function normaliseStatus(raw: string | null): OrderState {
  switch ((raw ?? "").toLowerCase()) {
    case "open":
    case "partiallyfilled":
    case "partially_filled":
    case "new":
    case "untriggered":
      return "open";
    case "filled":
    case "closed":
      return "filled";
    case "cancelled":
    case "canceled":
    case "expired":
    case "rejected":
      return "gone";
    default:
      return "unknown";
  }
}

export interface VenueOrder {
  readonly id: string;
  readonly clientId: string | null;
  readonly market: string | null;
  readonly state: OrderState;
  readonly status: string | null;
  readonly filled: Dec;
  readonly quantity: Dec | null;
  /** `cancellation_reason`, flattened to one string (the `{"Stp": …}` form included). */
  readonly reason: string | null;
}

function reasonOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const [key, inner] = Object.entries(value as Record<string, unknown>)[0] ?? [];
    return key === undefined ? null : `${key}(${String(inner)})`;
  }
  return null;
}

export function readOrder(raw: unknown): VenueOrder | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "id", "order_id"));
  if (id === null) return null;
  const status = text(field(r, "status"));
  return {
    id,
    clientId: text(field(r, "clientOrderId", "client_order_id", "client_id")),
    market: text(field(r, "symbol", "market_id")),
    state: normaliseStatus(status),
    status,
    filled: decimalOf(field(r, "filled", "filled_qty")) ?? dec.ZERO,
    quantity: decimalOf(field(r, "amount", "quantity", "size")),
    reason: reasonOf(field(r, "cancellation_reason", "cancellationReason")),
  };
}

export interface VenueFill {
  readonly id: string;
  readonly orderId: string;
  readonly size: Dec;
}

/** An account fill. `GET /fills` keeps `order_id` and `size`; a placement's `ExecutionFill` says `quantity`. */
export function readFill(raw: unknown, orderIdFallback: string | null = null): VenueFill | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(field(r, "id", "trade_id"));
  const orderId = text(field(r, "order_id", "order")) ?? orderIdFallback;
  const size = decimalOf(field(r, "size", "quantity", "amount"));
  if (id === null || orderId === null || size === null) return null;
  return { id, orderId, size };
}

/**
 * The absolute position size in one market, or `null` if it couldn't be read.
 *
 * `null` is not zero. A position read that failed to decode must never look
 * like "flat", because flat is the one reading that makes this app cancel
 * both exits.
 */
export function readPositionSize(rows: readonly unknown[], market: string): Dec | null {
  let matched = false;
  let total = dec.ZERO;
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (text(field(r, "market_id", "symbol")) !== market) continue;
    const size = decimalOf(field(r, "size", "contracts", "quantity"));
    if (size === null) return null;
    matched = true;
    total = dec.add(total, size.units < 0n ? { units: -size.units, scale: size.scale } : size);
  }
  // No row for the market is how a flat position reads, since `GET /positions`
  // lists open positions only.
  return matched ? total : dec.ZERO;
}

// ── Planning ────────────────────────────────────────────────────────────────

export type ExitKind = "tp" | "sl";

/** The venue's `client_id`: not in spec v0.8.1 or the SDK 0.4.0 types, but accepted by the live venue. */
export type BracketOrder = OrderRequest & { client_id: string };

export function exitSide(side: Side): Side {
  return side === "Buy" ? "Sell" : "Buy";
}

export function clientIdFor(runId: string, leg: "entry" | ExitKind): string {
  return `br-${runId}-${leg}`;
}

export interface Plan {
  readonly market: string;
  readonly side: Side;
  readonly size: Dec;
  readonly limit: Dec;
  readonly tp: Dec;
  readonly sl: Dec;
  /** Where the prices came from: `flags`, or derived from `reference` for a dry run. */
  readonly derived: readonly string[];
}

/** Default distances for a dry run that wasn't given prices. Illustrative only; `--live` refuses them. */
export const DRY_LIMIT_BPS = 10n;
export const DRY_TP_BPS = 100n;
export const DRY_SL_BPS = 50n;

function offset(price: Dec, bps: bigint, up: boolean): Dec {
  const delta = dec.mul(price, { units: bps, scale: 4 });
  return up ? dec.add(price, delta) : dec.sub(price, delta);
}

function snap(price: Dec, tick: Dec | null, up: boolean): Dec {
  if (tick === null) return price;
  return up ? dec.ceilToMultiple(price, tick) : dec.floorToMultiple(price, tick);
}

/**
 * Fill in any price the dry run wasn't given, from a reference price.
 *
 * Only ever used without `--live`, which requires all three prices: a bracket
 * that trades is placed at prices a person chose, not at distances an example
 * picked. Each derived price is snapped *away* from the reference, so rounding
 * never moves a stop closer to the market than intended.
 */
export function completePlan(flags: BracketFlags, reference: Dec | null, tick: Dec | null): Plan {
  const long = flags.side === "Buy";
  const derived: string[] = [];
  const pick = (given: Dec | null, name: string, bps: bigint, up: boolean): Dec => {
    if (given !== null) return given;
    if (reference === null) {
      throw new PlanError(
        `no ${name} was given and there is no reference price to derive one from ` +
          "(no mark price and an empty book). Pass --limit, --tp and --sl to see the plan anyway.",
      );
    }
    derived.push(`${name} = reference ${up ? "+" : "-"} ${bps} bps`);
    return snap(offset(reference, bps, up), tick, up);
  };
  return {
    market: flags.market,
    side: flags.side,
    size: flags.size,
    limit: pick(flags.limit, "--limit", DRY_LIMIT_BPS, long),
    tp: pick(flags.tp, "--tp", DRY_TP_BPS, long),
    sl: pick(flags.sl, "--sl", DRY_SL_BPS, !long),
    derived,
  };
}

/**
 * Everything wrong with a plan, before a single order is sent.
 *
 * The trigger-side checks are this app's reading of a gap in the spec. Spec
 * v0.8.1 says `StopMarket` fires "when the mark price crosses `trigger_price`
 * in the adverse direction" and `TakeProfitMarket` "on the favorable
 * direction", and doesn't say adverse *for whom* or which way that is per side.
 * This app reads it relative to the position the exit closes: for a long
 * (Sell exits) the stop sits below the mark and the take-profit above it; for a
 * short, the mirror. A plan that puts either trigger on the other side of the
 * mark is refused, because under *some* reading of the spec it fires the moment
 * it's placed.
 */
export function checkPlan(plan: Plan, rules: MarketRules | null, mark: Dec | null): string[] {
  const problems: string[] = [];
  const long = plan.side === "Buy";
  const below = (a: Dec, b: Dec) => dec.compare(a, b) < 0;

  // Against the entry's price guard: a take-profit that isn't beyond the worst
  // entry price can close at a loss, and a stop that isn't on the losing side
  // of it is not a stop.
  if (long ? !below(plan.limit, plan.tp) : !below(plan.tp, plan.limit)) {
    problems.push(`take-profit ${fmt(plan.tp)} must be ${long ? "above" : "below"} the entry limit ${fmt(plan.limit)}`);
  }
  if (long ? !below(plan.sl, plan.limit) : !below(plan.limit, plan.sl)) {
    problems.push(`stop-loss ${fmt(plan.sl)} must be ${long ? "below" : "above"} the entry limit ${fmt(plan.limit)}`);
  }
  if (mark !== null) {
    if (long ? !below(mark, plan.tp) : !below(plan.tp, mark)) {
      problems.push(`take-profit ${fmt(plan.tp)} is not ${long ? "above" : "below"} the mark ${fmt(mark)}: it could fire on placement`);
    }
    if (long ? !below(plan.sl, mark) : !below(mark, plan.sl)) {
      problems.push(`stop-loss ${fmt(plan.sl)} is not ${long ? "below" : "above"} the mark ${fmt(mark)}: it could fire on placement`);
    }
  }
  if (rules !== null) {
    for (const [name, price] of [["entry limit", plan.limit], ["take-profit", plan.tp], ["stop-loss", plan.sl]] as const) {
      if (!dec.isMultiple(price, rules.tick)) problems.push(`${name} ${fmt(price)} is not on the ${fmt(rules.tick)} tick grid`);
    }
    if (!dec.isMultiple(plan.size, rules.lot)) problems.push(`size ${fmt(plan.size)} is not a multiple of the ${fmt(rules.lot)} lot`);
    if (dec.compare(plan.size, rules.minSize) < 0) problems.push(`size ${fmt(plan.size)} is below the market minimum ${fmt(rules.minSize)}`);
  }
  return problems;
}

/**
 * The entry: an IOC limit at the price guard.
 *
 * IOC on purpose. Whatever fills, fills on arrival, and the rest is cancelled
 * by the venue, so the quantity the exits must cover is final when the
 * placement answers. A resting (GTC) entry would keep growing the position
 * after the exits were sized, and every new fill would leave some of it
 * unprotected until the exits were resized, which (see `decide`) this app
 * doesn't do because amending a conditional order is unspecified.
 */
export function entryOrder(plan: Plan, runId: string): BracketOrder {
  return {
    market_id: plan.market,
    side: plan.side,
    order_type: "Limit",
    price: fmt(plan.limit),
    quantity: fmt(plan.size),
    time_in_force: "IOC",
    client_id: clientIdFor(runId, "entry"),
  };
}

/**
 * The two exits, sized to what the entry **actually filled**.
 *
 * Native conditional orders, so the venue fires them whether or not this
 * process is alive. Market-on-trigger (`TakeProfitMarket`, `StopMarket`)
 * rather than the limit variants: a stop that fires into a gap and then rests
 * as an unfilled limit is not a stop. `reduce_only`, so neither can open a
 * position. `GTC`, because spec v0.8.1 requires a `time_in_force` on every
 * order and doesn't say whether it governs the untriggered order or the order
 * it fires; GTC is the only reading under which a trigger can wait at all.
 */
export function exitOrders(plan: Plan, runId: string, filled: Dec): Record<ExitKind, BracketOrder> {
  const base = {
    market_id: plan.market,
    side: exitSide(plan.side),
    quantity: fmt(filled),
    time_in_force: "GTC" as const,
    reduce_only: true,
  };
  return {
    tp: { ...base, order_type: "TakeProfitMarket", trigger_price: fmt(plan.tp), client_id: clientIdFor(runId, "tp") },
    sl: { ...base, order_type: "StopMarket", trigger_price: fmt(plan.sl), client_id: clientIdFor(runId, "sl") },
  };
}

// ── One-cancels-other ───────────────────────────────────────────────────────

/** What a reconcile found for one exit. `missing`: in neither open orders nor history. */
export interface LegView {
  readonly state: OrderState | "missing";
  readonly filled: Dec;
  readonly quantity: Dec;
  readonly reason: string | null;
}

export interface Snapshot {
  readonly tp: LegView;
  readonly sl: LegView;
  /** Absolute position size in the market, or `null` if it couldn't be read. */
  readonly position: Dec | null;
}

export type Decision =
  /** Nothing to do. `note` says why, when there's something worth saying. */
  | { readonly kind: "hold"; readonly note: string | null }
  /** Cancel these legs. The bracket is finished once they're gone. */
  | { readonly kind: "cancel"; readonly legs: readonly ExitKind[]; readonly why: string }
  /** Finished; nothing is resting. */
  | { readonly kind: "done"; readonly why: string }
  /** The position is open and the stop is not protecting it. Needs a human. */
  | { readonly kind: "unprotected"; readonly why: string };

const live = (leg: LegView): boolean => leg.state === "open";
const name = (leg: ExitKind): string => (leg === "tp" ? "take-profit" : "stop-loss");

function fullyFilled(leg: LegView): boolean {
  return leg.state === "filled" || (dec.isPositive(leg.quantity) && dec.compare(leg.filled, leg.quantity) >= 0);
}

/**
 * One-cancels-other, as a pure function of one REST snapshot.
 *
 * It is always a snapshot, never a WebSocket frame, that decides. The payload
 * shapes of the `orders` and `fills` channels aren't in spec v0.8.1, and a
 * decision that cancels someone's stop should rest on the documented reads.
 * The socket is what makes this app look *now* rather than at the next poll.
 *
 * The rules, in order:
 *
 *  1. An exit filled: cancel the other one. That is the whole OCO.
 *  2. The position is flat but an exit is still live (closed by hand, or
 *     liquidated): cancel what's left. A reduce-only order with nothing to
 *     reduce is harmless until you open a new position in the same market,
 *     and then it's an order you didn't place for this one.
 *  3. The stop is gone without filling while the position is open (the venue
 *     cancelled it: `InsufficientLiquidity` on fire, a market halt, a
 *     liquidation sweep): **unprotected**. The take-profit is left alone,
 *     because cancelling it would make the position more exposed, not less.
 *  4. A partial exit fill: hold. The sibling keeps its full size and this app
 *     relies on `reduce_only` to stop it closing more than is left. That's a
 *     reliance on behaviour spec v0.8.1 doesn't describe, stated in the README,
 *     and the alternative (cancel and re-place the sibling smaller) opens a
 *     window where the stop doesn't exist, or needs an amend of a conditional
 *     order that the spec doesn't say is possible.
 *  5. Anything unread or `unknown`: hold, and read again. Never act on a
 *     guess.
 */
export function decide(s: Snapshot): Decision {
  const legs: readonly ExitKind[] = ["tp", "sl"];
  const filled = legs.filter((l) => fullyFilled(s[l]));

  if (filled.length === 2) {
    return { kind: "done", why: "both exits report filled. reduce_only should have prevented that; check the position" };
  }
  if (filled.length === 1) {
    const winner = filled[0] as ExitKind;
    const loser: ExitKind = winner === "tp" ? "sl" : "tp";
    if (live(s[loser])) return { kind: "cancel", legs: [loser], why: `${name(winner)} filled` };
    return { kind: "done", why: `${name(winner)} filled; ${name(loser)} is already off the book` };
  }

  const open = legs.filter((l) => live(s[l]));
  if (s.position !== null && dec.isZero(s.position)) {
    if (open.length > 0) return { kind: "cancel", legs: open, why: "the position is flat, so there is nothing left to protect" };
    return { kind: "done", why: "the position is flat and neither exit is resting" };
  }

  if (s.sl.state === "gone") {
    const why = `the stop-loss was removed by the venue without filling (${s.sl.reason ?? "no reason given"})`;
    return { kind: "unprotected", why: live(s.tp) ? `${why}; the take-profit is still resting` : why };
  }
  if (s.tp.state === "gone" && live(s.sl)) {
    return { kind: "hold", note: `take-profit removed by the venue (${s.tp.reason ?? "no reason given"}); the stop still protects the position` };
  }

  const partial = legs.find((l) => live(s[l]) && dec.isPositive(s[l].filled));
  if (partial !== undefined) {
    const other: ExitKind = partial === "tp" ? "sl" : "tp";
    return {
      kind: "hold",
      note: `${name(partial)} partly filled (${fmt(s[partial].filled)} of ${fmt(s[partial].quantity)}); ${name(other)} stays full size, relying on reduce_only`,
    };
  }

  const unread = legs.filter((l) => s[l].state === "missing" || s[l].state === "unknown");
  if (unread.length > 0) return { kind: "hold", note: `${unread.map(name).join(" and ")} not visible yet; reading again` };
  if (s.position === null) return { kind: "hold", note: "position unreadable; not acting on a guess" };
  return { kind: "hold", note: null };
}

/**
 * Build the snapshot one exit contributes, from what the reconcile read.
 *
 * Open orders win over history, because an order can move from one to the
 * other between the two reads and resting is the fresher fact. The filled
 * quantity is the larger of what the order record says and what `/fills`
 * sums to, since either can lag the other.
 */
export function legView(
  orderId: string,
  quantity: Dec,
  open: readonly VenueOrder[],
  history: readonly VenueOrder[],
  fills: readonly VenueFill[],
): LegView {
  const found = open.find((o) => o.id === orderId) ?? history.find((o) => o.id === orderId) ?? null;
  const fromFills = fills.filter((f) => f.orderId === orderId).reduce((acc, f) => dec.add(acc, f.size), dec.ZERO);
  const filled = dec.max(found?.filled ?? dec.ZERO, fromFills);
  if (found === null) {
    // Not listed anywhere, but fully filled by the fills feed: that's a fill.
    return dec.compare(filled, quantity) >= 0
      ? { state: "filled", filled, quantity, reason: null }
      : { state: "missing", filled, quantity, reason: null };
  }
  return { state: found.state, filled, quantity: found.quantity ?? quantity, reason: found.reason };
}
