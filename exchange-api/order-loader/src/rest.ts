// One signed `fetch`, with the sharp edges filed off — and with the rate-limit
// budget wired through it, which is the part specific to this example.
//
// The hardening is the same set `trading-terminal` carries, and worth restating
// because each item is cheap and none is obvious until it has bitten you:
//
//   * **Redirects are never followed.** `fetch` strips `Authorization` across
//     an origin change but *not* custom headers, so a signed request answered
//     with a `301` would hand `x-api-key` and a valid `x-signature` to whatever
//     host the `Location` names. No operation in the spec answers 3xx.
//
//   * **A submit is never retried on an ambiguous failure.** A timeout is not
//     evidence that the batch did not reach the matching engine; it is the
//     absence of evidence either way, and re-sending is how forty intended
//     orders become eighty real ones. A `429` is the exception and the reason
//     `transient` exists as a separate flag from `idempotent`: a refusal is a
//     statement that the request was *not* processed, so repeating it is safe.
//
//   * **Every request has a deadline and an abort path**, bodies are read with
//     a byte cap, and the content type is checked before parsing — the HTML
//     404 page from a host that is not the API is the single most common
//     first-run failure, and `JSON.parse` on it tells the reader nothing.
//
//   * **Clock skew is surfaced.** Signatures are valid for ±30s, and a drifting
//     clock fails every call in the run with a `401` indistinguishable from a
//     bad secret.

import { abortReason, oneLine, sleep } from "./async.js";
import type { BucketName, RateBudget, WireBucket } from "./budget.js";
import type { Config } from "./config.js";
import { decodeSecret, signRequest } from "./signing.js";

/** Ceiling on a response body. Far above any real response from this API. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Per-request deadline. Generous enough for a cold start, short enough to fail. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Retry budget for calls that are safe to repeat. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;

/** Signatures are refused outside ±30s, so warn well before we get there. */
const CLOCK_SKEW_WARN_MS = 5_000;

/** The spec tag this example is written against. Advisory, outside the signature. */
const API_VERSION = "v0.8.1";

/**
 * The `403` refusals that are decisions rather than conditions.
 *
 * A `429` is retryable and a `403` is not, and a retry loop that covers both
 * turns a permanent geographic refusal into four identical requests and a
 * confusing log. They are listed by code because the codes are stable; the
 * message is a diagnostic whose wording is not.
 */
const TERMINAL_FORBIDDEN_CODES = new Set([
  "RESTRICTED_JURISDICTION",
  "US_RESTRICTED",
  "GEO_UNRESOLVED",
]);

export class ApiError extends Error {
  /** Server-supplied hint from a `429`, when it sent one. */
  retryAfterMs: number | null = null;
  /** Which budget refused, from the `429` body or the `x-ratelimit-bucket` header. */
  bucket: WireBucket | null = null;

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
   * The indexer-visible path, e.g. `/api/v1/orders/batch`. This is both
   * appended to the base URL and signed — one value, so the two cannot
   * disagree.
   */
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly body?: unknown;
  readonly signed?: boolean;
  /**
   * Whether repeating this exact request is harmless. Defaults to `false`.
   *
   * Opt *in*, never out: an endpoint added by a future reader is
   * non-idempotent until someone has thought about it, which is the safe way
   * for the default to be wrong.
   */
  readonly idempotent?: boolean;
  /** Which budget this call is charged to. Defaults to the request class. */
  readonly bucket?: BucketName;
  /**
   * Weighted cost, in the same unit as `remaining`. Defaults to 1.
   *
   * Pass `0` for `GET /account/rate-limit`, which consumes no tokens — it is
   * the only operation that does not, and the reason this app can pace itself
   * without paying to find out how.
   */
  readonly weight?: number;
}

/** Percent-encode a query string once, and use the identical bytes for both. */
function encodeQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
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

/**
 * `Retry-After` is either delta-seconds or an HTTP date; both appear in the
 * wild, and the spec promises seconds never below 1.
 */
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

function parseBucketLabel(value: unknown): WireBucket | null {
  const labels: readonly string[] = ["key", "owner", "order", "cancel", "ip", "login"];
  return typeof value === "string" && labels.includes(value)
    ? (value as WireBucket)
    : null;
}

function headerInteger(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export class RestClient {
  private readonly secret: Buffer | null;
  /** Signed but reported once: a repeated warning every second is noise. */
  private skewWarned = false;

  constructor(
    private readonly config: Config,
    private readonly budget: RateBudget,
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
   * Perform one API call, paced against the budget it is charged to and
   * retried only when that is provably safe.
   */
  async request<T>(options: RequestOptions): Promise<T> {
    const {
      method,
      path,
      query = [],
      body,
      signed = false,
      idempotent = false,
      bucket = "request",
      weight = 1,
    } = options;

    if (signed && (this.secret === null || this.config.credentials === null)) {
      throw new MissingCredentialsError(`${method} ${path}`);
    }

    const queryString = encodeQuery(query);
    const url =
      queryString.length === 0
        ? `${this.config.baseUrl}${path}`
        : `${this.config.baseUrl}${path}?${queryString}`;

    // Assert the URL parser agrees with us about both halves of what is about
    // to be signed. If it did not, the signature would cover bytes the server
    // never receives and the only symptom would be a bare `401`.
    //
    // Not hypothetical on either half: the parser normalises `.` and `..`
    // segments, and it is free to re-encode characters our own
    // `encodeURIComponent` left alone.
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
      if (weight > 0) {
        await this.budget.reserve(bucket, weight, this.shutdownSignal);
      }
      try {
        return await this.attempt<T>(
          method,
          url,
          path,
          queryString,
          payload,
          signed,
          bucket,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const rateLimited =
          lastError instanceof ApiError && lastError.status === 429;

        // A `429` is a refusal, not an ambiguous outcome: the request was not
        // processed, so repeating it cannot duplicate anything. That is why it
        // is retried even for a non-idempotent call, and why nothing else is.
        const retryable =
          attempt < MAX_ATTEMPTS &&
          !this.shutdownSignal.aborted &&
          (rateLimited ||
            (idempotent &&
              (lastError instanceof TransportError ||
                (lastError instanceof ApiError && lastError.transient))));
        if (!retryable) throw lastError;

        const hinted = rateLimited
          ? (lastError as ApiError).retryAfterMs
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
    bucket: BucketName,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      // Advisory only, and outside the signature: attribution, never access
      // control. Named so the operator can see which contract this was built
      // against.
      "x-nexus-api-version": API_VERSION,
      "user-agent": "nexus-exchange-examples-order-loader/0.0.0",
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

    // `x-ratelimit-limit` / `-remaining` ride on every authenticated response.
    // Only the request class is resynced from them — see the method's comment.
    if (bucket === "request") {
      this.budget.observeRequestHeaders(
        headerInteger(response, "x-ratelimit-limit"),
        headerInteger(response, "x-ratelimit-remaining"),
      );
    }

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
          'than the API — see the README\'s "About the host".',
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
    let wireBucket: WireBucket | null = null;
    // A non-JSON error body is a whole HTML page, and quoting 200 characters of
    // `<head>` at the reader tells them nothing they can act on. Name the
    // content type instead — *that* is the diagnosis.
    let message = contentType.includes("json")
      ? oneLine(text) || response.statusText
      : `${response.statusText || "error"} (non-JSON body, content-type: ` +
        `${oneLine(contentType, 40) || "none"})`;
    if (contentType.includes("json") && text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object") {
          const envelope = parsed as Record<string, unknown>;
          if (typeof envelope["code"] === "string") code = envelope["code"];
          if (typeof envelope["message"] === "string") {
            message = oneLine(envelope["message"]);
          }
          wireBucket = parseBucketLabel(envelope["bucket"]);
        }
      } catch {
        // Keep the raw one-liner; a malformed error body is still a signal.
      }
    }

    const status = response.status;
    // 429 and 5xx can succeed on repetition; 408 is a timeout the server owns.
    // A 403 never can — see TERMINAL_FORBIDDEN_CODES.
    const transient = status === 429 || status === 408 || status >= 500;

    let hint = "";
    if (status === 401) {
      hint =
        " — check the API key and secret, that they were minted on this host, " +
        "and that this machine's clock is accurate to within 30 seconds";
    } else if (status === 403 && code !== null && TERMINAL_FORBIDDEN_CODES.has(code)) {
      hint =
        " — a jurisdiction refusal. Unlike a 429 this is a decision, not a " +
        "condition: retrying returns the same answer.";
    } else if (status === 404 && !contentType.includes("json")) {
      hint =
        " — the base URL may not be serving the API. The testnet base is " +
        "https://api.testnet.nexus.xyz/indexer, prefix included; the bare " +
        "host 404s on every path.";
    }

    const error = new ApiError(
      `${method} ${path}: ${status} ${message}${hint}`,
      status,
      code,
      transient,
    );
    if (status === 429) {
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      // The body's `bucket` and the header agree; read whichever arrived. A
      // proxy or a retry wrapper that never parses the body still gets the
      // header, which is why the venue sends both.
      error.bucket =
        wireBucket ?? parseBucketLabel(response.headers.get("x-ratelimit-bucket"));
      this.budget.note429(error.bucket, error.retryAfterMs);
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
