/*
 * The tenant API, documented from the contract rather than from memory.
 *
 * Two surfaces, and conflating them is the mistake this file exists to prevent:
 *
 *   THE EXCHANGE API — `openapi.json` 0.8.1, 96 operations. What a venue's
 *   traders and bots call to trade. Nexus owns it; a venue re-brands it.
 *
 *   THE VENUE ADMIN API — this console's own surface. What a venue's *operators*
 *   call to run the venue. The venue owns it; Nexus never sees it.
 *
 * Everything below carries a `state`, and the states are not decoration. LIVE is
 * open to anyone holding a venue credential; GATED means the route answers but
 * wants a credential this venue has not been issued. A developer reading the page
 * needs to know which of the two before they write the integration, not after.
 */

export type CapabilityState = "live" | "gated";

export interface Capability {
  method: string;
  path: string;
  summary: string;
  state: CapabilityState;
  /** Why, when it is not simply live. */
  note?: string;
}

export interface CapabilityGroup {
  title: string;
  blurb: string;
  items: Capability[];
}

/** What a venue's traders and bots can do. Paths are the exchange contract. */
export const EXCHANGE_API: CapabilityGroup[] = [
  {
    title: "Market data",
    blurb: "Public. No credential, no rate tier — the same reads the branded UI paints from.",
    items: [
      { method: "GET", path: "/markets/summary", summary: "Every listed market with 24h volume and mark", state: "live" },
      { method: "GET", path: "/tickers", summary: "Top of book, last, high/low, per market", state: "live" },
      { method: "GET", path: "/markets/{id}/orderbook", summary: "Book depth to a requested level", state: "live" },
      { method: "GET", path: "/markets/{id}/trades", summary: "Public trade tape", state: "live" },
      { method: "GET", path: "/markets/{id}/candles", summary: "OHLCV, 1s to 1d", state: "live" },
      { method: "GET", path: "/markets/{id}/funding-samples", summary: "Funding rate history", state: "live" },
      { method: "GET", path: "/stats", summary: "Venue-wide statistics", state: "live" },
      { method: "GET", path: "/status", summary: "Aggregate service health", state: "live" },
    ],
  },
  {
    title: "Trading",
    blurb: "HMAC-signed. The venue proxy signs these; a browser never holds the secret.",
    items: [
      { method: "POST", path: "/orders", summary: "Place an order — 8 types, 4 time-in-force", state: "live" },
      { method: "POST", path: "/orders/batch", summary: "Submit many orders in one round trip", state: "live" },
      { method: "POST", path: "/orders/preview", summary: "Pre-trade cost and margin, venue-authoritative", state: "live", note: "No caller in the terminal yet — this is what replaces the client-side fee estimate." },
      { method: "PATCH", path: "/orders/{id}", summary: "Amend — cancel-replace, carries filled quantity", state: "live", note: "Returns a NEW order id. The attribution ledger follows the chain." },
      { method: "DELETE", path: "/orders/{id}", summary: "Cancel one", state: "live" },
      { method: "DELETE", path: "/orders", summary: "Cancel all — the venue kill switch", state: "live" },
      { method: "POST", path: "/account/cancel-on-disconnect", summary: "Dead-man switch for market makers", state: "live" },
    ],
  },
  {
    title: "Account",
    blurb: "Per-account reads behind the signing gate.",
    items: [
      { method: "GET", path: "/account/summary", summary: "Equity, margin, leverage", state: "live" },
      { method: "GET", path: "/positions", summary: "Open positions with unrealised PnL", state: "live" },
      { method: "GET", path: "/fills", summary: "Fill history — the attribution join reads this", state: "live" },
      { method: "GET", path: "/orders/history", summary: "Terminal orders with cancellation reasons", state: "live" },
      { method: "GET", path: "/account/fees", summary: "The account's fee tier", state: "live" },
      { method: "GET", path: "/account/rate-limit", summary: "Remaining request budget", state: "live" },
      { method: "GET", path: "/account/portfolio-history", summary: "Equity curve", state: "live" },
    ],
  },
  {
    title: "Funds",
    blurb: "Movement. Test money on testnet; real collateral on mainnet.",
    items: [
      { method: "POST", path: "/faucet", summary: "Claim test USDX", state: "live", note: "Testnet only. On mainnet, traders arrive through the funding rails instead." },
      { method: "POST", path: "/account/credit", summary: "Credit a test balance", state: "live", note: "Testnet only." },
      { method: "GET", path: "/deposits", summary: "Deposit history", state: "live" },
      { method: "GET", path: "/withdrawals", summary: "Withdrawal history", state: "live" },
      { method: "POST", path: "/account/adjust-margin", summary: "Move margin between isolated positions", state: "live" },
    ],
  },
  {
    title: "Funding",
    /* Bundled into the Nexus API, so a venue inherits it rather than integrating
       it. Listed as its own group because the operator question — "what can my
       traders arrive with" — is not the same question as "how do I move margin",
       and burying it under Funds would answer neither. */
    blurb: "Onramp and cross-chain routing, in front of the bridge. Every venue inherits it; none integrates it.",
    items: [
      { method: "—", path: "destination_address", summary: "A per-account address the payment terminates at", state: "live", note: "One address per account, derived by Nexus and passed on every payment. It is stable, so it doubles as an on-chain attribution key for funding flow." },
      { method: "POST", path: "/funding/quote", summary: "Price a deposit from any origin rail", state: "live", note: "Onramp direction. A quote is firm for 60 seconds; re-quote after that or the payment is rejected." },
      { method: "POST", path: "/funding/payments", summary: "Start a deposit, terminating in an ERC-20 transfer", state: "live", note: "Providers settle in USDC. Inbound USDC is credited 1:1 as USDX at the destination address." },
      { method: "GET", path: "/funding/payments", summary: "Deposit status and history", state: "live", note: "Status refreshes on a 60s cycle rather than streaming — poll it; a socket tape will read stale." },
    ],
  },
  {
    title: "Authentication",
    blurb: "Wallet signature in, HMAC key out. Keys are network-scoped; signatures are not.",
    items: [
      { method: "POST", path: "/auth/login", summary: "EIP-191 personal_sign → 24h session token", state: "live" },
      { method: "POST", path: "/keys", summary: "Mint an HMAC key — the secret is shown once", state: "live", note: "Operator step. Deliberately off the venue proxy's allowlist." },
      { method: "GET", path: "/keys", summary: "List keys for the account", state: "live" },
    ],
  },
  {
    title: "Streaming",
    blurb: "Push instead of poll.",
    items: [
      { method: "WS", path: "/ws", summary: "Book, trades, and account channels", state: "live" },
      { method: "POST", path: "/ws-tokens", summary: "Short-lived token for an authenticated socket", state: "live" },
    ],
  },
  {
    title: "Builder codes",
    blurb: "How routed flow is attributed back to the venue that sent it.",
    items: [
      { method: "—", path: "OrderRequest.builder_code", summary: "Tag an order with the venue that routed it", state: "live", note: "Stamped by the venue proxy on every signed order, so a trader's own client never has to carry it." },
      { method: "—", path: "Fill.builder_code", summary: "Attribute a fill to a builder", state: "live", note: "Carried through from the order. This is the join key behind per-builder analytics and fee crediting." },
      { method: "GET", path: "/builder/{code}/summary", summary: "Authoritative routed volume and fees earned", state: "live", note: "The venue-side counterpart to this console's analytics — same figures, scriptable." },
    ],
  },
];

/** What a venue's own operators and systems can call. This console's API. */
export const VENUE_ADMIN_API: CapabilityGroup[] = [
  {
    title: "Analytics",
    blurb: "Everything the console renders, as JSON. Bearer-authenticated with a venue key.",
    items: [
      { method: "GET", path: "/api/admin/summary", summary: "Venue health, usage, revenue, market table", state: "live" },
      { method: "GET", path: "/api/admin/funding", summary: "Deposit rails, funnel, and per-account addresses", state: "live", note: "Rail figures refresh on a 60s cycle, so two calls inside a minute return the same numbers." },
      { method: "GET", path: "/api/admin/flow", summary: "Attributed orders and fills", state: "live" },
      { method: "GET", path: "/api/admin/export.csv", summary: "The same figures, provenance labels intact", state: "live", note: "The console exports the same CSV client-side, provenance header included. This endpoint is the scriptable version." },
    ],
  },
  {
    title: "Control",
    blurb: "The actions an operator takes when something is wrong.",
    items: [
      { method: "POST", path: "/api/admin/actions", summary: "halt · resume · cancel-all · faucet · key.create · key.revoke", state: "live", note: "The console's operational controls call exactly this — nothing on those panels can do something this endpoint cannot." },
      { method: "POST", path: "/api/admin/halt", summary: "Stop routing (separately from cancelling)", state: "live", note: "An Edge Config flag, so it takes effect without a redeploy. Halting and cancelling stay separate operations — most incidents want one and not the other." },
      { method: "POST", path: "/api/admin/faucet", summary: "Fund the venue's test account", state: "live", note: "Testnet only — the route is absent on mainnet rather than disabled." },
      { method: "PUT", path: "/api/admin/config", summary: "Apply a nexus.json", state: "live", note: "Config-as-code: the console edits the file, the file is the source of truth." },
    ],
  },
  {
    title: "Access",
    blurb: "Who can do the above.",
    items: [
      { method: "GET", path: "/api/admin/members", summary: "Team and roles", state: "live" },
      { method: "POST", path: "/api/admin/invites", summary: "Invite a teammate at a role", state: "live", note: "Owner-only. An invite expires 72 hours after it is sent." },
      { method: "POST", path: "/api/admin/keys", summary: "Mint a scoped venue key", state: "live", note: "The secret is returned once, in the mint response, and is never readable again — a property the endpoint holds, not just the UI." },
      { method: "GET", path: "/api/admin/audit", summary: "Who changed what, when", state: "live" },
    ],
  },
];

export const STATE_LABEL: Record<CapabilityState, { label: string; hint: string }> = {
  live: { label: "LIVE", hint: "in the contract and answering today" },
  gated: { label: "GATED", hint: "answers, but wants a credential this venue has not been issued" },
};

export function countByState(groups: CapabilityGroup[]): Record<CapabilityState, number> {
  const counts: Record<CapabilityState, number> = { live: 0, gated: 0 };
  for (const group of groups) for (const item of group.items) counts[item.state] += 1;
  return counts;
}
