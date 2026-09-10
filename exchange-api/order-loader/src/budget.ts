// The rate-limit model. This file is the point of the example.
//
// A bulk loader is the one kind of client that cannot get pacing wrong and
// still look fine, so it is worth writing down what the venue's model actually
// is before writing a limiter against it. Five things, and only the first is
// what people assume:
//
//  1. **`limit` is weight per second, not requests per second.** Most calls
//     cost 1. Heavy aggregate reads — `/account/summary`, `/fills`,
//     `/orders/history`, `/account/portfolio-history`, `/positions/pnl` — cost
//     **5**. A batch submit costs `1 + floor(order_count / 40)`. The bucket
//     refills continuously and holds exactly one second of tokens, so the
//     sustained rate and the burst are the same number.
//
//  2. **There are three independent budgets, not one.** Reads are charged to
//     the per-key and per-owner *request* buckets; order submission and amend
//     to a separate *order* bucket; cancellation to a separate *cancel* bucket.
//     Spending one never spends another. So a healthy `x-ratelimit-remaining`
//     on your last read says nothing at all about your placement headroom, and
//     a `429` on reads is not a reason to stop placing.
//
//  3. **`GET /account/rate-limit` is free.** It is the one operation that
//     consumes no tokens, and it reports every bucket by the same label a `429`
//     names. That is what this file paces against: the budgets are *read from
//     the venue*, not hardcoded from a tier table that is per-deployment
//     configuration and explicitly not part of the contract.
//
//  4. **`remaining` and `retry-after` are in different units.** `remaining` is
//     expressed in unit-cost requests — 10 means ten weight-1 calls *or* two
//     weight-5 ones — while `retry-after` is derived from the weighted cost of
//     whatever was refused. Conflate them and you over-send on heavy endpoints
//     and 429 yourself.
//
//  5. **`x-ratelimit-reset` and `retry-after` appear on a `429` only.** Read
//     off a 2xx they read nothing, so a limiter that waits for a reset it never
//     saw waits forever.
//
// And one thing the model does *not* guarantee: on the `Unlimited` tier reads
// and order writes share a single per-IP bucket, so the independence in (2)
// does not hold there. `applyStatus` detects that case and collapses to one
// shared pool rather than pretending otherwise.

import { sleep } from "./async.js";

/** The three budgets this app spends, in its own vocabulary. */
export type BucketName = "request" | "order" | "cancel";

/** The labels the venue uses, on a `429` body and in `buckets`. */
export type WireBucket = "key" | "owner" | "order" | "cancel" | "ip" | "login";

/** Where a bucket's ceiling came from. Reported, because it changes what it means. */
type Source = "server" | "inferred" | "assumed";

/**
 * Rate applied when the venue will not tell us the ceiling.
 *
 * Deliberately far below any real tier (`Pro` is 20/s): the point is to keep
 * working, slowly and visibly, rather than to guess a number and discover it by
 * being refused. Every path that reaches this prints why.
 */
const ASSUMED_RATE_PER_SECOND = 4;

/** How often to re-read the free status endpoint mid-run. */
export const RESYNC_INTERVAL_MS = 5_000;

/** Weight of the heavy aggregate reads, per the spec's "Rate limits" section. */
export const HEAVY_READ_WEIGHT = 5;

/** Cost of one `POST /orders/batch`, per `x-nexus-rate-limit-weight-formula`. */
export function batchWeight(orderCount: number): number {
  return 1 + Math.floor(orderCount / 40);
}

interface BucketState {
  limit: number | null;
  /** Local model of the tokens left, in unit-cost requests. */
  tokens: number;
  updatedAt: number;
  source: Source;
  /** `Date.now()` before which this bucket refused us. Zero when it has not. */
  blockedUntil: number;
}

function newBucket(): BucketState {
  return {
    limit: null,
    tokens: 0,
    updatedAt: Date.now(),
    source: "assumed",
    blockedUntil: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/** One bucket as `GET /account/rate-limit` reports it. */
interface WireBucketStatus {
  readonly limit: number | null;
  readonly remaining: number | null;
}

function parseWireBucket(value: unknown): WireBucketStatus | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    limit: asInteger(record["limit"]),
    remaining: asInteger(record["remaining"]),
  };
}

/**
 * The venue's answer to "what may I spend?", modelled locally between polls.
 *
 * The local model exists because the free endpoint, free as it is, is still a
 * network round trip: pacing a forty-chunk run by asking before every call
 * would triple the wall time. So this refills the same way the server does —
 * continuously, capped at one second of tokens — and resyncs from the server
 * periodically and after every refusal, which bounds how far the model can
 * drift from the truth.
 */
export class RateBudget {
  private readonly buckets: Record<BucketName, BucketState> = {
    request: newBucket(),
    order: newBucket(),
    cancel: newBucket(),
  };

  /** True when one pool meters everything — the `Unlimited` tier. */
  private shared = false;

  private tier = "unknown";

  /** True once a real status response has been applied. */
  private discovered = false;

  constructor(
    /** Fraction of each ceiling this app will spend. Co-tenants get the rest. */
    private readonly utilisation: number,
    private readonly onNote: (message: string) => void,
  ) {}

  get tierName(): string {
    return this.tier;
  }

  get isDiscovered(): boolean {
    return this.discovered;
  }

  /**
   * Adopt a `GET /account/rate-limit` response.
   *
   * `buckets` is an *additive* field: it does not exist in spec `v0.8.1`, the
   * tag this example pins, and a deployment serving that contract answers with
   * the four flat fields only. That case is not an error and not a reason to
   * stop — it is a reason to say out loud that the order and cancel ceilings
   * are being inferred rather than read, which is what `describe()` prints.
   */
  applyStatus(raw: unknown): void {
    const status = asRecord(raw);
    if (status === null) {
      this.degrade("GET /account/rate-limit did not return an object");
      return;
    }

    const tier = status["tier"];
    this.tier = typeof tier === "string" ? tier : "unknown";

    const flatLimit = asInteger(status["limit"]);
    const flatRemaining = asInteger(status["remaining"]);
    const buckets = asRecord(status["buckets"]);

    // The `unlimited` tier reports nulls throughout and an empty `buckets`,
    // because no account-scoped bucket meters it: its traffic is bucketed per
    // client IP, reads and order writes together. That is the one configuration
    // where the independence this whole file is built on does not hold, so it
    // collapses to a single pool rather than modelling three that do not exist.
    if (flatLimit === null) {
      this.shared = true;
      this.discovered = true;
      const rate = ASSUMED_RATE_PER_SECOND;
      for (const name of ["request", "order", "cancel"] as const) {
        this.buckets[name] = {
          limit: rate,
          tokens: 0,
          updatedAt: Date.now(),
          source: "assumed",
          blockedUntil: this.buckets[name].blockedUntil,
        };
      }
      this.onNote(
        `tier "${this.tier}" reports no per-account ceiling: reads, order ` +
          "writes and cancels share one per-IP bucket whose size is not " +
          `published here. Pacing at an assumed ${rate}/s for all three.`,
      );
      return;
    }

    this.shared = false;
    this.discovered = true;

    // The flat fields are the *request* class only: the binding minimum of the
    // per-key and per-owner buckets. `buckets.key` / `buckets.owner` report the
    // two separately, but the minimum is what actually gates a read, so the
    // flat value is the right one to pace on even when both are present.
    this.set("request", flatLimit, flatRemaining, "server");

    const order = buckets === null ? null : parseWireBucket(buckets["order"]);
    const cancel = buckets === null ? null : parseWireBucket(buckets["cancel"]);

    if (order !== null && order.limit !== null) {
      this.set("order", order.limit, order.remaining, "server");
    } else {
      // Inferred, not read. The spec says the trading bucket is "of the same
      // per-second size" as the request bucket for the tiered plans, so the
      // ceiling is a fair guess — but the *tokens* are not, so this starts the
      // local model empty and lets it refill. That costs a few tens of
      // milliseconds at startup and cannot over-send.
      this.set("order", flatLimit, 0, "inferred");
    }

    if (cancel !== null && cancel.limit !== null) {
      this.set("cancel", cancel.limit, cancel.remaining, "server");
    } else {
      this.set("cancel", flatLimit, 0, "inferred");
    }
  }

  /**
   * Give up on discovery and pace at a rate low enough to be safe anywhere.
   *
   * Reached when the status endpoint is unavailable — an older deployment, a
   * key without the scope, a `5xx`. The loader still runs; it runs slowly and
   * says so. Silently falling back to a tier table would be worse: the tier
   * numbers are per-deployment configuration that the spec explicitly tells
   * clients not to hardcode.
   */
  degrade(reason: string): void {
    this.shared = true;
    const rate = ASSUMED_RATE_PER_SECOND;
    for (const name of ["request", "order", "cancel"] as const) {
      this.set(name, rate, 0, "assumed");
    }
    this.onNote(
      `could not read the venue's budgets (${reason}). Falling back to an ` +
        `assumed ${rate}/s on every class — slower than any real tier, and ` +
        "deliberately so: the tier ceilings are deployment configuration and " +
        "the spec says not to hardcode them.",
    );
  }

  private set(
    name: BucketName,
    limit: number,
    remaining: number | null,
    source: Source,
  ): void {
    const capacity = this.capacityOf(limit);
    const bucket = this.buckets[name];
    bucket.limit = limit;
    bucket.source = source;
    bucket.updatedAt = Date.now();
    // Never adopt more tokens than our own share of the bucket, and never adopt
    // a server reading as an *increase* beyond what we already modelled without
    // clamping it: `remaining` counts every consumer of this key, so it is an
    // upper bound on what is ours to spend, not a grant.
    bucket.tokens = Math.min(capacity, remaining ?? 0);
  }

  private capacityOf(limit: number): number {
    // At least one token, or a small ceiling times a small utilisation rounds
    // to zero and the app never sends anything.
    return Math.max(1, limit * this.utilisation);
  }

  /** Refill the local model to `now`, the same way the server's bucket does. */
  private refill(bucket: BucketState, now: number): void {
    const limit = bucket.limit;
    if (limit === null) return;
    // `Math.max(0, …)` guards a clock that jumped backwards: without it a
    // negative elapsed would *remove* tokens and stall the app indefinitely.
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.updatedAt = now;
    const capacity = this.capacityOf(limit);
    const rate = capacity; // one second of tokens is the capacity, by definition
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / 1000) * rate);
  }

  /**
   * Wait until `weight` units are available on `name`, then spend them.
   *
   * `weight` is in the same unit as `remaining` — unit-cost requests — so a
   * weight-5 read is five tokens and a 40-order batch is two. That is the whole
   * of trap (4): the caller passes the *weighted* cost, never a request count.
   *
   * On the shared-pool tier every class spends the same bucket, so `name` is
   * ignored there rather than quietly metering three copies of one pool.
   */
  async reserve(
    name: BucketName,
    weight: number,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.shared ? "request" : name;
    const bucket = this.buckets[target];

    for (;;) {
      const now = Date.now();

      if (bucket.blockedUntil > now) {
        await sleep(bucket.blockedUntil - now, signal);
        continue;
      }

      this.refill(bucket, now);
      const limit = bucket.limit;
      if (limit === null) return; // nothing known and nothing to wait for

      const capacity = this.capacityOf(limit);
      // A single request can cost more than our share of the bucket — a 200
      // order batch weighs 6 against a capacity of 4. The server caps one
      // request's cost at a second of tokens so it can never be permanently
      // unsatisfiable; mirror that here rather than looping forever.
      const required = Math.min(weight, capacity);
      if (bucket.tokens >= required) {
        bucket.tokens -= required;
        return;
      }

      const deficit = required - bucket.tokens;
      await sleep(Math.ceil((deficit / capacity) * 1000), signal);
    }
  }

  /**
   * Record a `429`.
   *
   * Only the bucket that refused is paused. Backing the whole client off a
   * read-budget refusal is the mistake the independent-budgets model exists to
   * prevent: it starves your own order flow to punish your polling.
   *
   * `retryAfterMs` comes from the `retry-after` header, which is derived from
   * the weighted cost of the refused request. It is not comparable to
   * `remaining`, so it is used as a duration and nothing else.
   */
  note429(wire: WireBucket | null, retryAfterMs: number | null): void {
    const until = Date.now() + Math.max(250, retryAfterMs ?? 1_000);
    const names = this.bucketsFor(wire);
    for (const name of names) {
      const bucket = this.buckets[name];
      bucket.blockedUntil = Math.max(bucket.blockedUntil, until);
      bucket.tokens = 0;
      bucket.updatedAt = Date.now();
    }
    this.onNote(
      `429 on the ${wire ?? "unnamed"} bucket; pausing ` +
        `${names.join(", ")} for ${Math.round((until - Date.now()) / 100) / 10}s`,
    );
  }

  /**
   * Map the venue's bucket label onto the classes this app meters.
   *
   * `ip` is the per-IP pool the `Unlimited` tier and unauthenticated traffic
   * share, so a refusal naming it pauses everything — that pool really does
   * meter all three. An unrecognised or absent label pauses everything too, on
   * the same fail-closed reasoning: not knowing which budget refused is not a
   * licence to keep spending the other two.
   */
  private bucketsFor(wire: WireBucket | null): BucketName[] {
    switch (wire) {
      case "key":
      case "owner":
        return this.shared ? ["request", "order", "cancel"] : ["request"];
      case "order":
        return this.shared ? ["request", "order", "cancel"] : ["order"];
      case "cancel":
        return this.shared ? ["request", "order", "cancel"] : ["cancel"];
      default:
        return ["request", "order", "cancel"];
    }
  }

  /**
   * Adopt `x-ratelimit-remaining` from a successful response.
   *
   * Applied to the request class only. The headers ride on every authenticated
   * response, but the spec does not say which budget they describe on an order
   * write, and guessing would corrupt the one bucket that matters most here.
   * The order and cancel buckets are resynced from `/account/rate-limit`
   * instead, which names them explicitly.
   */
  observeRequestHeaders(limit: number | null, remaining: number | null): void {
    if (limit === null || remaining === null) return;
    const bucket = this.buckets.request;
    if (bucket.source !== "server") return;
    bucket.limit = limit;
    bucket.updatedAt = Date.now();
    bucket.tokens = Math.min(this.capacityOf(limit), remaining);
  }

  /** One line per budget, for the run header and the summary. */
  describe(): string[] {
    const order: BucketName[] = ["request", "order", "cancel"];
    if (this.shared) {
      const bucket = this.buckets.request;
      return [
        `budgets: one shared pool, ${this.rateText(bucket)} ` +
          `(${bucket.source}) — reads, order writes and cancels compete`,
      ];
    }
    return order.map((name) => {
      const bucket = this.buckets[name];
      return `budget ${name.padEnd(7)} ${this.rateText(bucket)} (${bucket.source})`;
    });
  }

  private rateText(bucket: BucketState): string {
    if (bucket.limit === null) return "unknown";
    const capacity = this.capacityOf(bucket.limit);
    return `${bucket.limit}/s, using ${capacity.toFixed(1)}/s`;
  }
}
