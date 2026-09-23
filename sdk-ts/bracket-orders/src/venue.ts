// Everything that talks to the venue over REST.
//
// The SDK does the signing, the transport and the typed calls. This module adds
// what a bracket needs on top:
//
//  * **Placement is sent exactly once.** The SDK never retries a `POST`, and
//    nothing here does either. A placement whose answer never arrived is
//    `unknown`, and an unknown placement is resolved by reading, never by
//    sending again.
//  * **The one route the pinned SDK gets wrong.** `cancelOrder` in 0.4.0 sends
//    `DELETE /orders/{id}` with no `market_id`, which spec v0.8.1 marks
//    `required: true` ("required for routing"); tracked as ENG-17118. It's sent
//    here with the SDK's own exported `signRequest`, so the signing is still the
//    SDK's. This is the call one-cancels-other depends on, so it matters.

import {
  API_VERSION,
  ApiError,
  Client,
  NexusExchangeError,
  TransportError,
  customNetwork,
  signRequest,
} from "@nexus-xyz/exchange-ts";
import type { CancelOnDisconnectStatus, Market, OrderBook, OrderResponse } from "@nexus-xyz/exchange-ts";

import type { BracketOrder } from "./bracket.js";
import type { Config } from "./config.js";
import { ConfigError } from "./config.js";

/** Per-attempt ceiling. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** Attempts for a cancel. It's idempotent, and it's the OCO. */
const CANCEL_ATTEMPTS = 4;

export type Submission =
  | { readonly kind: "accepted"; readonly response: OrderResponse }
  /** The venue answered no. Nothing was placed by this request. */
  | { readonly kind: "refused"; readonly status: number; readonly detail: string }
  /** No answer, or a 5xx. The order may or may not exist. Reconcile, never resend. */
  | { readonly kind: "unknown"; readonly detail: string };

export function describe(error: unknown): string {
  const flat = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

export function isTransient(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 429) return true;
  return error instanceof NexusExchangeError && error.transient;
}

export class Venue {
  readonly client: Client;
  /** How many times a WebSocket token has been minted. Every call after the first is a reconnect. */
  tokensMinted = 0;

  constructor(
    private readonly config: Config,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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
    });
  }

  get hasCredentials(): boolean {
    return this.client.hasCredentials;
  }

  /**
   * The WebSocket token provider, counted.
   *
   * The SDK's socket client calls this on every connect and reconnect, and it
   * resubscribes with `since` on its own. It doesn't tell its consumer that it
   * reconnected. The replay that `since` asks for is bounded by the server's
   * ring, and only an overrun is announced (`out_of_sync`). So the count is how
   * this app learns a reconnect happened, and a reconnect is always followed by
   * a full REST reconcile before anything is cancelled.
   */
  tokenProvider(onMint: () => void = () => {}): () => Promise<string> {
    const mint = this.client.wsTokenProvider();
    return async () => {
      this.tokensMinted += 1;
      onMint();
      return mint();
    };
  }

  markets(): Promise<Market[]> {
    return this.client.fetchMarkets();
  }

  /** The mark price, or `null` when the venue says it has none (it answers 503 while the book poller is down). */
  async markPrice(market: string): Promise<string | null> {
    try {
      const raw: unknown = await this.client.fetchMarkPrice(market);
      if (raw === null || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const value = r["mark_price"] ?? r["markPrice"] ?? r["price"];
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) return null;
      throw error;
    }
  }

  book(market: string): Promise<OrderBook> {
    return this.client.fetchOrderBook(market);
  }

  cancelOnDisconnect(): Promise<CancelOnDisconnectStatus> {
    return this.client.getCancelOnDisconnect();
  }

  async openOrders(): Promise<unknown[]> {
    return (await this.client.getOpenOrders()) as unknown[];
  }

  async orderHistory(): Promise<unknown[]> {
    return (await this.client.getOrderHistory({ limit: 200 })) as unknown[];
  }

  async fills(): Promise<unknown[]> {
    return (await this.client.getFills({ limit: 200 })) as unknown[];
  }

  async positions(): Promise<unknown[]> {
    return (await this.client.getPositions()) as unknown[];
  }

  /** `POST /orders`, exactly once. */
  async place(order: BracketOrder): Promise<Submission> {
    try {
      return { kind: "accepted", response: await this.client.placeOrder(order) };
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        return { kind: "refused", status: error.status, detail: describe(error) };
      }
      // A local SDK rejection is thrown before a byte is sent, so it's a
      // definite "not placed". Only a transport failure or a 5xx leaves the
      // outcome open.
      if (error instanceof NexusExchangeError && !(error instanceof ApiError) && !(error instanceof TransportError)) {
        return { kind: "refused", status: 0, detail: describe(error) };
      }
      return { kind: "unknown", detail: describe(error) };
    }
  }

  /**
   * `DELETE /api/v1/orders/{id}?market_id=…`, signed with the SDK's own signer
   * (ENG-17118: the SDK's `cancelOrder` omits `market_id`).
   *
   * The signed path is the one the indexer verifies (`/api/v1/...`, without the
   * deployment's `/indexer` prefix), and the query is encoded once and used for
   * both the signature and the URL, as the SDK does internally. Retried on
   * transient failures: a cancel is idempotent, and a 404 means it's already
   * gone, which is the goal.
   */
  async cancel(orderId: string, market: string): Promise<void> {
    const { apiKey, apiSecret } = this.config;
    if (apiKey === undefined || apiSecret === undefined) throw new Error("cancel needs credentials");
    const path = `/api/v1/orders/${encodeURIComponent(orderId)}`;
    const query = new URLSearchParams({ market_id: market }).toString();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const headers = await signRequest(apiKey, apiSecret, "DELETE", path, query, new Uint8Array(0), Date.now());
        let response: Response;
        try {
          response = await fetch(`${this.client.baseUrl}${path}?${query}`, {
            method: "DELETE",
            headers: { ...headers, accept: "application/json", "x-nexus-api-version": API_VERSION },
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          throw new TransportError(`DELETE ${path}: ${describe(error)}`);
        }
        if (response.ok || response.status === 404) return;
        const body = (await response.text()).slice(0, 200);
        throw new ApiError(response.status, body);
      } catch (error) {
        if (attempt >= CANCEL_ATTEMPTS || !isTransient(error)) throw error;
        await this.sleep(250 * 2 ** attempt);
      }
    }
  }
}
