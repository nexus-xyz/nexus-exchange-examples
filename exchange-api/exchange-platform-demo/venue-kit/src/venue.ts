/*
 * The venue proxy — the branded API surface, in about a hundred lines.
 *
 * NOT THE ORDER PATH. A core venue is a static frontend and a config file: the
 * trader's browser holds a delegated key that can trade and cannot withdraw, so
 * it signs and calls the exchange itself, and no server of the venue's stands in
 * between. That removed the reason this module used to exist — holding an HMAC
 * secret on the venue's behalf — along with a whole class of liability, because a
 * venue holding per-trader trading secrets is a store of other people's
 * authority.
 *
 * WHAT IT IS FOR NOW. The Enterprise branded API: a partner serving
 * `api.acme.xyz` with its own key prefix to its own traders' bots. There the hop
 * is the product rather than a dependency, and the partner is deliberately
 * holding a credential of its own.
 *
 * It also stays the component that sees both the tenant identity and every
 * outbound order, which is where builder-code attribution is recorded for flow
 * that comes through it (`builder/ledger.ts`).
 *
 * ROUTES ARE ALLOWLISTED, NOT PASSED THROUGH. This proxy signs with a key that
 * can trade and move funds. A blind pass-through would hand any caller
 * `POST /withdrawals` and `POST /keys` under the venue's own credential. So the
 * set below is closed, and anything outside it is refused here — before a
 * signature exists, so a refused route never produces one.
 */

import { AttributionLedger, summarise, type BuilderSummary, type FillLike } from "./builder/ledger.ts";
import { signHeaders, type SigningKey } from "./sign.ts";
import type { TenantConfig } from "./tenant.ts";

/** Routes the browser may reach through the venue, as `METHOD /path` patterns. */
const ALLOWED: readonly { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/account(\/(summary|state|fees))?$/ },
  { method: "GET", pattern: /^\/positions$/ },
  { method: "GET", pattern: /^\/fills$/ },
  { method: "GET", pattern: /^\/orders(\/history)?$/ },
  { method: "POST", pattern: /^\/orders$/ },
  { method: "POST", pattern: /^\/orders\/preview$/ },
  { method: "PATCH", pattern: /^\/orders\/[\w-]+$/ },
  { method: "DELETE", pattern: /^\/orders(\/[\w-]+)?$/ },
  /* Testnet only. There is no faucet on mainnet, and a venue config that
     believes otherwise should fail on the 404, not here. */
  { method: "POST", pattern: /^\/faucet$/ },
];

export interface VenueRequest {
  readonly method: string;
  /** Path relative to the API base, e.g. `/orders`. */
  readonly path: string;
  readonly query?: string;
  readonly body?: string;
}

export interface VenueResponse {
  readonly status: number;
  readonly body: string;
}

export interface VenueProxyOptions {
  readonly tenant: TenantConfig;
  readonly key: SigningKey;
  /** Absolute API base the signed path is built from, e.g. `https://host/api/v1`. */
  readonly apiBase: string;
  readonly ledger?: AttributionLedger;
  /** Injected so tests are deterministic. */
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

export class VenueProxy {
  readonly tenant: TenantConfig;
  readonly ledger: AttributionLedger;
  #key: SigningKey;
  #apiBase: URL;
  #now: () => number;
  #fetch: typeof fetch;

  constructor(options: VenueProxyOptions) {
    this.tenant = options.tenant;
    this.ledger = options.ledger ?? new AttributionLedger();
    this.#key = options.key;
    this.#apiBase = new URL(options.apiBase);
    this.#now = options.now ?? (() => Date.now());
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Sign, forward, and — on a successful order — attribute. */
  async forward(request: VenueRequest): Promise<VenueResponse> {
    if (!isAllowed(request)) {
      return { status: 403, body: JSON.stringify({ error: "route not exposed by this venue" }) };
    }

    const signedPath = joinPath(this.#apiBase.pathname, request.path);
    const headers = signHeaders(this.#key, {
      method: request.method,
      path: signedPath,
      query: request.query,
      body: request.body,
      timestampMs: this.#now(),
    });

    const url = new URL(signedPath, this.#apiBase);
    if (request.query) url.search = request.query;

    const response = await this.#fetch(url, {
      method: request.method,
      headers: { ...headers, "content-type": "application/json" },
      body: request.body,
      /* Never follow a redirect on a signed request: `fetch` forwards custom
         headers across an origin change, which would hand a live signature to
         a host that is not the API. */
      redirect: "manual",
    });

    const body = await response.text();
    if (response.ok) this.#attribute(request, body);
    return { status: response.status, body };
  }

  /** The per-venue rollup. Estimates, and labelled as such by `summarise`. */
  async builderSummary(): Promise<BuilderSummary[]> {
    const response = await this.forward({ method: "GET", path: "/fills" });
    if (response.status !== 200) return [];
    const parsed: unknown = JSON.parse(response.body);
    const fills = Array.isArray(parsed) ? parsed : (parsed as { fills?: FillLike[] })?.fills;
    return summarise(this.ledger, fills ?? []);
  }

  /* Record what the response tells us. An order the exchange accepted comes
     back with the id every later fill will carry; an amend comes back with a
     new id that replaces the one in the path. */
  #attribute(request: VenueRequest, body: string): void {
    const orderId = extractOrderId(body);
    if (!orderId) return;

    if (request.method === "POST" && request.path === "/orders") {
      this.ledger.record({
        orderId,
        builderCode: this.tenant.builder.code,
        feeBps: this.tenant.builder.feeBps,
        marketId: extractMarketId(body) ?? "",
        submittedAtMs: this.#now(),
      });
      return;
    }

    if (request.method === "PATCH") {
      const previous = request.path.slice("/orders/".length);
      if (previous && previous !== orderId) this.ledger.recordAmend(previous, orderId);
    }
  }
}

function isAllowed(request: VenueRequest): boolean {
  const method = request.method.toUpperCase();
  return ALLOWED.some((route) => route.method === method && route.pattern.test(request.path));
}

/** Join the base prefix and the route into the path the server will verify. */
function joinPath(basePath: string, path: string): string {
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${prefix}${path}`;
}

/* The response envelope differs by route (`{order: {...}}` for a placement),
   so read defensively and attribute nothing rather than attribute wrongly. */
function extractOrderId(body: string): string | undefined {
  const parsed = safeParse(body);
  const order = parsed?.order ?? parsed;
  const id = (order as { id?: unknown })?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractMarketId(body: string): string | undefined {
  const parsed = safeParse(body);
  const order = parsed?.order ?? parsed;
  const marketId = (order as { market_id?: unknown })?.market_id;
  return typeof marketId === "string" ? marketId : undefined;
}

function safeParse(body: string): Record<string, any> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}
