// One signed `fetch`, with the sharp edges filed off, plus the cursor walk
// every history surface here needs.
//
// The hardening is the set `trading-terminal` and `order-loader` carry, and
// worth restating because each item is cheap and none is obvious until it has
// bitten you:
//
//   * **Redirects are never followed.** `fetch` strips `Authorization` across
//     an origin change but *not* custom headers, so a signed request answered
//     with a `301` would hand `x-api-key` and a valid `x-signature` to
//     whatever host the `Location` names. No operation in the spec answers
//     3xx.
//
//   * **Every request has a deadline and an abort path**, bodies are read with
//     a byte cap, and the content type is checked before parsing — the HTML
//     404 page from a host that is not the API is the single most common
//     first-run failure, and `JSON.parse` on it tells the reader nothing.
//
//   * **Clock skew is surfaced.** Signatures are valid for ±30s, and a
//     drifting clock fails every call with a `401` indistinguishable from a
//     bad secret.
//
// Everything this app sends is a `GET`, so every request is idempotent and
// retrying one can never duplicate anything. That is a genuine simplification
// over `order-loader`, and the only one: a read-only app still has to pace
// itself, still has to bound its bodies, and still has to refuse to follow a
// redirect with a signature attached.

import { abortReason, oneLine, sleep } from "./async.js";
import type { RateBudget } from "./budget.js";
import type { Config } from "./config.js";
import { decodeSecret, signRequest } from "./signing.js";

/** Ceiling on a response body. A 1,000-fill page is far below this. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Per-request deadline. Generous enough for a cold start, short enough to fail. */
const REQUEST_TIMEOUT_MS = 20_000;

const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;

/** Signatures are refused outside ±30s, so warn well before we get there. */
const CLOCK_SKEW_WARN_MS = 5_000;

/** The spec tag this example is written against. Advisory, outside the signature. */
export const API_VERSION = "v0.8.1";

/**
 * A cursor walk stops here regardless of what the server says.
 *
 * The termination condition is the *absence* of `X-Next-Cursor` (see
 * `paginate`), which is correct and which is entirely in the server's hands. A
 * server that always returned a cursor would walk forever, and an analytics
 * tool left running overnight is exactly where that would be discovered. The
 * row cap in `Config` bounds it too; this bounds the pathological case where
 * pages come back empty.
 */
const MAX_PAGES = 200;

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

export class MissingCredentialsError extends Error {
  constructor(operation: string) {
    super(`${operation} needs API credentials; none are configured`);
    this.name = "MissingCredentialsError";
  }
}

export interface GetOptions {
  /** The indexer-visible path, e.g. `/api/v1/fills`. Signed and sent as one. */
  readonly path: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly signed?: boolean;
  /**
   * Weighted cost, in the same unit as `remaining`. Defaults to 1.
   *
   * Pass `0` for `GET /account/rate-limit`, which consumes no tokens — it is
   * the only operation that does not, and the reason this app can discover its
   * budget without paying to find out what it is.
   */
  readonly weight?: number;
}

/** A response body together with the headers that qualify it. */
export interface Answer<T> {
  readonly body: T;
  readonly headers: Headers;
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

function headerInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export class RestClient {
  private readonly secret: Buffer | null;
  /** Warned once: a repeated clock complaint every page is noise. */
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

  /** Perform one GET, paced against the read budget and retried when safe. */
  async get<T>(options: GetOptions): Promise<Answer<T>> {
    const { path, query = [], signed = false, weight = 1 } = options;

    if (signed && (this.secret === null || this.config.credentials === null)) {
      throw new MissingCredentialsError(`GET ${path}`);
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
    // `encodeURIComponent` left alone. This app puts server-issued *cursors*
    // in query strings, which are opaque by contract, so it is the one here
    // most likely to carry a byte someone disagrees about.
    const parsed = new URL(url);
    // The base's own path prefix, with any trailing slash removed. A base with
    // no prefix at all — a local stack on `http://127.0.0.1:8080`, or the bare
    // testnet host — has `pathname === "/"`, and concatenating that with a
    // path that already starts with `/` yields `//api/v1/...`, which never
    // equals what the URL parser produces. The guard then fires on every
    // single request and the app cannot talk to that deployment at all.
    // Caught by running this example against a loopback venue.
    const basePath = new URL(this.config.baseUrl).pathname.replace(/\/+$/, "");
    const expectedPath = `${basePath}${path}`;
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

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (weight > 0) {
        await this.budget.reserve(weight, this.shutdownSignal);
      }
      try {
        return await this.attempt<T>(url, path, queryString, signed);
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

  private async attempt<T>(
    url: string,
    path: string,
    queryString: string,
    signed: boolean,
  ): Promise<Answer<T>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      // Advisory only, and outside the signature: attribution, never access
      // control. Named so the operator can see which contract this was built
      // against.
      "x-nexus-api-version": API_VERSION,
      "user-agent": "nexus-exchange-examples-account-statement/0.0.0",
    };

    if (signed && this.secret !== null && this.config.credentials !== null) {
      Object.assign(
        headers,
        signRequest(
          this.config.credentials.apiKey,
          this.secret,
          "GET",
          path,
          queryString,
          new Uint8Array(0),
          Date.now(),
        ),
      );
    }

    // Two reasons to give up: our own deadline, and process shutdown.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, this.shutdownSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        // See the header comment: following one leaks the signature.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (this.shutdownSignal.aborted) throw abortReason(this.shutdownSignal);
      const detail = error instanceof Error ? oneLine(error.message) : "unknown";
      throw new TransportError(`GET ${path}: ${detail}`);
    }

    this.checkClockSkew(response);

    // `x-ratelimit-limit` / `-remaining` ride every authenticated response.
    // `x-ratelimit-reset` is deliberately not read: it is sent on a `429`
    // only, so a limiter that waits for a reset it never saw waits forever.
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

/** What a cursor walk found, and what it could not reach. */
export interface Page<T> {
  readonly rows: readonly T[];
  /** True when the row cap stopped the walk before the server ran out. */
  readonly capped: boolean;
  /** Headers from the FIRST page — where the depth signals ride. */
  readonly headers: Headers;
}

/**
 * Walk a cursor-paginated list endpoint to the row cap.
 *
 * **The walk terminates on the absence of `X-Next-Cursor`, never on a short
 * page.** The header's own documentation is explicit that the two are not the
 * same question: *"a page can be shorter than `limit` and still carry a
 * cursor, and a page that exactly fills `limit` with nothing beyond it carries
 * none."* Stopping on a short page silently truncates a statement, and it does
 * it on exactly the accounts with the most history — which is to say, the ones
 * a statement is for.
 *
 * A cursor is opaque by contract, so it is passed back verbatim and never
 * parsed. It is compared to the previous one only to break the loop a server
 * repeating itself would otherwise cause.
 */
export async function paginate<T>(
  client: RestClient,
  path: string,
  pageSize: number,
  maxRows: number,
  weight: number,
  extraQuery: ReadonlyArray<readonly [string, string]> = [],
): Promise<Page<T>> {
  const rows: T[] = [];
  let cursor: string | null = null;
  let firstHeaders: Headers | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remaining = maxRows - rows.length;
    if (remaining <= 0) break;

    const query: Array<readonly [string, string]> = [
      ["limit", String(Math.min(pageSize, remaining))],
      ...extraQuery,
    ];
    if (cursor !== null) query.push(["cursor", cursor]);

    const answer = await client.get<T[]>({ path, query, signed: true, weight });
    firstHeaders ??= answer.headers;

    if (!Array.isArray(answer.body)) {
      throw new TypeError(`GET ${path}: expected a JSON array`);
    }
    rows.push(...answer.body);

    const next = answer.headers.get("x-next-cursor");
    // Absent header: the last page, by contract. Not "the page was short".
    if (next === null || next.length === 0) {
      return { rows, capped: false, headers: firstHeaders };
    }
    if (next === cursor) {
      throw new Error(
        `GET ${path}: the server repeated cursor ${oneLine(next, 32)}; ` +
          "stopping rather than looping",
      );
    }
    cursor = next;
  }

  return {
    rows,
    capped: true,
    headers: firstHeaders ?? new Headers(),
  };
}
