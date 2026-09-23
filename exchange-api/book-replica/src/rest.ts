// The REST half: one unauthenticated GET, with the sharp edges filed off.
//
// A cut-down copy of `trading-terminal/src/rest.ts` — no signing, because
// nothing here needs a key — keeping the defences that matter for a read path:
// a deadline on every request, a byte cap on every body, the content type
// checked before `JSON.parse`, redirects refused rather than followed, and
// retries only on what can plausibly succeed the second time.

import * as dec from "./decimal.js";
import { toSeq } from "./frames.js";
import type { BookSnapshot } from "./frames.js";
import type { RestBook, RestLevel } from "./replica.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3;

/** Sent on every request: the contract this was built against. Advisory, not access control. */
export const API_VERSION = "v0.8.1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `setTimeout` that unwinds when `signal` aborts, instead of outliving it. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export class RestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly shutdown: AbortSignal,
  ) {}

  /** GET a JSON document, retrying transport failures, `429` and `5xx`. */
  async get(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.attempt(path);
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof ApiError) || error.transient;
        if (!retryable || attempt === MAX_ATTEMPTS || this.shutdown.aborted) throw error;
        // Equal jitter: never zero, never synchronised across clients.
        const ceiling = 250 * 2 ** attempt;
        await sleep(ceiling / 2 + Math.random() * (ceiling / 2), this.shutdown);
      }
    }
    throw lastError;
  }

  private async attempt(path: string): Promise<unknown> {
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.shutdown]);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: "application/json",
          "x-nexus-api-version": API_VERSION,
          "user-agent": "nexus-exchange-examples-book-replica/0.0.0",
        },
        // No operation in the spec answers 3xx, so a redirect only ever means
        // the base URL is wrong — say so instead of quietly reading another host.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new Error(`GET ${path}: ${error instanceof Error ? oneLine(error.message) : "failed"}`);
    }
    const text = await readBounded(response, path);
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(
        `GET ${path}: refused a ${response.status} redirect — check NEXUS_EXCHANGE_API_URL`,
        response.status,
        false,
      );
    }
    if (!response.ok) {
      const body = contentType.includes("json") ? oneLine(text) : `non-JSON body (${contentType || "no content-type"})`;
      const status = response.status;
      throw new ApiError(`GET ${path}: ${status} ${body}`, status, status === 429 || status >= 500);
    }
    if (!contentType.includes("json")) {
      throw new ApiError(
        `GET ${path}: expected JSON, got ${oneLine(contentType, 60) || "no content-type"} — ` +
          "the base URL may point at a web frontend rather than the API",
        response.status,
        false,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(`GET ${path}: response was not valid JSON`, response.status, false);
    }
  }

  /** `GET /markets/{market_id}/orderbook`, parsed into the shape `crossCheck` compares. */
  async orderBook(market: string): Promise<RestBook> {
    const raw = await this.get(`/markets/${encodeURIComponent(market)}/orderbook`);
    const book = parseRestBook(raw);
    if (book === null) throw new Error(`GET /markets/${market}/orderbook: not a {bids, asks, nonce} book`);
    return book;
  }
}

async function readBounded(response: Response, path: string): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`GET ${path}: response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRestSide(raw: unknown, descending: boolean): RestLevel[] | null {
  if (!Array.isArray(raw)) return null;
  const levels: RestLevel[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const [price, size] = entry as unknown[];
    if (typeof price !== "number" || typeof size !== "number") continue;
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    levels.push({ price, size });
  }
  // Sorting doubles is exact — the comparison, unlike arithmetic, loses nothing.
  levels.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  return levels;
}

/** The CCXT-shaped REST book: `[price, amount]` doubles, and `nonce` = the projection sequence. */
export function parseRestBook(raw: unknown): RestBook | null {
  if (raw === null || typeof raw !== "object") return null;
  const book = raw as Record<string, unknown>;
  const bids = parseRestSide(book["bids"], true);
  const asks = parseRestSide(book["asks"], false);
  if (bids === null || asks === null) return null;
  return { nonce: toSeq(book["nonce"]), bids, asks };
}

/** A REST book as a replica snapshot. The doubles become exact decimals via their shortest form. */
export function toSnapshot(rest: RestBook): BookSnapshot {
  const side = (levels: readonly RestLevel[]) =>
    levels.map((level) => ({ price: dec.fromNumber(level.price), size: dec.fromNumber(level.size) }));
  return { bids: side(rest.bids), asks: side(rest.asks) };
}
