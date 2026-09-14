// The write path: preview, submit in weight-optimal chunks, reconcile what is
// ambiguous, and cancel everything at exit.
//
// Three decisions in here are worth copying into whatever you build.
//
// **Previewing is not free, and the spec hides that in plain sight.**
// `POST /orders/preview` is a write on the `/orders` surface, so it is charged
// to the *trading* bucket exactly as placing an order is. Preview before every
// order and you have halved your placement rate — two trading charges per order
// placed. So this app previews a chosen subset (`NEXUS_PREVIEW_POLICY`) and
// prints what the policy costs before it spends it.
//
// **A timeout is not a rejection.** A batch whose response never arrived may
// have been fully applied. Every order therefore carries a `client_id`, and an
// ambiguous failure is answered by *asking the venue what happened* — matching
// open orders against the keys we sent — rather than by re-sending and hoping.
// A `429` is the one failure that is unambiguous: it says the request was
// refused, so `rest.ts` retries that and only that.
//
// **Cancel-everything-on-exit is not optional for a bulk writer.** It runs on
// every exit path, it is scoped to the markets this run touched rather than
// being a bare account-wide cancel-all, and it *verifies*: a cancel-all that
// could not reach every market still answers `200` with only the orders it did
// cancel, so an empty array is not proof that nothing rests.

import * as dec from "./decimal.js";
import { batchWeight } from "./budget.js";
import type { RateBudget } from "./budget.js";
import type { PreviewPolicy } from "./config.js";
import { ApiError, MissingCredentialsError, RestClient } from "./rest.js";
import { chunk, toOrderRequest } from "./plan.js";
import type { PlannedOrder } from "./plan.js";

/** What happened to one order we tried to place. */
export interface Placement {
  readonly order: PlannedOrder;
  readonly orderId: string | null;
  readonly status: "placed" | "rejected" | "unknown";
  readonly detail: string;
}

export interface PreviewOutcome {
  readonly order: PlannedOrder;
  readonly accepted: boolean;
  readonly detail: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Pull the order id and idempotency key out of an `Order`.
 *
 * Read across spellings on purpose. `Order` moved to CCXT's vocabulary
 * (`symbol`, `clientOrderId`) after the tag this example pins, so a deployment
 * on either side of that rename must be readable — and the alternative to
 * checking two keys is a reconcile that silently matches nothing, which is the
 * one failure mode that leaves orders resting.
 */
function readOrderIdentity(value: unknown): {
  id: string | null;
  clientId: string | null;
  market: string | null;
} {
  const record = asRecord(value);
  if (record === null) return { id: null, clientId: null, market: null };
  return {
    id: text(record["id"]) ?? text(record["order_id"]),
    clientId:
      text(record["clientOrderId"]) ??
      text(record["client_order_id"]) ??
      text(record["client_id"]),
    market: text(record["symbol"]) ?? text(record["market_id"]),
  };
}

export class Loader {
  /** Every order we believe rests, keyed by the `client_id` we sent. */
  private readonly placed = new Map<string, Placement>();

  /** Markets this run has written to. Bounds the cancel at exit. */
  private readonly touchedMarkets = new Set<string>();

  /** True once anything has been sent that could have created an order. */
  private wroteAnything = false;

  private cancelled = false;

  constructor(
    private readonly rest: RestClient,
    private readonly budget: RateBudget,
    private readonly log: (message: string) => void,
  ) {}

  get placements(): readonly Placement[] {
    return [...this.placed.values()];
  }

  get hasOutstandingWrites(): boolean {
    return this.wroteAnything;
  }

  /**
   * Choose which orders are worth a trading-class token.
   *
   * `first-per-market` is the default because margin is the constraint a
   * preview actually catches, and margin is per account and per market: if the
   * first order on a market is refused for margin, the rest of that market's
   * orders are in trouble too. Previewing all of them buys the same information
   * at N times the price.
   */
  static selectForPreview(
    orders: readonly PlannedOrder[],
    policy: PreviewPolicy,
  ): readonly PlannedOrder[] {
    if (policy === "none") return [];
    if (policy === "all") return orders;
    const seen = new Set<string>();
    return orders.filter((order) => {
      if (seen.has(order.marketId)) return false;
      seen.add(order.marketId);
      return true;
    });
  }

  /** Preview one order. Charged to the trading bucket, like a placement. */
  async preview(order: PlannedOrder): Promise<PreviewOutcome> {
    this.touchedMarkets.add(order.marketId);
    const raw = await this.rest.request<unknown>({
      method: "POST",
      path: "/api/v1/orders/preview",
      body: toOrderRequest(order),
      signed: true,
      // A preview creates nothing, so repeating it is harmless.
      idempotent: true,
      bucket: "order",
      weight: 1,
    });
    const record = asRecord(raw);
    if (record === null) {
      return {
        order,
        accepted: false,
        detail: "preview response was not an object",
      };
    }
    const accepted = record["accepted"] === true;
    const parts: string[] = [];
    const reject = text(record["reject_reason"]);
    if (reject !== null) parts.push(`reject_reason=${reject}`);
    const margin = record["required_initial_margin"];
    if (typeof margin === "string") parts.push(`initial_margin=${margin}`);
    const fees = record["projected_fees"];
    if (typeof fees === "string") parts.push(`fees=${fees}`);
    const liquidation = record["projected_post_trade_liquidation_price"];
    if (typeof liquidation === "string") parts.push(`liq=${liquidation}`);
    return {
      order,
      accepted,
      detail: parts.length === 0 ? "no projection fields returned" : parts.join(" "),
    };
  }

  /**
   * Submit every order, in chunks, paced against the trading budget.
   *
   * Returns once every chunk has been attempted. A chunk that fails
   * unambiguously (a `400`, a jurisdiction `403`) stops the run: the file was
   * wrong about something, and the remaining chunks are very likely wrong in
   * the same way.
   */
  async submit(
    orders: readonly PlannedOrder[],
    chunkSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    const chunks = chunk(orders, chunkSize);
    const totalWeight = chunks.reduce(
      (sum, group) => sum + batchWeight(group.length),
      0,
    );
    this.log(
      `submitting ${orders.length} order(s) in ${chunks.length} batch(es) of ` +
        `up to ${chunkSize}, costing ${totalWeight} trading unit(s) in total`,
    );

    for (const [position, group] of chunks.entries()) {
      if (signal.aborted) {
        this.log(`stopping before batch ${position + 1}: shutdown requested`);
        return;
      }
      await this.submitChunk(group, position + 1, chunks.length);
    }
  }

  private async submitChunk(
    group: readonly PlannedOrder[],
    position: number,
    total: number,
  ): Promise<void> {
    for (const order of group) this.touchedMarkets.add(order.marketId);
    const weight = batchWeight(group.length);

    // Set before the request exists. Anything after this point may have
    // created orders, whatever the call goes on to return.
    this.wroteAnything = true;

    let raw: unknown;
    try {
      raw = await this.rest.request<unknown>({
        method: "POST",
        path: "/api/v1/orders/batch",
        body: group.map(toOrderRequest),
        signed: true,
        // Emphatically not retried on an ambiguous failure — see the header
        // comment. `rest.ts` still retries a `429`, which is a refusal rather
        // than an unknown outcome.
        idempotent: false,
        bucket: "order",
        weight,
      });
    } catch (error) {
      await this.handleChunkFailure(error, group, position);
      return;
    }

    if (!Array.isArray(raw)) {
      this.log(
        `batch ${position}/${total}: response was not an array — reconciling`,
      );
      await this.reconcile(group);
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const [offset, order] of group.entries()) {
      const entry = asRecord(raw[offset]);
      if (entry === null) {
        this.record(order, null, "unknown", "no result entry for this order");
        continue;
      }
      // The result array is internally tagged and preserves request order, so
      // entry N belongs to order N. A short array is a protocol violation and
      // is handled above by leaving the tail `unknown`.
      if (entry["outcome"] === "ok") {
        const identity = readOrderIdentity(entry["order"]);
        this.record(order, identity.id, "placed", identity.id ?? "no id returned");
        ok += 1;
      } else {
        const detail =
          text(entry["message"]) ?? text(entry["error"]) ?? "rejected";
        this.record(order, null, "rejected", detail);
        failed += 1;
      }
    }
    this.log(
      `batch ${position}/${total}: ${ok} placed, ${failed} rejected ` +
        `(${weight} trading unit${weight === 1 ? "" : "s"})`,
    );
  }

  /**
   * Decide whether a failed batch definitely placed nothing.
   *
   * A `400` or a jurisdiction `403` is a decision the venue made and told us
   * about: nothing was placed, and there is nothing to reconcile. Anything else
   * — a timeout, a dropped connection, a `5xx` — means the request may have
   * been processed after we stopped listening, so the only honest move is to go
   * and look.
   */
  private async handleChunkFailure(
    error: unknown,
    group: readonly PlannedOrder[],
    position: number,
  ): Promise<void> {
    if (error instanceof MissingCredentialsError) throw error;

    const decided =
      error instanceof ApiError &&
      (error.status === 400 || error.status === 403 || error.status === 401);

    const detail = error instanceof Error ? error.message : String(error);
    if (decided) {
      for (const order of group) this.record(order, null, "rejected", detail);
      this.log(`batch ${position} refused outright: ${detail}`);
      // A jurisdiction or auth refusal will refuse the next batch identically.
      throw error;
    }

    this.log(`batch ${position} outcome unknown (${detail}) — reconciling`);
    for (const order of group) {
      this.record(order, null, "unknown", detail);
    }
    await this.reconcile(group);
  }

  /**
   * Ask the venue what actually rests, and match it against what we sent.
   *
   * This is what the `client_id` is for. Without it the only way to tell a lost
   * response from a lost request is to compare prices and sizes against open
   * orders and hope no two are alike — which, for a ladder, they always are.
   */
  private async reconcile(group: readonly PlannedOrder[]): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.rest.request<unknown>({
        method: "GET",
        path: "/api/v1/orders",
        signed: true,
        idempotent: true,
        bucket: "request",
        weight: 1,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(
        `could not reconcile (${detail}). The cancel at exit is the backstop; ` +
          "check for resting orders before running again.",
      );
      return;
    }
    if (!Array.isArray(raw)) return;

    const byClientId = new Map<string, { id: string | null }>();
    for (const item of raw) {
      const identity = readOrderIdentity(item);
      if (identity.clientId !== null) {
        byClientId.set(identity.clientId, { id: identity.id });
      }
    }

    let found = 0;
    for (const order of group) {
      const match = byClientId.get(order.clientId);
      if (match !== undefined) {
        this.record(order, match.id, "placed", "found by reconcile");
        found += 1;
      }
    }
    this.log(
      `reconcile: ${found} of ${group.length} order(s) from this batch are ` +
        "resting; the rest either never landed or are no longer open",
    );
  }

  private record(
    order: PlannedOrder,
    orderId: string | null,
    status: Placement["status"],
    detail: string,
  ): void {
    this.placed.set(order.clientId, { order, orderId, status, detail });
  }

  /**
   * Cancel everything this run could be responsible for, then verify.
   *
   * Scoped per market rather than a bare account-wide cancel-all: reaching into
   * a market this run never touched would be a genuinely destructive bug in an
   * example someone runs against an account they also trade by hand.
   *
   * Charged to the **cancel** budget, which is separate from the order budget —
   * so a run that spent its entire submission allowance still has a full,
   * untouched allowance for pulling those orders back. That guarantee is the
   * reason this method can be relied on at all.
   */
  async cancelEverything(deadline: AbortSignal): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    if (!this.wroteAnything || !this.rest.hasCredentials) return;

    for (const market of this.touchedMarkets) {
      if (deadline.aborted) {
        this.log(`out of time before cancelling ${market} — check it by hand`);
        return;
      }
      try {
        const raw = await this.rest.request<unknown>({
          method: "DELETE",
          path: "/api/v1/orders",
          query: [["market_id", market]],
          signed: true,
          // Cancelling twice is harmless, and this is the request that must not
          // give up early.
          idempotent: true,
          bucket: "cancel",
          weight: 1,
        });
        const count = Array.isArray(raw) ? raw.length : 0;
        this.log(`cancel-all on ${market}: ${count} order(s) cancelled`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`cancel-all on ${market} failed: ${detail}`);
      }
    }

    await this.verifyNothingRests(deadline);
  }

  /**
   * Confirm the cancel actually emptied the book of our orders.
   *
   * `DELETE /orders` answers `200` with the orders it *did* cancel even when it
   * could not reach every market, so a short or empty array is not proof. The
   * only proof is a read, and the only thing worse than leaving an order
   * resting is telling the operator you did not.
   */
  private async verifyNothingRests(deadline: AbortSignal): Promise<void> {
    if (deadline.aborted) return;
    let raw: unknown;
    try {
      raw = await this.rest.request<unknown>({
        method: "GET",
        path: "/api/v1/orders",
        signed: true,
        idempotent: true,
        bucket: "request",
        weight: 1,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`could not verify the cancel (${detail}) — check by hand`);
      return;
    }
    if (!Array.isArray(raw)) return;

    const ours: string[] = [];
    for (const item of raw) {
      const identity = readOrderIdentity(item);
      if (identity.clientId !== null && this.placed.has(identity.clientId)) {
        ours.push(identity.id ?? identity.clientId);
      }
    }
    if (ours.length === 0) {
      this.log("verified: none of this run's orders are still resting");
      return;
    }
    this.log(
      `WARNING: ${ours.length} order(s) from this run are still open ` +
        `(${ours.slice(0, 5).join(", ")}${ours.length > 5 ? ", …" : ""}). ` +
        "Cancel them before running again.",
    );
  }

  /** One line per placement, for the closing summary. */
  summarise(): string[] {
    const lines: string[] = [];
    for (const placement of this.placed.values()) {
      const { order } = placement;
      lines.push(
        `  #${String(order.index).padStart(3)} ${order.marketId} ` +
          `${order.side} ${dec.toString(order.quantity)} @ ` +
          `${dec.toString(order.price)}  ${placement.status}  ${placement.detail}`,
      );
    }
    return lines;
  }

  /** Report the budget state alongside the result, so pacing is visible. */
  budgetLines(): string[] {
    return this.budget.describe();
  }
}
