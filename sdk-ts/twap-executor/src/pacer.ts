// Pacing on rate-limit *weight*, against budgets the venue reports.
//
// The model, in the four sentences that matter (spec v0.8.1, "Rate limits"),
// with `exchange-api/order-loader` as the long-form reference:
//
//  1. `limit` is weight per second, not requests per second. The bucket holds
//     exactly one second of tokens and refills continuously.
//  2. Order writes are charged to a trading bucket *instead of* the request
//     bucket, so a healthy read budget says nothing about placement headroom.
//  3. `GET /account/rate-limit` is free, and is where the ceilings come from.
//     The tier table in the docs is "per-deployment configuration and not part
//     of this contract", so nothing here hardcodes it.
//  4. `retry-after` and `x-ratelimit-reset` exist on a `429` only.
//
// Where this differs from order-loader: the live venue labels every response
// with `x-ratelimit-bucket` (`key`, `owner`, `order`, `cancel`, `ip`). So a
// response's `x-ratelimit-limit` / `-remaining` can be attributed to the
// bucket that actually charged it instead of guessed at. That label is what
// makes the headers safe to learn from on an order write, too.

/** The budgets this app spends, in its own vocabulary. */
export type Budget = "request" | "order" | "cancel";

/** How a budget's ceiling became known. Printed, because it changes what it means. */
type Source = "status" | "header" | "inferred" | "assumed";

/**
 * Rate used before the venue has said anything.
 *
 * Deliberately far below any real tier, for the reason order-loader gives: the
 * point is to keep working slowly and visibly rather than to guess a number
 * and discover it by being refused. It's replaced by the first real reading.
 */
const ASSUMED_RATE = 4;

/** Floor on any `429` pause, for a `retry-after` that is missing or `0`. */
const MIN_PAUSE_MS = 1_000;

/** Jitter on a `429` pause: up to this fraction *added* to `retry-after`, never taken off. */
const PAUSE_JITTER = 0.5;

interface Bucket {
  limit: number;
  tokens: number;
  updatedAt: number;
  source: Source;
  blockedUntil: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * `Retry-After` in ms: delta-seconds or an HTTP date. The spec promises
 * seconds, never below 1. Both forms are read because proxies rewrite it.
 */
export function parseRetryAfter(raw: string | null, now = Date.now()): number | null {
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * The pause after a `429`: at least what the venue asked for, plus jitter.
 *
 * Jitter is *added*, never subtracted. Waking before `retry-after` is being
 * refused again for the same reason. The random extra is what stops every
 * client refused in the same second from coming back in the same second.
 */
export function pauseFor(retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = Math.max(MIN_PAUSE_MS, retryAfterMs ?? MIN_PAUSE_MS);
  return Math.round(base * (1 + PAUSE_JITTER * random()));
}

/** Map the venue's bucket label onto the budget it meters. */
function budgetForLabel(label: string | null): Budget | "shared" | null {
  switch (label) {
    case "key":
    case "owner":
      return "request";
    case "order":
      return "order";
    case "cancel":
      return "cancel";
    case "ip":
      return "shared";
    default:
      return null;
  }
}

/**
 * Which budget an operation is charged to, before any label has been seen.
 *
 * `POST`/`PATCH`/`DELETE` under `/orders` are trading actions; everything
 * else is a request. Whether a cancel has its *own* bucket depends on the
 * deployment. Spec v0.8.1 has one trading bucket for all three verbs. Newer
 * venues report a separate `cancel` bucket in `buckets`. `Pacer` resolves
 * that from what `/account/rate-limit` actually returns.
 */
export function classify(method: string, pathTemplate: string): Budget {
  const m = method.toUpperCase();
  if (m === "GET" || !pathTemplate.includes("/orders")) return "request";
  return m === "DELETE" ? "cancel" : "order";
}

export class Pacer {
  private readonly buckets: Record<Budget, Bucket>;
  /** True when one pool meters everything: unauthenticated or `unlimited`. */
  private shared = true;
  /** True when the deployment reports a separate `cancel` bucket. */
  private cancelSeparate = false;
  private tier = "unknown (no credentials: public reads share one per-IP bucket)";

  constructor(
    /** Fraction of each ceiling this app spends. Co-tenants on the key get the rest. */
    private readonly utilisation: number,
    private readonly note: (message: string) => void,
    private readonly random: () => number = Math.random,
  ) {
    const fresh = (): Bucket => ({
      limit: ASSUMED_RATE,
      tokens: 0,
      updatedAt: Date.now(),
      source: "assumed",
      blockedUntil: 0,
    });
    this.buckets = { request: fresh(), order: fresh(), cancel: fresh() };
  }

  get tierName(): string {
    return this.tier;
  }

  private resolve(budget: Budget): Budget {
    if (this.shared) return "request";
    if (budget === "cancel" && !this.cancelSeparate) return "order";
    return budget;
  }

  private capacity(limit: number): number {
    // At least one token, or a small ceiling times a small utilisation rounds
    // to zero and nothing is ever sent.
    return Math.max(1, limit * this.utilisation);
  }

  private set(budget: Budget, limit: number, remaining: number | null, source: Source): void {
    const b = this.buckets[budget];
    b.limit = limit;
    b.source = source;
    b.updatedAt = Date.now();
    // `remaining` counts every consumer of the key, so it's an upper bound on
    // what's ours, never a grant beyond our share.
    b.tokens = Math.min(this.capacity(limit), remaining ?? 0);
  }

  /**
   * Adopt a `GET /account/rate-limit` body.
   *
   * Read structurally: the SDK's `RateLimitStatus` (spec v0.8.1) has no
   * `buckets`, but a newer venue serves it additively. When it's absent, the
   * trading ceiling is *inferred* from the request ceiling ("a dedicated order
   * bucket of the same per-second size") and starts empty, so it can't
   * over-send while it learns.
   */
  applyStatus(raw: unknown): void {
    const status = asRecord(raw);
    if (status === null) {
      this.note("GET /account/rate-limit returned no object; keeping the assumed rates");
      return;
    }
    this.tier = typeof status["tier"] === "string" ? status["tier"] : "unknown";
    const limit = asInt(status["limit"]);
    if (limit === null) {
      // `unlimited`: nulls throughout, metered per IP, reads and writes together.
      this.shared = true;
      this.note(`tier "${this.tier}" reports no per-account ceiling: everything shares one per-IP bucket`);
      return;
    }
    this.shared = false;
    this.set("request", limit, asInt(status["remaining"]), "status");

    const buckets = asRecord(status["buckets"]);
    const order = buckets === null ? null : asRecord(buckets["order"]);
    const cancel = buckets === null ? null : asRecord(buckets["cancel"]);
    const orderLimit = order === null ? null : asInt(order["limit"]);
    const cancelLimit = cancel === null ? null : asInt(cancel["limit"]);

    if (orderLimit !== null) this.set("order", orderLimit, asInt(order?.["remaining"]), "status");
    else this.set("order", limit, 0, "inferred");

    this.cancelSeparate = cancelLimit !== null;
    if (cancelLimit !== null) this.set("cancel", cancelLimit, asInt(cancel?.["remaining"]), "status");
  }

  /**
   * Learn from one response's headers.
   *
   * Only when `x-ratelimit-bucket` names the bucket. Without the label, the
   * headers on an order write could describe either budget, and guessing
   * would corrupt the one that matters most.
   */
  observe(headers: Headers): void {
    const label = headers.get("x-ratelimit-bucket");
    const target = budgetForLabel(label);
    const limit = headerInt(headers, "x-ratelimit-limit");
    const remaining = headerInt(headers, "x-ratelimit-remaining");
    if (target === null || limit === null) return;
    if (target === "shared") {
      if (!this.shared) return; // an authenticated caller does not pace on the IP pool
      this.set("request", limit, remaining, "header");
      return;
    }
    if (target === "cancel") this.cancelSeparate = true;
    this.set(target, limit, remaining, "header");
  }

  /**
   * Record a `429`, pausing only the budget that refused.
   *
   * Pausing everything on a read refusal would starve the order flow to punish
   * the polling, which is the thing independent budgets exist to prevent. An
   * unnamed bucket pauses everything, on fail-closed reasoning.
   */
  note429(label: string | null, retryAfterMs: number | null): number {
    const pause = pauseFor(retryAfterMs, this.random);
    const until = Date.now() + pause;
    const target = budgetForLabel(label);
    const names: Budget[] =
      target === null || target === "shared" ? ["request", "order", "cancel"] : [this.resolve(target)];
    for (const name of names) {
      const b = this.buckets[name];
      b.blockedUntil = Math.max(b.blockedUntil, until);
      b.tokens = 0;
      b.updatedAt = Date.now();
    }
    this.note(
      `429 on the ${label ?? "unnamed"} bucket: pausing ${names.join(", ")} for ${(pause / 1000).toFixed(2)}s ` +
        `(retry-after ${retryAfterMs === null ? "absent" : `${retryAfterMs / 1000}s`} + jitter)`,
    );
    return pause;
  }

  /**
   * Wait until `weight` tokens are available on `budget`, then spend them.
   *
   * `weight` is the operation's marker from the spec, in the same unit as
   * `remaining`. A weight-5 `/fills` read is five tokens, not one request.
   * A single call is capped at one second of tokens, as the server caps it, so
   * a heavy read against a small share can't wait forever.
   */
  async reserve(budget: Budget, weight: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    if (weight <= 0) return;
    const b = this.buckets[this.resolve(budget)];
    for (;;) {
      const now = Date.now();
      if (b.blockedUntil > now) {
        await sleep(b.blockedUntil - now);
        continue;
      }
      const cap = this.capacity(b.limit);
      b.tokens = Math.min(cap, b.tokens + (Math.max(0, now - b.updatedAt) / 1000) * cap);
      b.updatedAt = now;
      const need = Math.min(weight, cap);
      if (b.tokens >= need) {
        b.tokens -= need;
        return;
      }
      await sleep(Math.ceil(((need - b.tokens) / cap) * 1000));
    }
  }

  /** One line per budget, for the run header. */
  describe(): string[] {
    const line = (label: string, b: Bucket): string =>
      `${label.padEnd(7)} ${b.limit}/s, spending up to ${this.capacity(b.limit).toFixed(1)}/s (${b.source})`;
    if (this.shared) return [`budget  shared  ${line("", this.buckets.request).trim()}`];
    const lines = [`budget  ${line("request", this.buckets.request)}`, `budget  ${line("order", this.buckets.order)}`];
    lines.push(
      this.cancelSeparate
        ? `budget  ${line("cancel", this.buckets.cancel)}`
        : "budget  cancel  shares the order bucket (no separate cancel budget reported)",
    );
    return lines;
  }
}
