// Pacing against the read budget, which this app spends almost all of.
//
// A statement is read-only, so only one of the venue's three budgets is in
// play — the *request* bucket. That makes the model much smaller than the one
// `order-loader` needs, but it does not make it optional, because four of the
// endpoints here are the expensive ones:
//
//  1. **`limit` is weight per second, not requests per second.** Most calls
//     cost 1. The heavy aggregate reads cost **5**, and this app makes four
//     kinds of them — `/fills`, `/orders/history`,
//     `/account/portfolio-history` and `/account/summary`. On a `Pro` key at
//     `limit: 20` that is four `/fills` pages per second, not twenty. Pacing
//     on request count instead of weight over-sends by 5×, and a statement
//     paginating a thousand fills is exactly the shape that notices.
//
//  2. **`GET /account/rate-limit` is free** — the one operation that consumes
//     no tokens. So this app *reads* its ceiling from the venue instead of
//     hardcoding one from the tier table in the docs, which is per-deployment
//     configuration and explicitly not part of the contract. Discovery costs
//     nothing, which is the whole reason not to guess.
//
//  3. **`remaining` is in unit-cost requests, `retry-after` is a duration**
//     derived from the weighted cost of what was refused. `remaining: 10` is
//     ten weight-1 calls *or* two weight-5 ones. Conflating the two units
//     over-sends on heavy endpoints and 429s you against your own model.
//
//  4. **`x-ratelimit-reset` and `retry-after` appear on a `429` only.** Read
//     off a 2xx they read nothing.
//
// The `unlimited` tier reports nulls throughout, because it is bucketed per
// client IP rather than per account. That case is detected and paced at a
// deliberately slow assumed rate rather than treated as "no limit".

import { sleep } from "./async.js";

/** Weight of the heavy aggregate reads, per the spec's "Rate limits" section. */
export const HEAVY_READ_WEIGHT = 5;

/**
 * Rate applied when the venue will not tell us the ceiling.
 *
 * Deliberately far below any real tier (`Pro` is 20/s): the point is to keep
 * working, slowly and visibly, rather than to guess a number and discover it
 * by being refused. Every path that reaches this says so.
 */
const ASSUMED_RATE_PER_SECOND = 4;

/** How often to re-read the free status endpoint mid-run. */
export const RESYNC_INTERVAL_MS = 5_000;

/**
 * Where the ceiling came from. Reported, because it changes what it means.
 *
 * `"headers"` is a real and useful case, not a degraded one: **the
 * `x-ratelimit-*` headers ride a `401` as well as a `2xx`.** Measured on the
 * live testnet deployment — an unsigned `GET /api/v1/account/rate-limit`
 * answers `401 UNAUTHORIZED` and still carries `x-ratelimit-limit: 50` and
 * `x-ratelimit-remaining: 49`. So a caller whose credentials are wrong still
 * learns the ceiling it is being metered at, which is worth pacing against
 * rather than throwing away.
 */
export type Source = "status" | "headers" | "assumed";

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

/**
 * The venue's read budget, modelled locally between polls.
 *
 * The local model exists because the free endpoint, free as it is, is still a
 * network round trip: asking before every page would double the wall time of
 * a paginated walk. So this refills the way the server does — continuously,
 * capped at one second of tokens — and resyncs from the server periodically
 * and after every refusal, which bounds how far the model can drift.
 */
export class RateBudget {
  private limit: number | null = null;
  private tokens = 0;
  private updatedAt = Date.now();
  private source: Source = "assumed";
  private tier: string | null = null;
  /** True once a `GET /account/rate-limit` *body* has been applied. */
  private discovered = false;
  /** `Date.now()` before which the venue refused us. Zero when it has not. */
  private blockedUntil = 0;

  constructor(
    /** Fraction of the ceiling this app will spend. Co-tenants get the rest. */
    private readonly utilisation: number,
    private readonly onNote: (message: string) => void,
  ) {}

  get tierName(): string {
    return this.tier ?? "not reported";
  }

  /** Sustained rate this app will hold itself to, in weight per second. */
  get rate(): number {
    const ceiling = this.limit ?? ASSUMED_RATE_PER_SECOND;
    return Math.max(ceiling * this.utilisation, 1);
  }

  describe(): string {
    const ceiling = this.limit ?? ASSUMED_RATE_PER_SECOND;
    const tier = this.tier === null ? "tier not reported" : `tier ${this.tier}`;
    return (
      `read budget ${ceiling}/s, using ${this.rate.toFixed(1)}/s ` +
      `(${this.source}), ${tier}`
    );
  }

  /**
   * Adopt a `GET /account/rate-limit` response.
   *
   * Only the flat `limit`/`remaining` pair is read: they report the *request*
   * class, which is the only budget a read-only app spends. `buckets` reports
   * `order` and `cancel` too, and this app deliberately ignores both — it
   * never writes, so a headroom number it cannot spend is noise.
   */
  applyStatus(raw: unknown): void {
    const status = asRecord(raw);
    if (status === null) {
      this.degrade("GET /account/rate-limit did not return an object");
      return;
    }

    const tier = status["tier"];
    this.tier = typeof tier === "string" ? tier : null;

    const limit = asInteger(status["limit"]);
    const remaining = asInteger(status["remaining"]);

    // Nulls throughout mean the `unlimited` tier, which is metered per client
    // IP rather than per account and does not publish that bucket's size here.
    // "Not reported" is not "no limit", so it is paced, slowly, and said out
    // loud.
    if (limit === null) {
      this.discovered = true;
      this.limit = ASSUMED_RATE_PER_SECOND;
      this.source = "assumed";
      this.tokens = 0;
      this.updatedAt = Date.now();
      this.onNote(
        `tier "${this.tierName}" reports no per-account ceiling — it is bucketed ` +
          `per client IP, and that bucket's size is not published here. ` +
          `Pacing at an assumed ${ASSUMED_RATE_PER_SECOND}/s.`,
      );
      return;
    }

    this.discovered = true;
    this.limit = limit;
    this.source = "status";
    // `remaining` is already in the unit this app spends: unit-cost requests.
    this.tokens = Math.min(remaining ?? 0, limit * this.utilisation);
    this.updatedAt = Date.now();
  }

  /**
   * Discovery failed. Say so, and fall back only as far as necessary.
   *
   * "As far as necessary" matters: a failed status call may still have left a
   * ceiling behind, because the `x-ratelimit-*` headers ride the failure
   * response too. Throwing that away to pace at the assumed rate would be
   * slower for no gain — so the fallback is used only when nothing at all is
   * known, and the two cases say different things.
   */
  degrade(why: string): void {
    if (this.discovered) return;
    if (this.limit !== null) {
      this.onNote(
        `${why}. Its response headers still reported a ceiling of ` +
          `${this.limit}/s, so that is what this run paces against — the ` +
          "`x-ratelimit-*` headers ride a failure response too. The tier name " +
          "is unknown.",
      );
      return;
    }
    this.limit = ASSUMED_RATE_PER_SECOND;
    this.source = "assumed";
    this.tokens = 0;
    this.updatedAt = Date.now();
    this.onNote(
      `${why}. Pacing at an assumed ${ASSUMED_RATE_PER_SECOND}/s, which is ` +
        "slower than any real tier. Guessing the tier's numbers instead would " +
        "be faster and is exactly what the spec says not to do.",
    );
  }

  /**
   * Resync from a 2xx response's `x-ratelimit-*` headers.
   *
   * Cheap — they ride every authenticated response — and it is the only free
   * correction available between status polls. `x-ratelimit-reset` is *not*
   * read here: it is sent on a `429` only, and a limiter that waits for a
   * reset it never saw waits forever.
   */
  observeHeaders(limit: number | null, remaining: number | null): void {
    if (limit !== null && limit > 0) {
      this.limit = limit;
      // Not `discovered`: that flag means a status *body* was applied, and it
      // is what `degrade` keys off. A header seen on a `401` is a real
      // ceiling but is not the tier report, and conflating the two would let
      // a failed discovery pass silently.
      if (this.source !== "status") this.source = "headers";
    }
    if (remaining !== null && remaining >= 0) {
      const ceiling = (this.limit ?? ASSUMED_RATE_PER_SECOND) * this.utilisation;
      this.tokens = Math.min(remaining, ceiling);
      this.updatedAt = Date.now();
    }
  }

  /** Record a refusal, and hold off for as long as the venue asked. */
  note429(retryAfterMs: number | null): void {
    this.tokens = 0;
    this.updatedAt = Date.now();
    this.blockedUntil = Date.now() + (retryAfterMs ?? 1_000);
  }

  /**
   * Wait until `weight` units are affordable, then spend them.
   *
   * `weight` is in the same unit as `remaining` — unit-cost requests — so a
   * `/fills` page reserves 5 and a `/funding` read reserves 1. That is the
   * whole of point 3 in the header, expressed as one line of arithmetic.
   */
  async reserve(weight: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();

      if (this.blockedUntil > now) {
        await sleep(this.blockedUntil - now, signal);
        continue;
      }

      const rate = this.rate;
      const capacity = Math.max(rate, weight);
      const elapsedSeconds = (now - this.updatedAt) / 1000;
      this.tokens = Math.min(capacity, this.tokens + elapsedSeconds * rate);
      this.updatedAt = now;

      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }

      const deficit = weight - this.tokens;
      await sleep(Math.ceil((deficit / rate) * 1000), signal);
    }
  }
}
