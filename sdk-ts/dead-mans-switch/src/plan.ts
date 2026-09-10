// Deciding what single order to rest, from the market's own parameters.
//
// This is the whole of the app's trading logic and it is deliberately dull: one
// order, the smallest the market allows, priced where it will not fill. It is
// kept in its own module and kept pure — market parameters and a mark price in,
// an `OrderRequest` out — so the interesting part of the app (the supervisor)
// has no arithmetic in it, and so this can be reasoned about without a venue.

import type { Market, MarkPrice, OrderRequest } from "@nexus-xyz/exchange-ts";

import * as dec from "./decimal.js";

export class PlanError extends Error {}

export interface Plan {
  readonly order: OrderRequest;
  /** The mark the price was derived from, for the log line. */
  readonly markPrice: string;
  /** The band the offset was checked against, or `null` if the venue did not say. */
  readonly priceBandBps: number | null;
}

/**
 * The venue's order-vs-mark collar, in bps, if this deployment reports it.
 *
 * Spec v0.8.1 says `price_band_bps` is always present on a `Market`, but the
 * SDK's typed model does not carry the field, so it cannot be read off `Market`
 * directly. Reading it structurally is the honest middle: the value is used
 * when it is there and shaped right, and its absence downgrades to "could not
 * check" rather than to a silent assumption. Casting `Market` to something that
 * claims the field exists would be the lie — a server that omits it would then
 * produce `undefined > number`, which is `false`, and the check would pass by
 * accident.
 */
function priceBandBps(market: Market): number | null {
  const raw: unknown = (market as unknown as Record<string, unknown>)["price_band_bps"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/**
 * Build the one order the demonstration rests.
 *
 * Three properties, each of which matters for a different reason:
 *
 * - **It cannot take.** `PostOnly` is refused by the engine rather than
 *   crossed, so the order can only ever join the book. That is the difference
 *   between an example that rests an order and an example that opens a
 *   position.
 * - **It is priced away from the market, but inside the band.** Far enough
 *   below the mark that nothing is going to trade down into it during a
 *   demonstration that lasts under a minute; close enough that the engine's
 *   `price_band_bps` collar admits it. Those two bounds are what
 *   `NEXUS_DMS_PRICE_OFFSET_BPS` sits between.
 * - **It is the smallest size the market allows.** `min_order_size`, not a
 *   number this app picked. The point is to have *an* order resting, and the
 *   margin it consumes should be as close to nothing as the venue permits.
 *
 * Buy rather than sell, for a reason worth stating: on a market with no short
 * position already open, a resting sell that somehow filled would open one. A
 * resting buy 4% below the mark is the smaller of the two accidents, and the
 * direction that a falling market — the case where a dead client's orders
 * actually matter — reaches last.
 */
export function planRestingOrder(
  market: Market,
  mark: MarkPrice,
  offsetBps: number,
): Plan {
  let markValue: dec.Dec;
  try {
    markValue = dec.parse(mark.mark_price);
  } catch (error) {
    throw new PlanError(
      `${market.market_id}: mark price is not a plain decimal (${JSON.stringify(mark.mark_price)}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!dec.isPositive(markValue)) {
    throw new PlanError(
      `${market.market_id}: mark price is ${dec.format(markValue)}, so there is no price to work from.`,
    );
  }

  const band = priceBandBps(market);
  if (band !== null && offsetBps > band) {
    throw new PlanError(
      `NEXUS_DMS_PRICE_OFFSET_BPS is ${offsetBps} bps but ${market.market_id} collars limit prices ` +
        `at ${band} bps from the mark, so the order would be refused at admission. ` +
        `Choose an offset at or below ${band}.`,
    );
  }

  const tick = dec.parse(market.tick_size);
  if (!dec.isPositive(tick)) {
    throw new PlanError(`${market.market_id}: tick_size is ${market.tick_size}, which cannot be used.`);
  }

  // Floor onto the tick grid: it moves the bid *down*, further from a fill and
  // — since we are already below the mark — further inside the band. Rounding
  // to nearest could push the price back outside the band just checked.
  const price = dec.floorToMultiple(dec.discountBps(markValue, offsetBps), tick);
  if (!dec.isPositive(price)) {
    throw new PlanError(
      `${market.market_id}: a ${offsetBps} bps discount on a mark of ${dec.format(markValue)} rounds ` +
        `to ${dec.format(price)} at a tick of ${market.tick_size}.`,
    );
  }

  // Sanity, not ceremony: after flooring, re-derive the distance from the mark
  // and confirm it is still a discount. A market whose tick is a large fraction
  // of its price could in principle floor to something odd, and an order priced
  // at or above the mark is exactly the order this app must never send.
  if (dec.compare(price, markValue) >= 0) {
    throw new PlanError(
      `${market.market_id}: the computed price ${dec.format(price)} is not below the mark ` +
        `${dec.format(markValue)}. Refusing to place an order that could cross.`,
    );
  }

  const quantity = dec.parse(market.min_order_size);
  if (!dec.isPositive(quantity)) {
    throw new PlanError(
      `${market.market_id}: min_order_size is ${market.min_order_size}, so there is no size to place.`,
    );
  }

  return {
    order: {
      market_id: market.market_id,
      side: "Buy",
      order_type: "Limit",
      price: dec.formatTrimmed(price),
      quantity: dec.formatTrimmed(quantity),
      time_in_force: "PostOnly",
    },
    markPrice: dec.format(markValue),
    priceBandBps: band,
  };
}

/** One line describing a plan, used by both the dry run and the live run. */
export function describePlan(plan: Plan, offsetBps: number): string {
  const band = plan.priceBandBps === null ? "band not reported" : `band ${plan.priceBandBps}bps`;
  return (
    `${plan.order.market_id} ${plan.order.side} ${plan.order.quantity} @ ${plan.order.price} ` +
    `${plan.order.time_in_force} (mark ${plan.markPrice}, -${offsetBps}bps, ${band})`
  );
}
