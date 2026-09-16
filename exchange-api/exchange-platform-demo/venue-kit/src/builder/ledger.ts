/*
 * Builder-code attribution, emulated — because the wire has nowhere to put it.
 *
 * THE CONSTRAINT. The build plan assumed the frontend could tag an order with a
 * builder code and let the venue reconcile later. It cannot. In openapi.json
 * 0.8.1 `OrderRequest` carries exactly thirteen fields and not one of them is a
 * client order id, a tag, or free-form metadata; `Order` echoes back only what
 * the engine assigned; `Fill` carries `order_id`, `fee`, and no builder axis.
 * The exchange offers no place to write "this flow came from Acme."
 *
 * THE CONSEQUENCE. Attribution has to be recorded wherever the tenant identity
 * and the order are both visible — the submitting client itself, or the
 * branded-API proxy for a partner that runs one. It
 * records `order_id → tenant` at submission, then joins that against
 * `GET /fills` — which does carry `order_id` — to derive filled notional per
 * builder code, and from that the fee the venue would have earned.
 *
 * WHAT THIS BUYS, AND WHAT IT COSTS. It is exact for every order the venue
 * submitted, needs no backend change, and is the same join the real feature
 * would do once `builder_code` exists on the wire — so the dashboard built on it
 * survives the cutover. But it is venue-side bookkeeping, not venue-authoritative
 * truth: lose the ledger and attribution is gone, because it cannot be
 * reconstructed from the exchange. Every figure it produces is an estimate and
 * `attributionAuthoritative: false` says so in the output rather than in a
 * comment nobody reads.
 *
 * AMENDS. `PATCH /orders/{id}` is cancel-replace — it retires an id and returns
 * a new one, carrying filled quantity across. An amended order whose successor
 * is not recorded silently drops out of attribution mid-life, so `recordAmend`
 * links the chain and the join follows it.
 */

import { addDec, formatDec, parseDec, ZERO, type Dec } from "../decimal.ts";
import { builderFee, fillNotional, normaliseFeeBps } from "./fee.ts";

/** One order the venue submitted, and who it was submitted for. */
export interface Attribution {
  readonly orderId: string;
  readonly builderCode: string;
  readonly feeBps: number;
  readonly marketId: string;
  readonly submittedAtMs: number;
}

/** The subset of `Fill` this join needs. Matches openapi.json 0.8.1. */
export interface FillLike {
  readonly id: string;
  readonly order_id: string;
  readonly market_id: string;
  readonly price: string;
  readonly size: string;
  readonly fee: string;
}

/** Per-builder-code rollup — the shape the per-venue dashboard reads. */
export interface BuilderSummary {
  readonly builderCode: string;
  readonly fills: number;
  readonly notional: string;
  /** Fees the *exchange* charged on attributed flow. Authoritative: from `Fill.fee`. */
  readonly venueFees: string;
  /** What the builder fee would have earned. Not charged, not credited. */
  readonly builderFeeAccrued: string;
  /** Always false while the wire carries no builder axis. */
  readonly attributionAuthoritative: false;
}

/**
 * In-memory attribution store. Deliberately an interface with a trivial default:
 * a real venue swaps in Postgres or Redis without touching the join, and the
 * demo needs no infrastructure at all.
 */
export class AttributionLedger {
  /* No `readonly` on these two: Node's type stripper (22.6) does not remove the
     modifier from a `#private` field and the module then fails to parse. */
  #byOrderId = new Map<string, Attribution>();
  /** Successor id → the id it replaced, so an amend chain stays attributed. */
  #amendedFrom = new Map<string, string>();

  /** Record a submitted order. The rate is normalised here, once, at the boundary. */
  record(entry: Attribution): Attribution {
    const normalised: Attribution = { ...entry, feeBps: normaliseFeeBps(entry.feeBps) };
    this.#byOrderId.set(normalised.orderId, normalised);
    return normalised;
  }

  /**
   * Link a cancel-replace. The successor inherits the predecessor's attribution
   * rather than copying it, so a rate change in config cannot retroactively
   * rewrite what an already-placed order accrues.
   */
  recordAmend(previousOrderId: string, newOrderId: string): void {
    this.#amendedFrom.set(newOrderId, previousOrderId);
  }

  /** Resolve an order id to its attribution, following any amend chain. */
  lookup(orderId: string): Attribution | undefined {
    const seen = new Set<string>();
    let current: string | undefined = orderId;
    while (current && !seen.has(current)) {
      const direct = this.#byOrderId.get(current);
      if (direct) return direct;
      seen.add(current);
      current = this.#amendedFrom.get(current);
    }
    return undefined;
  }

  get size(): number {
    return this.#byOrderId.size;
  }
}

/**
 * Join fills onto attributions and roll up per builder code.
 *
 * Fills whose order this venue did not submit are skipped, not counted against
 * anyone — the same account can trade through several frontends, and claiming
 * that flow would be exactly the over-attribution the real feature must avoid.
 */
export function summarise(ledger: AttributionLedger, fills: readonly FillLike[]): BuilderSummary[] {
  const rollup = new Map<
    string,
    { fills: number; notional: Dec; venueFees: Dec; builderFee: Dec }
  >();

  for (const fill of fills) {
    const attribution = ledger.lookup(fill.order_id);
    if (!attribution) continue;

    const bucket = rollup.get(attribution.builderCode) ?? {
      fills: 0,
      notional: ZERO,
      venueFees: ZERO,
      builderFee: ZERO,
    };

    const notional = fillNotional(fill.price, fill.size);
    rollup.set(attribution.builderCode, {
      fills: bucket.fills + 1,
      notional: addDec(bucket.notional, notional),
      /* `Fill.fee` is a decimal string like every other money field, and goes
         through the same strict parse so a malformed one fails loudly here
         rather than producing a plausible-looking total downstream. */
      venueFees: addDec(bucket.venueFees, parseDec(fill.fee)),
      builderFee: addDec(bucket.builderFee, builderFee(notional, attribution.feeBps)),
    });
  }

  return [...rollup.entries()]
    .map(([builderCode, totals]) => ({
      builderCode,
      fills: totals.fills,
      notional: formatDec(totals.notional),
      venueFees: formatDec(totals.venueFees),
      builderFeeAccrued: formatDec(totals.builderFee),
      attributionAuthoritative: false as const,
    }))
    .sort((a, b) => a.builderCode.localeCompare(b.builderCode));
}
