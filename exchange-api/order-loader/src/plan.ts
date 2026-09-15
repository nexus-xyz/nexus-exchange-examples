// Reading the order file, and refusing what should not be sent.
//
// Everything here happens before a single request. A bulk loader's worst
// failure mode is a partially-applied file — twenty orders resting, twenty
// rejected, and no clean way back — so the cheapest thing it can do is decide
// the whole file is placeable before it places any of it. Validation is against
// the venue's own trading rules, fetched once, rather than against constants:
// tick and lot sizes are per market and change with a listing.

import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";

/** A market's trading rules, from `GET /markets/summary`. */
export interface MarketSpec {
  readonly marketId: string;
  readonly tickSize: Dec;
  readonly lotSize: Dec;
  readonly minOrderSize: Dec;
  readonly maxOrderSize: Dec;
  readonly status: string;
  /** The engine mark, a JSON double, or null when the venue did not send one. */
  readonly markPrice: Dec | null;
}

/** One order from the file, validated and ready to send. */
export interface PlannedOrder {
  /** Position in the file, 0-based. Used in every message about it. */
  readonly index: number;
  readonly marketId: string;
  readonly side: "Buy" | "Sell";
  readonly price: Dec;
  readonly quantity: Dec;
  readonly timeInForce: string;
  readonly reduceOnly: boolean;
  /** Idempotency key. Supplied in the file, or derived — see `deriveClientId`. */
  readonly clientId: string;
  /** `price × quantity`, for reporting and for the preview policy. */
  readonly notional: Dec;
}

export interface Rejection {
  readonly index: number;
  readonly reason: string;
}

export interface Plan {
  readonly orders: readonly PlannedOrder[];
  readonly rejections: readonly Rejection[];
}

/**
 * Order types this loader will send.
 *
 * Deliberately one. `Market` and the six conditional types are all placeable
 * through the same endpoint, but a *bulk* loader that fires market orders is a
 * different and much sharper tool than this one, and the conditional types need
 * trigger and trailing fields this file does not model. Refusing them by name
 * is friendlier than accepting them and sending a body the venue rejects
 * per-order, forty entries deep in a response array.
 */
const SUPPORTED_ORDER_TYPE = "Limit";

/**
 * Time-in-force values that cannot take liquidity on entry.
 *
 * `PostOnly` is rejected by the venue if it would cross, which is a guarantee
 * that does not depend on this app's arithmetic. Everything else can fill, so
 * it needs `NEXUS_ALLOW_TAKER=1` — an explicit statement that filling is the
 * intent, rather than something a default let through.
 */
const MAKER_ONLY_TIF = new Set(["PostOnly"]);
const ALL_TIF = new Set(["GTC", "IOC", "FOK", "PostOnly"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a decimal-ish field from a JSON response.
 *
 * The market-data routes are CCXT-shaped and answer with a mix: `tick_size`
 * arrives as a string, `engine_mark_price` as a double. Both are accepted here
 * and both end up exact — see `decimal.ts` on why the crossing is the dangerous
 * part.
 */
function decimalField(
  entry: Record<string, unknown>,
  key: string,
  fallback: string,
): Dec {
  const raw = entry[key];
  if (typeof raw === "string") {
    try {
      return dec.fromString(raw);
    } catch {
      // Fall through: an unparseable tick size is a reason to use a safe
      // default, not a reason to abandon the run.
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return dec.fromString(String(raw));
  }
  return dec.fromString(fallback);
}

/** Parse `GET /markets/summary` into the rules this app validates against. */
export function parseMarkets(raw: unknown): Map<string, MarketSpec> {
  if (!Array.isArray(raw)) {
    throw new Error("GET /api/v1/markets/summary did not return a list");
  }
  const markets = new Map<string, MarketSpec>();
  for (const item of raw) {
    const entry = asRecord(item);
    if (entry === null) continue;
    const marketId = entry["market_id"];
    if (typeof marketId !== "string") continue;

    const tickSize = decimalField(entry, "tick_size", "0.01");
    const mark = entry["engine_mark_price"];
    markets.set(marketId, {
      marketId,
      tickSize,
      lotSize: decimalField(entry, "lot_size", "0.001"),
      minOrderSize: decimalField(entry, "min_order_size", "0.001"),
      maxOrderSize: decimalField(entry, "max_order_size", "1000"),
      status: typeof entry["status"] === "string" ? entry["status"] : "unknown",
      // The mark is a double. Snapping it to the market's own tick grid at the
      // crossing is what makes every comparison against it exact afterwards.
      markPrice:
        typeof mark === "number" && Number.isFinite(mark)
          ? dec.fromNumber(mark, tickSize.scale)
          : null,
    });
  }
  if (markets.size === 0) {
    throw new Error("GET /api/v1/markets/summary returned no usable markets");
  }
  return markets;
}

/**
 * Derive the idempotency key for an order the file did not name one for.
 *
 * `client_id` is what makes a retry safe: submitting the same key twice does
 * not place a second order — the venue answers with the one the first request
 * created. Without it, a batch whose response is lost leaves the caller unable
 * to tell "never arrived" from "arrived, accepted, reply lost", and the only
 * safe move is to reconcile by hand.
 *
 * The key is `<run>-<index>`, so it is stable across a retry *within* a run and
 * distinct between runs. Re-running the same file with the same
 * `NEXUS_RUN_ID` therefore places nothing new, which is occasionally exactly
 * what you want and is otherwise the reason the default is random.
 */
export function deriveClientId(runId: string, index: number): string {
  return `ol-${runId}-${index}`;
}

interface ValidateOptions {
  readonly markets: ReadonlyMap<string, MarketSpec>;
  readonly allowTaker: boolean;
  readonly runId: string;
}

function validateOne(
  entry: Record<string, unknown>,
  index: number,
  options: ValidateOptions,
): PlannedOrder | Rejection {
  const reject = (reason: string): Rejection => ({ index, reason });

  const marketId = entry["market_id"];
  if (typeof marketId !== "string") {
    return reject("market_id is missing or not a string");
  }
  const spec = options.markets.get(marketId);
  if (spec === undefined) {
    const known = [...options.markets.keys()].slice(0, 8).join(", ");
    return reject(`unknown market ${marketId}; the venue lists ${known}`);
  }
  if (spec.status !== "active") {
    return reject(`market ${marketId} is "${spec.status}", not active`);
  }

  const side = entry["side"];
  if (side !== "Buy" && side !== "Sell") {
    return reject('side must be exactly "Buy" or "Sell"');
  }

  const orderType = entry["order_type"] ?? SUPPORTED_ORDER_TYPE;
  if (orderType !== SUPPORTED_ORDER_TYPE) {
    return reject(
      `order_type ${JSON.stringify(orderType)} is not supported by this ` +
        `loader; it sends ${SUPPORTED_ORDER_TYPE} orders only`,
    );
  }

  const timeInForce = entry["time_in_force"] ?? "PostOnly";
  if (typeof timeInForce !== "string" || !ALL_TIF.has(timeInForce)) {
    return reject(
      `time_in_force must be one of ${[...ALL_TIF].join(", ")}, got ` +
        JSON.stringify(timeInForce),
    );
  }
  if (!options.allowTaker && !MAKER_ONLY_TIF.has(timeInForce)) {
    return reject(
      `time_in_force ${timeInForce} can take liquidity. This loader places ` +
        "PostOnly orders unless NEXUS_ALLOW_TAKER=1 says filling is the intent.",
    );
  }

  const rawPrice = entry["price"];
  if (typeof rawPrice !== "string") {
    return reject(
      "price must be a decimal string — a JSON number would round, and the " +
        "venue's Decimal fields are strings for exactly that reason",
    );
  }
  let price: Dec;
  try {
    price = dec.fromString(rawPrice);
  } catch (error) {
    return reject(`price: ${error instanceof Error ? error.message : "invalid"}`);
  }
  if (!dec.isPositive(price)) return reject("price must be positive");
  if (!dec.isMultipleOf(price, spec.tickSize)) {
    const below = dec.quantise(price, spec.tickSize, "floor");
    const above = dec.quantise(price, spec.tickSize, "ceil");
    return reject(
      `price ${rawPrice} is not a multiple of the ${dec.toString(spec.tickSize)} ` +
        `tick; nearest legal are ${dec.toString(below)} and ${dec.toString(above)}`,
    );
  }

  const rawQuantity = entry["quantity"];
  if (typeof rawQuantity !== "string") {
    return reject("quantity must be a decimal string");
  }
  let quantity: Dec;
  try {
    quantity = dec.fromString(rawQuantity);
  } catch (error) {
    return reject(
      `quantity: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
  if (!dec.isPositive(quantity)) return reject("quantity must be positive");
  if (!dec.isMultipleOf(quantity, spec.lotSize)) {
    return reject(
      `quantity ${rawQuantity} is not a multiple of the ` +
        `${dec.toString(spec.lotSize)} lot size`,
    );
  }
  if (dec.compare(quantity, spec.minOrderSize) < 0) {
    return reject(
      `quantity ${rawQuantity} is below the market minimum ` +
        dec.toString(spec.minOrderSize),
    );
  }
  if (dec.compare(quantity, spec.maxOrderSize) > 0) {
    return reject(
      `quantity ${rawQuantity} is above the market maximum ` +
        dec.toString(spec.maxOrderSize),
    );
  }

  const reduceOnlyRaw = entry["reduce_only"];
  if (reduceOnlyRaw !== undefined && typeof reduceOnlyRaw !== "boolean") {
    return reject("reduce_only must be a boolean when present");
  }

  const clientIdRaw = entry["client_id"];
  if (clientIdRaw !== undefined && typeof clientIdRaw !== "string") {
    return reject("client_id must be a string when present");
  }
  if (typeof clientIdRaw === "string" && clientIdRaw.length > 128) {
    return reject("client_id is longer than the 128 characters the venue accepts");
  }

  return {
    index,
    marketId,
    side,
    price,
    quantity,
    timeInForce,
    reduceOnly: reduceOnlyRaw === true,
    clientId: clientIdRaw ?? deriveClientId(options.runId, index),
    notional: dec.multiply(price, quantity),
  };
}

/** Validate a parsed order file against the venue's rules. */
export function planOrders(raw: unknown, options: ValidateOptions): Plan {
  if (!Array.isArray(raw)) {
    throw new Error(
      "the order file must be a JSON array of order objects; see " +
        "orders.example.json",
    );
  }

  const orders: PlannedOrder[] = [];
  const rejections: Rejection[] = [];
  const seenClientIds = new Set<string>();

  raw.forEach((item, index) => {
    const entry = asRecord(item);
    if (entry === null) {
      rejections.push({ index, reason: "not a JSON object" });
      return;
    }
    const result = validateOne(entry, index, options);
    if ("reason" in result) {
      rejections.push(result);
      return;
    }
    // A duplicate key inside one file is never intentional, and it is the one
    // mistake the idempotency guarantee turns into a *silent* short order: the
    // second submission is answered with the first order rather than placing
    // anything, so the file says forty and the book holds thirty-nine.
    if (seenClientIds.has(result.clientId)) {
      rejections.push({
        index,
        reason: `client_id ${result.clientId} is already used earlier in the file`,
      });
      return;
    }
    seenClientIds.add(result.clientId);
    orders.push(result);
  });

  return { orders, rejections };
}

/**
 * Split the plan into batch-sized chunks, preserving file order.
 *
 * Order matters: the venue processes a batch sequentially and non-atomically,
 * so an early order consuming margin can be why a later one in the same batch
 * fails. Reordering the file to pack chunks would change which orders those
 * are.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** The wire body for one order. */
export function toOrderRequest(order: PlannedOrder): Record<string, unknown> {
  return {
    market_id: order.marketId,
    side: order.side,
    order_type: SUPPORTED_ORDER_TYPE,
    price: dec.toString(order.price),
    quantity: dec.toString(order.quantity),
    time_in_force: order.timeInForce,
    reduce_only: order.reduceOnly,
    client_id: order.clientId,
  };
}
