// The REST client: one signed `fetch`, with the sharp edges filed off.
//
// Everything in here is a defence against a specific way a hand-rolled exchange
// client goes wrong in production. They are worth reading as a list, because
// each one is cheap and none of them is obvious until it has bitten you:
//
//   * **Redirects are never followed.** `fetch`'s default strips `Authorization`
//     across an origin change but *not* custom headers, so a signed request
//     answered with a `301` would hand `x-api-key` and a valid `x-signature` to
//     whatever host the `Location` names — while dropping the body and turning
//     a `POST` into a `GET`. No operation in the spec answers 3xx, so a
//     redirect only ever means the path is wrong. Terminal error, no retry.
//
//   * **A `POST /orders` is never retried.** A timeout is not evidence that the
//     order did not reach the matching engine; it is the absence of evidence
//     either way. Re-sending is how one intended order becomes two real ones.
//     Only calls explicitly marked idempotent are retried, and placement is not
//     one of them — `trader.ts` reconciles against `GET /orders` instead.
//
//   * **Every request has a deadline and an abort path.** No call can outlive
//     the process's shutdown, and none can hang forever on a half-open socket.
//
//   * **Response bodies are bounded.** A misconfigured host that streams
//     without end must not be able to exhaust memory.
//
//   * **The body is checked before it is parsed.** The single most common
//     first-run failure is an HTML 404 page from a frontend that is not the
//     API; `JSON.parse` on it produces a syntax error that tells the reader
//     nothing. Naming the content type tells them everything.
//
//   * **Clock skew is surfaced.** Signatures are valid for ±30s. A drifting
//     clock fails every signed call with a `401` indistinguishable from a bad
//     secret, so the server's own `Date` header is compared against ours.

import { decodeSecret, signRequest } from "./signing.js";
import type { Config } from "./config.js";

/** Ceiling on a response body. Far above any real response from this API. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Per-request deadline. Generous enough for a cold start, short enough to fail. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Retry budget for calls that are safe to repeat. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;

/** Signatures are refused outside ±30s, so warn well before we get there. */
const CLOCK_SKEW_WARN_MS = 5_000;

export class ApiError extends Error {
  /** Server-supplied hint from a `429`, when it sent one. */
  retryAfterMs: number | null = null;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /** True when repeating the identical request could plausibly succeed. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class MissingCredentialsError extends Error {
  constructor(operation: string) {
    super(`${operation} needs API credentials; none are configured`);
    this.name = "MissingCredentialsError";
  }
}

export interface RequestOptions {
  readonly method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  /**
   * The indexer-visible path, e.g. `/api/v1/orders`. This is both appended to
   * the base URL and signed — one value, so the two can never disagree.
   */
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly body?: unknown;
  readonly signed?: boolean;
  /**
   * Whether repeating this exact request is harmless. Defaults to `false`.
   *
   * Opt *in*, never out: a new endpoint added by a future reader is
   * non-idempotent until someone has thought about it, which is the safe way
   * for that default to be wrong.
   */
  readonly idempotent?: boolean;
  /** Rate-limit weight. Most calls are 1; heavy aggregate reads are 5. */
  readonly weight?: number;
}

/**
 * A token bucket, so this client cannot be the reason it gets rate-limited.
 *
 * The server's budget is *weight per second*, not requests per second, so the
 * bucket is denominated in weight too. This is a client-side courtesy and not a
 * guarantee — the account's real budget is shared with anything else using the
 * same key — which is why the `429` path below still exists and still backs
 * off. Deliberately conservative: the `Pro` tier is 20/s and this asks for 8/s.
 *
 * There is no lock and no queue of waiters: `take` awaits a plain timer and
 * then decrements. Two concurrent callers can each be waiting on their own
 * timer, which at worst lets a small burst through — a far better failure than
 * a queue that can deadlock or reorder.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity = 8,
    private readonly refillPerSecond = 8,
  ) {
    this.tokens = capacity;
  }

  async take(weight: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      // `Math.max(0, …)` guards a clock that jumped backwards: without it a
      // negative elapsed would *remove* tokens and stall the app indefinitely.
      const elapsed = Math.max(0, now - this.lastRefill);
      this.lastRefill = now;
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (elapsed / 1000) * this.refillPerSecond,
      );
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      const deficit = weight - this.tokens;
      await sleep((deficit / this.refillPerSecond) * 1000, signal);
    }
  }
}

/** `setTimeout` that unwinds when `signal` aborts, instead of outliving it. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}

/** Exponential backoff with equal jitter — half fixed, half random. */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  );
  // Never zero (no busy-loop) and spread across clients (no thundering herd).
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), RETRY_MAX_DELAY_MS);
}

/** Collapse a message to one readable line. Error bodies can be a whole HTML page. */
function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Percent-encode a query string once, and use the identical bytes for the
 * signature and the request. See trap 3 in `signing.ts`.
 */
function encodeQuery(
  pairs: ReadonlyArray<readonly [string, string]>,
): string {
  return pairs
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

export class RestClient {
  private readonly limiter = new RateLimiter();
  private readonly secret: Buffer | null;
  /** Signed but reported once: a repeated warning every second is noise. */
  private skewWarned = false;

  constructor(
    private readonly config: Config,
    /** Aborted on shutdown; every in-flight request unwinds with it. */
    private readonly shutdownSignal: AbortSignal,
    private readonly onWarning: (message: string) => void,
  ) {
    this.secret =
      config.credentials === null
        ? null
        : decodeSecret(config.credentials.apiSecretHex);
  }

  get hasCredentials(): boolean {
    return this.secret !== null;
  }

  /**
   * Perform one API call, retrying only when that is provably safe.
   *
   * Returns the parsed JSON body. Throws `ApiError` for a non-2xx the server
   * explained, `TransportError` for anything that stopped the request reaching
   * it, and `MissingCredentialsError` when a signed call has no key.
   */
  async request<T>(options: RequestOptions): Promise<T> {
    const {
      method,
      path,
      query = [],
      body,
      signed = false,
      idempotent = false,
      weight = 1,
    } = options;

    if (signed && (this.secret === null || this.config.credentials === null)) {
      throw new MissingCredentialsError(`${method} ${path}`);
    }

    const queryString = encodeQuery(query);
    const url = queryString.length === 0
      ? `${this.config.baseUrl}${path}`
      : `${this.config.baseUrl}${path}?${queryString}`;

    // Assert the URL parser agrees with us about both halves of what is about
    // to be signed. If it did not, the signature would cover bytes the server
    // never receives and the only symptom would be a bare `401`.
    //
    // This is not hypothetical on either half. The parser normalises `.` and
    // `..` segments in a path, so an id echoed back as `..` would be signed as
    // `/api/v1/orders/..` and sent as `/api/v1/`; and it is free to re-encode
    // characters in a query that our `encodeURIComponent` left alone. Checking
    // is two comparisons and turns both into an immediate, explicable failure.
    const parsed = new URL(url);
    const expectedPath = `${new URL(this.config.baseUrl).pathname}${path}`;
    if (parsed.pathname !== expectedPath) {
      throw new Error(
        `path would be rewritten on the wire (${expectedPath} → ` +
          `${parsed.pathname}); refusing to sign a path that differs from what is sent`,
      );
    }
    if (parsed.search.replace(/^\?/, "") !== queryString) {
      throw new Error(
        `query string would be re-encoded on the wire (${queryString} → ` +
          `${parsed.search}); refusing to sign bytes that differ from what is sent`,
      );
    }

    const payload =
      body === undefined
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(body));

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.limiter.take(weight, this.shutdownSignal);
      try {
        return await this.attempt<T>(
          method,
          url,
          path,
          queryString,
          payload,
          signed,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const retryable =
          idempotent &&
          attempt < MAX_ATTEMPTS &&
          !this.shutdownSignal.aborted &&
          (lastError instanceof TransportError ||
            (lastError instanceof ApiError && lastError.transient));
        if (!retryable) throw lastError;

        const hinted =
          lastError instanceof ApiError && lastError.status === 429
            ? lastError.retryAfterMs
            : null;
        await sleep(hinted ?? backoffDelay(attempt), this.shutdownSignal);
      }
    }
    // Unreachable: the loop either returns or throws. Kept so the type is honest.
    throw lastError ?? new TransportError(`${method} ${path} failed`);
  }

  private async attempt<T>(
    method: string,
    url: string,
    path: string,
    queryString: string,
    payload: Uint8Array,
    signed: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      // Advisory only, and outside the signature: attribution, never access
      // control. Named so the operator can see which contract this was built
      // against.
      "x-nexus-api-version": "v0.8.1",
      "user-agent": "nexus-exchange-examples-trading-terminal/0.0.0",
    };
    if (payload.byteLength > 0) headers["content-type"] = "application/json";

    if (signed && this.secret !== null && this.config.credentials !== null) {
      Object.assign(
        headers,
        signRequest(
          this.config.credentials.apiKey,
          this.secret,
          method,
          path,
          queryString,
          payload,
          Date.now(),
        ),
      );
    }

    // Two reasons to give up: our own deadline, and process shutdown. Composing
    // them means a request can never outlive either.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, this.shutdownSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(payload.byteLength > 0 ? { body: payload } : {}),
        // See the header comment: following one leaks the signature.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (this.shutdownSignal.aborted) throw abortReason(this.shutdownSignal);
      const detail = error instanceof Error ? oneLine(error.message) : "unknown";
      throw new TransportError(`${method} ${path}: ${detail}`);
    }

    this.checkClockSkew(response);

    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location") ?? "an unnamed target";
      throw new ApiError(
        `${method} ${path}: refused to follow a ${response.status} redirect to ` +
          `${target}. No API operation answers 3xx, so this path is not served ` +
          "at the configured base URL. Check NEXUS_EXCHANGE_API_URL.",
        response.status,
        null,
        false,
      );
    }

    const text = await this.readBounded(response, `${method} ${path}`);
    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      throw this.toApiError(method, path, response, text, contentType);
    }

    if (text.length === 0) return undefined as T;

    if (!contentType.includes("json")) {
      throw new ApiError(
        `${method} ${path}: expected JSON, got ${oneLine(contentType, 60)}. ` +
          "That usually means the base URL points at a web frontend rather " +
          "than the API — see the README's \"About the host\".",
        response.status,
        null,
        false,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        `${method} ${path}: response was not valid JSON`,
        response.status,
        null,
        false,
      );
    }
  }

  /**
   * Read a response body with a hard byte cap.
   *
   * `response.text()` would buffer whatever arrives. Reading the stream by hand
   * costs a few lines and makes an unbounded body a clean error instead of an
   * out-of-memory kill.
   */
  private async readBounded(response: Response, label: string): Promise<string> {
    const body = response.body;
    if (body === null) return "";

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw new TransportError(
            `${label}: response exceeded ${MAX_RESPONSE_BYTES} bytes; aborted`,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (this.shutdownSignal.aborted) throw abortReason(this.shutdownSignal);
      const detail = error instanceof Error ? oneLine(error.message) : "unknown";
      throw new TransportError(`${label}: reading response failed: ${detail}`);
    } finally {
      // Releases the socket whether we finished, capped out, or aborted.
      await reader.cancel().catch(() => {});
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  private toApiError(
    method: string,
    path: string,
    response: Response,
    text: string,
    contentType: string,
  ): ApiError {
    let code: string | null = null;
    // A non-JSON error body is a whole HTML page, and quoting 200 characters of
    // Next.js `<head>` at the reader tells them nothing they can act on. Name
    // the content type instead — *that* is the diagnosis.
    let message = contentType.includes("json")
      ? oneLine(text) || response.statusText
      : `${response.statusText || "error"} (non-JSON body, content-type: ${oneLine(contentType, 40) || "none"})`;
    if (contentType.includes("json") && text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object") {
          const envelope = parsed as { code?: unknown; message?: unknown };
          if (typeof envelope.code === "string") code = envelope.code;
          if (typeof envelope.message === "string") {
            message = oneLine(envelope.message);
          }
        }
      } catch {
        // Keep the raw one-liner; a malformed error body is still a signal.
      }
    }

    const status = response.status;
    // 429 and 5xx can succeed on repetition; 408 is a timeout the server owns.
    const transient = status === 429 || status === 408 || status >= 500;

    let hint = "";
    if (status === 401) {
      hint =
        " — check the API key and secret, that they were minted on this host, " +
        "and that this machine's clock is accurate to within 30 seconds";
    } else if (status === 404 && !contentType.includes("json")) {
      hint = " — the base URL may not be serving the API; see the README";
    }

    const error = new ApiError(
      `${method} ${path}: ${status} ${message}${hint}`,
      status,
      code,
      transient,
    );
    if (status === 429) {
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
    }
    return error;
  }

  /**
   * Compare the server's clock with ours.
   *
   * `Date` is second-granular, so a small reading is noise; only a gap large
   * enough to matter against the ±30s signing window is worth reporting, and
   * only once.
   */
  private checkClockSkew(response: Response): void {
    if (this.skewWarned) return;
    const serverDate = response.headers.get("date");
    if (serverDate === null) return;
    const serverMs = Date.parse(serverDate);
    if (Number.isNaN(serverMs)) return;
    const skew = Date.now() - serverMs;
    if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
      this.skewWarned = true;
      this.onWarning(
        `this machine's clock is ${(skew / 1000).toFixed(1)}s ` +
          `${skew > 0 ? "ahead of" : "behind"} the exchange. Signatures are ` +
          "rejected beyond ±30s — fix the clock before trusting a 401.",
      );
    }
  }
}
