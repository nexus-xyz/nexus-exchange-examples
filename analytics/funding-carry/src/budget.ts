// Pacing against the read budget. Public data is metered too.
//
// Adapted from `account-statement`'s copy (CONTRIBUTING.md § 1), with the
// discovery half removed: `GET /account/rate-limit` is authenticated, and this
// app has no credentials, so it cannot ask what its ceiling is. What is left
// is the part that still works without one, and it turns out to be enough:
//
//  1. **The `x-ratelimit-*` headers ride every response, public ones
//     included.** Measured on the live testnet: an unauthenticated `GET
//     /api/v1/markets/BTC-USDX-PERP/funding` answers `200` with
//     `x-ratelimit-limit: 50` and `x-ratelimit-remaining: 49`. So this app
//     starts at a deliberately slow assumed rate and *corrects upward* from
//     the first response it gets, which costs nothing and beats hardcoding a
//     number from the tier table — that table is per-deployment configuration
//     and explicitly not part of the contract.
//
//     (The same headers ride a `401`, which is how the authenticated examples
//     discover their ceiling before their credentials are accepted. Not needed
//     here: a public request is a better probe than a failing one.)
//
//  2. **`limit` is weight per second, not requests per second.** Everything
//     this app reads is weight 1 — `/tickers`, `/markets/summary`,
//     `/markets/{id}/funding`, `/markets/{id}/funding-samples`,
//     `/markets/{id}/risk-params` — so for this app the two units coincide.
//     The distinction is kept anyway, because it is the thing that bites the
//     moment someone copies this file into an example that reads a weight-5
//     surface.
//
//  3. **`x-ratelimit-reset` and `retry-after` appear on a `429` only.** Read
//     off a 2xx they read nothing.

import { sleep } from "./async.js";

/**
 * Rate applied until a response tells us better.
 *
 * Deliberately far below the measured public ceiling (50/s on testnet): the
 * point is to start slowly and be corrected by evidence, rather than to guess
 * a number and discover it by being refused. Every path that reaches this says
 * so.
 */
const ASSUMED_RATE_PER_SECOND = 4;

/** Where the ceiling came from. Reported, because it changes what it means. */
export type Source = "headers" | "assumed";

/**
 * The venue's read budget, modelled locally between responses.
 *
 * The local model exists because the correction only arrives *with* a
 * response, so between them something has to decide when to send. This refills
 * the way the server does — continuously, capped at one second of tokens — and
 * resyncs from every response's headers, which bounds how far the model can
 * drift.
 */
export class RateBudget {
  private limit: number | null = null;
  private tokens = 0;
  private updatedAt = Date.now();
  private source: Source = "assumed";
  /** `Date.now()` before which the venue refused us. Zero when it has not. */
  private blockedUntil = 0;

  constructor(
    /** Fraction of the ceiling this app will spend. Co-tenants get the rest. */
    private readonly utilisation: number,
    private readonly onNote: (message: string) => void,
  ) {}

  /** Sustained rate this app will hold itself to, in weight per second. */
  get rate(): number {
    const ceiling = this.limit ?? ASSUMED_RATE_PER_SECOND;
    return Math.max(ceiling * this.utilisation, 1);
  }

  describe(): string {
    const ceiling = this.limit ?? ASSUMED_RATE_PER_SECOND;
    return this.source === "assumed"
      ? `read budget not yet reported; pacing at an assumed ${ceiling}/s ` +
          "until a response says otherwise"
      : `read budget ${ceiling}/s (from response headers), using ` +
          `${this.rate.toFixed(1)}/s`;
  }

  /** Say once, on the first correction, what the venue actually allows. */
  private announced = false;

  /**
   * Resync from a response's `x-ratelimit-*` headers.
   *
   * Free — they ride every response, and this app has no other way to learn
   * the ceiling. `x-ratelimit-reset` is *not* read here: it is sent on a `429`
   * only, and a limiter that waits for a reset it never saw waits forever.
   */
  observeHeaders(limit: number | null, remaining: number | null): void {
    if (limit !== null && limit > 0) {
      this.limit = limit;
      this.source = "headers";
      if (!this.announced) {
        this.announced = true;
        this.onNote(this.describe());
      }
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
   * `weight` is in the same unit as `remaining` — unit-cost requests. Every
   * call this app makes reserves 1; the parameter exists so point 2 in the
   * header stays true for whoever copies this file next.
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
