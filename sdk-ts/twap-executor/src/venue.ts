// Everything that talks to the venue, and the retry policy in one place.
//
// The SDK does the signing, the transport hardening and the typed calls. This
// module adds the three things the SDK leaves to its caller:
//
//  * **Pacing.** Every call reserves its spec weight from the right budget
//    first. The SDK's `fetchImpl` hook is used to watch every response's
//    rate-limit headers, since the SDK's typed methods don't surface them.
//  * **A retry policy this app owns.** The SDK is built with `maxRetries: 0`.
//    Its own policy is sound (it never retries a `POST`) but it waits exactly
//    `retry-after` with no jitter on top, and it retries a `DELETE` on its own
//    schedule. Here reads and cancels are retried on `429` and transient
//    failures, with jitter. An order submission is **never** retried.

import {
  ApiError,
  Client,
  NexusExchangeError,
  TransportError,
  customNetwork,
} from "@nexus-xyz/exchange-ts";
import type { Market, OrderBook, OrderRequest, OrderResponse } from "@nexus-xyz/exchange-ts";

import type { Config } from "./config.js";
import { ConfigError } from "./config.js";
import { classify, parseRetryAfter } from "./pacer.js";
import type { Budget, Pacer } from "./pacer.js";
import { weightOf } from "./weights.js";

/** Per-attempt ceiling. A child order is time-sensitive, so this is short. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Attempts for a read or a cancel. An order submission gets exactly one. */
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4_000;

/** A child order as sent: the SDK's request plus the venue's idempotency key. */
export type ChildOrder = OrderRequest & { client_id: string };

/**
 * What happened to one submission. Three outcomes, not two, and the middle one
 * is the reason the journal and the client ids exist.
 */
export type Submission =
  | { readonly kind: "accepted"; readonly replay: boolean; readonly response: OrderResponse }
  /** The venue answered no. Nothing was placed by this request. */
  | { readonly kind: "refused"; readonly status: number; readonly code: string | null; readonly detail: string }
  /** No answer, or a 5xx. The order may or may not exist. Reconcile, never resend. */
  | { readonly kind: "unknown"; readonly detail: string };

export function describe(error: unknown): string {
  const flat = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

function isTransient(error: unknown): boolean {
  return error instanceof NexusExchangeError && error.transient;
}

function is429(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/** Equal jitter: half fixed, half random. Never zero, and spread across clients. */
function backoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export class Venue {
  readonly client: Client;
  /** Status of the most recent `POST /orders`: tells a `201` from a `200` replay. */
  private lastOrderStatus: number | null = null;

  constructor(
    private readonly config: Config,
    private readonly pacer: Pacer,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly note: (message: string) => void,
  ) {
    let network;
    try {
      network = customNetwork({
        label: config.baseUrlOverridden ? "custom" : "testnet",
        baseUrl: config.baseUrl,
        funds: config.funds,
      });
    } catch (error) {
      throw new ConfigError(`NEXUS_EXCHANGE_API_URL was rejected: ${describe(error)}`);
    }
    this.client = new Client({
      network,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      fetchImpl: this.instrumented,
    });
  }

  get hasCredentials(): boolean {
    return this.client.hasCredentials;
  }

  /**
   * `fetch`, with the rate-limit headers read off every response.
   *
   * An arrow property so `this` survives being handed to the SDK. It never
   * changes the request, only observes the response, so the signature the SDK
   * computed still covers exactly the bytes that are sent.
   */
  private readonly instrumented = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    this.pacer.observe(response.headers);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && /\/orders$/.test(url.pathname)) this.lastOrderStatus = response.status;
    if (response.status === 429) {
      this.pacer.note429(
        response.headers.get("x-ratelimit-bucket"),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return response;
  };

  /**
   * One read or cancel: reserve its weight, then try, retrying only what's safe.
   *
   * On a `429` the instrumented fetch has already paused the refusing budget
   * for `retry-after` plus jitter, so the next `reserve` is what waits. Nothing
   * here sleeps a second time on top of it.
   */
  private async idempotent<T>(method: string, template: string, call: () => Promise<T>): Promise<T> {
    const budget: Budget = classify(method, template);
    const weight = weightOf(method, template);
    for (let attempt = 0; ; attempt += 1) {
      await this.pacer.reserve(budget, weight, this.sleep);
      try {
        return await call();
      } catch (error) {
        if (attempt + 1 >= MAX_ATTEMPTS) throw error;
        if (is429(error)) continue;
        if (!isTransient(error)) throw error;
        const wait = backoff(attempt);
        this.note(`${method} ${template}: ${describe(error)}; retrying in ${(wait / 1000).toFixed(2)}s`);
        await this.sleep(wait);
      }
    }
  }

  /** `GET /markets`. Signed, per the spec, so it needs credentials. */
  markets(): Promise<Market[]> {
    return this.idempotent("GET", "/markets", () => this.client.fetchMarkets());
  }

  /** `GET /api/v1/markets/{id}/orderbook`. Public. */
  book(market: string): Promise<OrderBook> {
    return this.idempotent("GET", "/api/v1/markets/{market_id}/orderbook", () => this.client.fetchOrderBook(market));
  }

  /** `GET /account/rate-limit`. Weight 0: the one free call. */
  rateLimit(): Promise<unknown> {
    return this.idempotent("GET", "/api/v1/account/rate-limit", () => this.client.getRateLimit());
  }

  openOrders(): Promise<unknown[]> {
    return this.idempotent("GET", "/api/v1/orders", () => this.client.getOpenOrders());
  }

  /** Weight 5 by the spec's marker, so it's read once per reconcile, not per slice. */
  orderHistory(): Promise<unknown[]> {
    return this.idempotent("GET", "/api/v1/orders/history", () => this.client.getOrderHistory({ limit: 500 }));
  }

  /** Weight 5 by the spec's marker. */
  fills(): Promise<unknown[]> {
    return this.idempotent("GET", "/api/v1/fills", () => this.client.getFills({ limit: 1000 }));
  }

  /**
   * `POST /orders`, exactly once.
   *
   * No retry of any kind, including on a `429`. A `429` does say the request
   * wasn't processed, so it's classified `refused`, and the scheduler rolls
   * that slice's quantity into the next one. But the decision to send again is
   * the scheduler's, at the next slice time, with a fresh price and a fresh
   * client id. It isn't a transport loop re-sending a stale order.
   *
   * `POST /orders/preview` is deliberately never called. It's a trading action
   * billed to the same budget as a placement, so previewing every child would
   * halve the rate this app can place at, to learn what the IOC result tells
   * it anyway.
   */
  async place(order: ChildOrder): Promise<Submission> {
    await this.pacer.reserve("order", weightOf("POST", "/api/v1/orders"), this.sleep);
    this.lastOrderStatus = null;
    try {
      const response = await this.client.placeOrder(order);
      return { kind: "accepted", replay: this.lastOrderStatus === 200, response };
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        return { kind: "refused", status: error.status, code: error.code ?? null, detail: describe(error) };
      }
      // A local SDK rejection (bad request shape, missing credentials) is
      // thrown before a byte is sent, so it's a definite "not placed". Only a
      // transport failure or a 5xx leaves the outcome open.
      if (error instanceof NexusExchangeError && !(error instanceof ApiError) && !(error instanceof TransportError)) {
        return { kind: "refused", status: 0, code: null, detail: describe(error) };
      }
      return { kind: "unknown", detail: describe(error) };
    }
  }

  /**
   * `DELETE /api/v1/orders/{id}?market_id=…`. A cancel is idempotent, so it's
   * retried, and a 404 means it's already gone, which is the goal.
   */
  cancel(orderId: string, market: string): Promise<void> {
    return this.idempotent("DELETE", "/api/v1/orders/{order_id}", async () => {
      try {
        await this.client.cancelOrder(orderId, market);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    });
  }
}

