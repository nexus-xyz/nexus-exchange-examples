// One hardened unauthenticated `GET`.
//
// Adapted from `account-statement`'s copy (CONTRIBUTING.md § 1), with the
// signing removed: **every surface this app reads is public**, so there is no
// secret, no canonical string, and no clock-skew window to fall outside of.
// That deletes the single largest source of first-run failure in the
// authenticated examples, which is most of why this one is the one to run
// first.
//
// What did *not* get deleted, and why each item is still worth its few lines
// even with nothing to sign:
//
//   * **Redirects are never followed.** No operation in the spec answers 3xx,
//     so a `301` here means the base URL points at something that is not the
//     API — usually a web frontend that will happily serve an HTML login page
//     with a `200` at the end of the chain. Refusing to follow turns that into
//     one clear error instead of a `JSON.parse` failure three hops away.
//
//   * **Every request has a deadline and an abort path**, bodies are read with
//     a byte cap, and the content type is checked before parsing. The HTML 404
//     page from a host that is not the API is the most common first-run
//     failure, and `JSON.parse` on it tells the reader nothing.
//
//   * **Pacing, still.** Public does not mean unmetered: the live testnet
//     answered a public `GET /markets/{id}/funding` with `x-ratelimit-limit:
//     50` and `x-ratelimit-remaining: 49`. See `budget.ts`.
//
// Everything this app sends is a `GET`, so every request is idempotent and
// retrying one can never duplicate anything.

import { abortReason, oneLine, sleep } from "./async.js";
import type { RateBudget } from "./budget.js";
import type { Config } from "./config.js";

/** Ceiling on a response body. The widest answer here is ~26 KB. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Per-request deadline. Generous enough for a cold start, short enough to fail. */
const REQUEST_TIMEOUT_MS = 20_000;

const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;

/** The spec tag this example is written against. Advisory, informational. */
export const API_VERSION = "v0.9.47";

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

export interface GetOptions {
  /** The indexer-visible path, e.g. `/api/v1/tickers`. */
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  /** Weighted cost, in the same unit as `remaining`. Defaults to 1. */
  readonly weight?: number;
}

/** A response body together with the headers that qualify it. */
export interface Answer<T> {
  readonly body: T;
  readonly headers: Headers;
}

/** Percent-encode a query string. */
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

export function headerInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export class RestClient {
  constructor(
    private readonly config: Config,
    private readonly budget: RateBudget,
    /** Aborted on shutdown; every in-flight request unwinds with it. */
    private readonly shutdownSignal: AbortSignal,
    private readonly onWarning: (message: string) => void,
  ) {}

  /** Perform one GET, paced against the read budget and retried when safe. */
  async get<T>(options: GetOptions): Promise<Answer<T>> {
    const { path, query = [], weight = 1 } = options;

    const queryString = encodeQuery(query);
    const url =
      queryString.length === 0
        ? `${this.config.baseUrl}${path}`
        : `${this.config.baseUrl}${path}?${queryString}`;

    // Assert the URL parser agrees with us about the path we think we are
    // sending. Nothing is signed here, so this is not a signature guard — it
    // is a typo guard, and it catches the one case that is otherwise silent: a
    // market id with a character that gets re-encoded, which would 404 against
    // a market that exists.
    //
    // The base's own path prefix, with any trailing slash removed. A base with
    // no prefix at all — a local stack on `http://127.0.0.1:8080`, or the bare
    // testnet host — has `pathname === "/"`, and concatenating that with a
    // path that already starts with `/` yields `//api/v1/...`, which never
    // equals what the URL parser produces. Getting this wrong fires the guard
    // on every single request and the app cannot talk to that deployment at
    // all.
    const parsed = new URL(url);
    const basePath = new URL(this.config.baseUrl).pathname.replace(/\/+$/, "");
    const expectedPath = `${basePath}${path}`;
    if (parsed.pathname !== expectedPath) {
      throw new Error(
        `path would be rewritten on the wire (${expectedPath} → ` +
          `${parsed.pathname}); refusing to send a path that differs from ` +
          "what was asked for",
      );
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (weight > 0) {
        await this.budget.reserve(weight, this.shutdownSignal);
      }
      try {
        return await this.attempt<T>(url, path);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const rateLimited =
          lastError instanceof ApiError && lastError.status === 429;
        const retryable =
          attempt < MAX_ATTEMPTS &&
          !this.shutdownSignal.aborted &&
          (rateLimited ||
            lastError instanceof TransportError ||
            (lastError instanceof ApiError && lastError.transient));
        if (!retryable) throw lastError;

        const hinted = rateLimited ? (lastError as ApiError).retryAfterMs : null;
        await sleep(hinted ?? backoffDelay(attempt), this.shutdownSignal);
      }
    }
    // Unreachable: the loop either returns or throws. Kept so the type is honest.
    throw lastError ?? new TransportError(`GET ${path} failed`);
  }

  private async attempt<T>(url: string, path: string): Promise<Answer<T>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      // Advisory only: attribution, never access control. Named so the
      // operator can see which contract this was built against.
      "x-nexus-api-version": API_VERSION,
      "user-agent": "nexus-exchange-examples-funding-carry/0.0.0",
    };

    // Two reasons to give up: our own deadline, and process shutdown.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, this.shutdownSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        // See the header comment: a 3xx here means this is not the API.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (this.shutdownSignal.aborted) throw abortReason(this.shutdownSignal);
      const detail = error instanceof Error ? oneLine(error.message) : "unknown";
      throw new TransportError(`GET ${path}: ${detail}`);
    }

    // `x-ratelimit-limit` / `-remaining` ride every response, including the
    // public ones. `x-ratelimit-reset` is deliberately not read: it is sent on
    // a `429` only, so a limiter that waits for a reset it never saw waits
    // forever.
    this.budget.observeHeaders(
      headerInteger(response.headers, "x-ratelimit-limit"),
      headerInteger(response.headers, "x-ratelimit-remaining"),
    );

    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location") ?? "an unnamed target";
      throw new ApiError(
        `GET ${path}: refused to follow a ${response.status} redirect to ` +
          `${target}. No API operation answers 3xx, so this path is not served ` +
          "at the configured base URL. Check NEXUS_EXCHANGE_API_URL.",
        response.status,
        null,
        false,
      );
    }

    const text = await this.readBounded(response, `GET ${path}`);
    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      throw this.toApiError(path, response, text, contentType);
    }

    if (text.length === 0) {
      return { body: undefined as T, headers: response.headers };
    }

    if (!contentType.includes("json")) {
      throw new ApiError(
        `GET ${path}: expected JSON, got ${oneLine(contentType, 60)}. ` +
          "That usually means the base URL points at a web frontend rather " +
          'than the API — see the README\'s "About the host".',
        response.status,
        null,
        false,
      );
    }

    try {
      return { body: JSON.parse(text) as T, headers: response.headers };
    } catch {
      throw new ApiError(
        `GET ${path}: response was not valid JSON`,
        response.status,
        null,
        false,
      );
    }
  }

  /**
   * Read a response body with a hard byte cap.
   *
   * `response.text()` would buffer whatever arrives. Reading the stream by
   * hand costs a few lines and makes an unbounded body a clean error instead
   * of an out-of-memory kill.
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
    path: string,
    response: Response,
    text: string,
    contentType: string,
  ): ApiError {
    let code: string | null = null;
    // A non-JSON error body is a whole HTML page, and quoting 200 characters
    // of `<head>` at the reader tells them nothing they can act on. Name the
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
        }
      } catch {
        // Keep the raw one-liner; a malformed error body is still a signal.
      }
    }

    const status = response.status;
    // 429 and 5xx can succeed on repetition; 408 is a timeout the server owns.
    // A 403 in TERMINAL_FORBIDDEN_CODES never can.
    const transient = status === 429 || status === 408 || status >= 500;

    let hint = "";
    if (status === 401) {
      hint =
        " — this example sends no credentials, and every path it uses is " +
        "declared public in the spec. A 401 here means the deployment is " +
        "routing that path to its authenticated catch-all rather than to the " +
        "handler. Measured on testnet for GET /api/v1/markets; see the README.";
    } else if (status === 403 && code !== null && TERMINAL_FORBIDDEN_CODES.has(code)) {
      hint =
        " — a jurisdiction refusal. Unlike a 429 this is a decision, not a " +
        "condition: retrying returns the same answer.";
    } else if (status === 404 && !contentType.includes("json")) {
      hint =
        " — the base URL may not be serving the API. The testnet base is " +
        "https://api.testnet.nexus.xyz/indexer, prefix included; the bare " +
        "host 404s on every path.";
    } else if (status === 503) {
      hint =
        " — the deployment routed the request and had no healthy upstream to " +
        "give it to. That is an availability problem at the venue, not a " +
        "wrong base URL: a wrong prefix answers 404, not 503. Retrying is " +
        "the right response, and this client already did.";
    }

    const error = new ApiError(
      `GET ${path}: ${status} ${message}${hint}`,
      status,
      code,
      transient,
    );
    if (status === 429) {
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      this.budget.note429(error.retryAfterMs);
    }
    return error;
  }

  /** Report a non-fatal oddity to whoever wired this client up. */
  warn(message: string): void {
    this.onWarning(message);
  }
}
