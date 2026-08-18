// The write path: place one resting order, and be certain it is gone at exit.
//
// This is the part of a trading app where a bug costs money, so the rules it
// follows are stated rather than implied:
//
//  1. **Placement is submitted at most once.** `POST /orders` is never
//     retried. A timeout is not evidence the order was rejected — it is the
//     absence of evidence — and the API has no client-supplied idempotency key
//     to make a second attempt safe. On an ambiguous failure the app *asks the
//     exchange what happened* (`GET /orders`) instead of guessing.
//
//  2. **One order at a time, enforced by a guard, not by hope.** A single
//     in-flight flag means a second call cannot start while the first is still
//     outstanding — including the window where the request has been sent and
//     the reply has not arrived, which is exactly the window a naive
//     `if (this.orderId === null)` check leaves open.
//
//  3. **It cannot cross the spread.** The price is computed a long way from the
//     mid, snapped to the tick grid *away* from the market, and then checked
//     against the near touch. `PostOnly` makes the exchange reject it outright
//     if it would take liquidity, so the guarantee does not depend on this
//     process's arithmetic being right.
//
//  4. **It cannot outlive the process.** Shutdown cancels the tracked order and
//     then runs a market-scoped cancel-all as a backstop, under a deadline, so
//     a hung API cannot turn a clean exit into an abandoned resting order.
//
//  5. **Every guard is re-checked here**, even ones `index.ts` already applied.
//     Defence in depth costs three lines and removes a whole class of "someone
//     called this from somewhere else" bug.

import * as dec from "./decimal.js";
import type { TopOfBook } from "./book.js";
import { ApiError, RestClient, TransportError } from "./rest.js";
import type { Config } from "./config.js";

/** Everything about a market that constrains an order. */
export interface MarketSpec {
  readonly marketId: string;
  readonly tickSize: dec.Dec;
  readonly lotSize: dec.Dec;
  readonly minOrderSize: dec.Dec;
  readonly maxOrderSize: dec.Dec;
  readonly halted: boolean;
}

interface Order {
  readonly id: string;
  readonly price: string;
  readonly quantity: string;
  readonly side: string;
  readonly status: string;
}

/** How long to stay quiet about a refusal we have already explained. */
const REFUSAL_LOG_INTERVAL_MS = 30_000;

/** How long shutdown may spend cancelling before we stop waiting on the API. */
const CANCEL_DEADLINE_MS = 10_000;

function parseOrder(raw: unknown): Order | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    price: typeof value["price"] === "string" ? value["price"] : "",
    quantity: typeof value["quantity"] === "string" ? value["quantity"] : "",
    side: typeof value["side"] === "string" ? value["side"] : "",
    status: typeof value["status"] === "string" ? value["status"] : "unknown",
  };
}

/**
 * Compare two decimal strings by value, not by spelling.
 *
 * `"62500"`, `"62500.0"` and `"62500.00"` are the same price and the server is
 * free to echo any of them. String equality would report "nothing rested" for
 * an order that is resting — the one wrong answer that costs money here.
 */
function sameDecimal(a: string, b: string): boolean {
  try {
    return dec.compare(dec.fromString(a), dec.fromString(b)) === 0;
  } catch {
    return false;
  }
}

export class Trader {
  /** The order we believe is resting, if any. */
  private orderId: string | null = null;
  /** True from the moment a placement is sent until its outcome is known. */
  private placing = false;
  /**
   * Set before the one and only `POST /orders` this process will ever send.
   *
   * The dashboard calls `place` on every render tick, so without this a
   * rejection — insufficient margin, say — would be re-sent once a second
   * forever. One order, once, is also simply what the example claims to do:
   * making that a hard invariant rather than an emergent property means no
   * change to the render loop can turn this into an order-spamming bot.
   */
  private attempted = false;
  private shuttingDown = false;
  private lastRefusal = { message: "", at: 0 };

  constructor(
    private readonly config: Config,
    private readonly rest: RestClient,
    private readonly spec: MarketSpec,
    private readonly log: (message: string) => void,
  ) {}

  get restingOrderId(): string | null {
    return this.orderId;
  }

  get isPlacing(): boolean {
    return this.placing;
  }

  /**
   * Work out the order this app would place, or the reason it will not.
   *
   * Separated from sending it so the dashboard can show the intent — and so
   * every arithmetic guard is exercised on a dry run, before `--trade` is ever
   * passed.
   */
  plan(top: TopOfBook): { price: dec.Dec; quantity: dec.Dec } | { refusal: string } {
    if (this.spec.halted) return { refusal: `${this.spec.marketId} is halted` };

    // Buy well below the mid. `applyBps` is exact, and flooring to a tick moves
    // the price further from the market rather than closer to it — the safe
    // direction for a bid, and the reason the rounding mode is not "nearest".
    const offset = dec.applyBps(top.mid, this.config.orderDistanceBps);
    const raw = dec.subtract(top.mid, offset);
    const price = dec.quantise(raw, this.spec.tickSize, "floor");

    if (!dec.isPositive(price)) {
      return { refusal: "computed price is not positive" };
    }
    // The belt to `PostOnly`'s braces: if this is not strictly below the best
    // bid it is not a resting order, whatever we intended it to be.
    const bestBid = dec.fromNumber(top.bid.price, this.spec.tickSize.scale);
    if (dec.compare(price, bestBid) >= 0) {
      return {
        refusal:
          `computed price ${dec.toString(price)} is not below the best bid ` +
          `${dec.toString(bestBid)} — refusing to send something that could take liquidity`,
      };
    }

    // Round size *up* to a lot so it cannot land under the venue minimum, then
    // check it against both bounds rather than assuming the rounding was benign.
    const requested =
      this.config.orderQuantity === null
        ? this.spec.minOrderSize
        : dec.fromString(this.config.orderQuantity);
    const quantity = dec.quantise(requested, this.spec.lotSize, "ceil");

    if (dec.compare(quantity, this.spec.minOrderSize) < 0) {
      return {
        refusal:
          `quantity ${dec.toString(quantity)} is below the minimum ` +
          `${dec.toString(this.spec.minOrderSize)}`,
      };
    }
    if (dec.compare(quantity, this.spec.maxOrderSize) > 0) {
      return {
        refusal:
          `quantity ${dec.toString(quantity)} is above the maximum ` +
          `${dec.toString(this.spec.maxOrderSize)}`,
      };
    }
    return { price, quantity };
  }

  /**
   * Place the resting order, once.
   *
   * Returns silently when a guard refuses — refusing is a normal outcome here,
   * not an error, and the reason is logged.
   */
  async place(top: TopOfBook): Promise<void> {
    // Guard order matters: the cheapest and most categorical checks first, so a
    // misconfigured run cannot reach the arithmetic, let alone the network.
    if (!this.config.tradingEnabled) return;
    if (this.config.funds !== "play") {
      // `unknown` lands here too. An undeclared target is not a safe one.
      this.log(
        `refusing to trade: target declares funds="${this.config.funds}", not "play"`,
      );
      return;
    }
    if (this.shuttingDown) return;
    if (this.placing) return; // Rule 2: the in-flight window is closed.
    if (this.attempted) return; // At most one placement per process.
    if (this.orderId !== null) return; // Already resting.

    const planned = this.plan(top);
    if ("refusal" in planned) {
      this.noteRefusal(planned.refusal);
      return;
    }

    const body = {
      market_id: this.spec.marketId,
      side: "Buy",
      order_type: "Limit",
      price: dec.toString(planned.price),
      quantity: dec.toString(planned.quantity),
      // Rejected by the exchange if it would take liquidity. This is the
      // guarantee that does not depend on our own arithmetic.
      time_in_force: "PostOnly",
    };

    // Set together, before the request exists. `attempted` must be true even if
    // the call throws, or a failure becomes a retry — see the field's comment.
    this.placing = true;
    this.attempted = true;
    try {
      const response = await this.rest.request<{ order?: unknown }>({
        method: "POST",
        path: "/api/v1/orders",
        body,
        signed: true,
        // Rule 1. Emphatically not idempotent.
        idempotent: false,
      });
      const order = parseOrder(response.order);
      if (order === null) {
        // A 2xx we cannot read is ambiguous in exactly the same way a timeout
        // is: something may be resting out there under an id we never saw.
        this.log("order accepted but the response was unreadable — reconciling");
        await this.reconcile(body.price, body.quantity);
        return;
      }
      this.orderId = order.id;
      this.log(
        `placed ${order.status} Buy ${body.quantity} @ ${body.price} (id ${order.id})`,
      );
    } catch (error) {
      await this.handlePlacementFailure(error, body.price, body.quantity);
    } finally {
      // Released in `finally` so a throw anywhere above cannot wedge the app
      // into a state where it will never place — or never cancel — again.
      this.placing = false;
    }
  }

  /**
   * Decide whether a failed placement definitely did not rest.
   *
   * A `400` or `403` is a decision the exchange made and told us about: nothing
   * rested, and there is nothing to reconcile. Anything else — a timeout, a
   * dropped connection, a `5xx` — means the request may have been processed
   * after we stopped listening, so the only honest move is to go and look.
   */
  private async handlePlacementFailure(
    error: unknown,
    price: string,
    quantity: string,
  ): Promise<void> {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      this.log(`order rejected: ${error.message}`);
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof TransportError || error instanceof ApiError) {
      this.log(`order outcome unknown (${reason}) — reconciling against the exchange`);
      await this.reconcile(price, quantity);
      return;
    }
    throw error;
  }

  /**
   * Ask the exchange what actually rests, and adopt or cancel it.
   *
   * This is what stands in for an idempotency key. Without a client-supplied
   * order id there is no way to ask "did *my* request land?", so the app
   * matches on what it sent — market, side, price, quantity — and treats
   * anything ambiguous as a reason to cancel rather than to accumulate.
   */
  private async reconcile(price: string, quantity: string): Promise<void> {
    let open: readonly Order[];
    try {
      open = await this.fetchOpenOrders();
    } catch (error) {
      // We could not find out. Say so loudly: this is the one state where an
      // order may be resting that nothing will clean up, and a shutdown
      // cancel-all is the backstop that covers it.
      this.log(
        `could not reconcile open orders (${describe(error)}) — ` +
          "an order may be resting; the exit cancel-all will clear it",
      );
      return;
    }

    const matches = open.filter(
      (order) =>
        order.side === "Buy" &&
        sameDecimal(order.price, price) &&
        sameDecimal(order.quantity, quantity),
    );
    const first = matches[0];
    if (first === undefined) {
      this.log("reconciled: nothing rested");
      return;
    }
    if (matches.length > 1) {
      // Should be impossible with the in-flight guard, so if it happens the
      // model is wrong somewhere. Do not try to reason about which is "ours".
      this.log(
        `reconciled: found ${matches.length} matching orders — cancelling all of them`,
      );
      await this.cancelAllForMarket();
      return;
    }
    this.orderId = first.id;
    this.log(`reconciled: the order did rest, as ${first.id}`);
  }

  /**
   * Log a refusal, but not the same one every second.
   *
   * A refusal is a normal outcome — a momentarily crossed book, a stale
   * snapshot — and the render loop asks once a second. Repeating the same line
   * 60 times a minute buries everything else in the log.
   */
  private noteRefusal(message: string): void {
    const now = Date.now();
    if (
      this.lastRefusal.message === message &&
      now - this.lastRefusal.at < REFUSAL_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastRefusal = { message, at: now };
    this.log(`not placing an order: ${message}`);
  }

  private async fetchOpenOrders(): Promise<readonly Order[]> {
    const response = await this.rest.request<unknown>({
      method: "GET",
      path: "/api/v1/orders",
      signed: true,
      idempotent: true,
    });
    if (!Array.isArray(response)) return [];
    const orders: Order[] = [];
    for (const entry of response) {
      const order = parseOrder(entry);
      // The endpoint is account-wide, so filter to this market before matching
      // — adopting or cancelling an order in a market this app never touched
      // would be a genuinely destructive bug.
      if (
        order !== null &&
        (entry as { market_id?: unknown }).market_id === this.spec.marketId
      ) {
        orders.push(order);
      }
    }
    return orders;
  }

  /**
   * Cancel everything this app could be responsible for, then stop.
   *
   * Two things bound it. `budget` below stops the second call from starting if
   * the first already spent the time, and `index.ts` holds a hard deadline over
   * the whole of shutdown that exits the process regardless — so a wedged API
   * cannot turn a clean exit into a hang. Re-entrant calls return immediately,
   * so a second Ctrl-C cannot start a competing teardown; `index.ts` turns that
   * second signal into an immediate exit instead.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.config.tradingEnabled || !this.rest.hasCredentials) return;

    const budget = AbortSignal.timeout(CANCEL_DEADLINE_MS);
    const id = this.orderId;
    if (id !== null) {
      try {
        await this.cancelOrder(id);
        this.log(`cancelled order ${id}`);
        this.orderId = null;
      } catch (error) {
        this.log(`could not cancel ${id}: ${describe(error)}`);
      }
    }

    // The backstop. It covers the placement whose response we never saw, and it
    // is scoped to this market on purpose: a bare cancel-all would reach into
    // markets this app has nothing to do with.
    if (!budget.aborted) {
      try {
        await this.cancelAllForMarket();
      } catch (error) {
        this.log(
          `cancel-all failed: ${describe(error)} — check for resting orders in ` +
            `${this.spec.marketId} before running again`,
        );
      }
    }
  }

  private async cancelOrder(id: string): Promise<void> {
    await this.rest.request({
      method: "DELETE",
      path: `/api/v1/orders/${encodeURIComponent(id)}`,
      // `market_id` is a required query parameter, and it is part of the signed
      // query string — not decoration.
      query: [["market_id", this.spec.marketId]],
      signed: true,
      // Cancelling twice is harmless: the second attempt is a 404.
      idempotent: true,
    });
  }

  private async cancelAllForMarket(): Promise<void> {
    await this.rest.request({
      method: "DELETE",
      path: "/api/v1/orders",
      query: [["market_id", this.spec.marketId]],
      signed: true,
      idempotent: true,
    });
    this.orderId = null;
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
