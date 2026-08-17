/*
 * Product analytics for the two things a venue actually ships: its branded UI
 * and its branded API.
 *
 * These are the figures the venue can compute *without* the exchange's help,
 * because they are measured at the venue's own edge — its pages and its proxy.
 * That is worth stating plainly: an operator who only had exchange data could
 * never see their own funnel, their own p99, or which SDK version their traders
 * are pinned to. The proxy hop that exists for key custody turns out to be the
 * observability point too.
 *
 * Deterministic and seeded off the same clock as the attribution ledger, so the
 * two agree about which day is today.
 */

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EndpointStat {
  method: string;
  path: string;
  requests24h: number;
  p50Ms: number;
  p99Ms: number;
  errorRate: number;
  /** 14-day request trend, for the row sparkline. */
  trend: number[];
}

export interface FunnelStep {
  label: string;
  users: number;
}

export interface UiAnalytics {
  sessions7d: number;
  medianSessionS: number;
  funnel: FunnelStep[];
  /** UI vs API share of submitted orders — the build-what-next number. */
  uiOrders: number;
  apiOrders: number;
  devices: { label: string; share: number }[];
  /** market × day-of-week order counts, for the heatmap. */
  activity: { markets: string[]; days: string[]; value: (m: number, d: number) => number };
  cohorts: { label: string; size: number; retention: number[] }[];
}

export interface ApiAnalytics {
  requests24h: number;
  errorRate: number;
  p50Ms: number;
  p99Ms: number;
  rateLimitHeadroom: number;
  endpoints: EndpointStat[];
  sdks: { label: string; share: number }[];
  latencyBins: { label: string; value: number }[];
  /** The p99 bucket, so the histogram can mark it rather than make you count. */
  p99BinIndex: number;
  errorCodes: { code: string; count: number; meaning: string }[];
}

const ENDPOINTS: [string, string, number, number, number, number][] = [
  // method, path, base rps weight, p50, p99, error rate
  ["GET", "/markets/summary", 42_000, 41, 180, 0.0004],
  ["GET", "/tickers", 31_500, 38, 165, 0.0003],
  ["POST", "/orders", 18_900, 62, 240, 0.0121],
  ["GET", "/positions", 14_200, 55, 210, 0.0009],
  ["GET", "/fills", 11_800, 58, 232, 0.0007],
  ["DELETE", "/orders/{id}", 9_400, 49, 198, 0.0038],
  ["GET", "/account/summary", 8_100, 53, 205, 0.0006],
  ["PATCH", "/orders/{id}", 5_600, 66, 268, 0.0094],
  ["GET", "/markets/{id}/candles", 4_300, 71, 320, 0.0011],
  ["POST", "/orders/batch", 1_900, 88, 410, 0.0052],
];

export function apiAnalytics(): ApiAnalytics {
  const random = prng(0xa71);
  const endpoints: EndpointStat[] = ENDPOINTS.map(([method, path, base, p50, p99, err]) => ({
    method,
    path,
    requests24h: base,
    p50Ms: p50,
    p99Ms: p99,
    errorRate: err,
    trend: Array.from({ length: 14 }, (_, i) => base * (0.72 + random() * 0.5 + i * 0.012)),
  }));

  const requests24h = endpoints.reduce((s, e) => s + e.requests24h, 0);
  const errors = endpoints.reduce((s, e) => s + e.requests24h * e.errorRate, 0);

  /* A long right tail is the shape latency actually has; a symmetric one would
     be a lie that happens to look tidier. */
  const latencyBins = Array.from({ length: 22 }, (_, i) => {
    const centre = 5;
    const x = i - centre;
    const value = Math.round(1000 * Math.exp(-Math.pow(x, 2) / (x > 0 ? 90 : 12)) + random() * 40);
    return { label: `${20 + i * 20}ms`, value: Math.max(4, value) };
  });

  return {
    requests24h,
    errorRate: errors / requests24h,
    p50Ms: 48,
    p99Ms: 243,
    rateLimitHeadroom: 0.63,
    endpoints,
    sdks: [
      { label: "exchange-ts 0.2.0", share: 0.58 },
      { label: "exchange-rs 0.4.1", share: 0.21 },
      { label: "exchange-py 0.1.7", share: 0.11 },
      { label: "raw HTTP", share: 0.1 },
    ],
    latencyBins,
    p99BinIndex: 12,
    errorCodes: [
      { code: "MIN_NOTIONAL", count: 812, meaning: "order below the market minimum" },
      { code: "INSUFFICIENT_MARGIN", count: 604, meaning: "account cannot support the position" },
      { code: "POST_ONLY_WOULD_CROSS", count: 431, meaning: "PostOnly order would have taken liquidity" },
      { code: "RATE_LIMITED", count: 168, meaning: "429 — the key's budget was exhausted" },
      { code: "RESTRICTED_JURISDICTION", count: 24, meaning: "geo control — permanent, never retry" },
    ],
  };
}

/**
 * The same API view, narrowed to a window.
 *
 * A range selector that does not change the numbers is furniture. The 24h figures
 * above are the base; a longer window scales the counts and *widens the tail*,
 * because a 30-day p99 includes deploy days and a 24-hour one usually does not.
 * That relationship is the reason an operator asks for the range at all.
 */
export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30 };

export function isRange(value: string | undefined): value is Range {
  return RANGES.includes((value ?? "") as Range);
}

export function apiAnalyticsFor(range: Range): ApiAnalytics {
  const base = apiAnalytics();
  const days = RANGE_DAYS[range];
  if (days === 1) return base;

  /* Tail widening is sub-linear in the window — p99 grows with the log of the
     number of samples for anything close to a heavy tail, and a linear bump would
     put a 30-day p99 at four seconds, which nobody would believe. */
  const tail = 1 + 0.14 * Math.log2(days);
  const scale = days;

  return {
    ...base,
    requests24h: Math.round(base.requests24h * scale),
    p50Ms: Math.round(base.p50Ms * (1 + 0.03 * Math.log2(days))),
    p99Ms: Math.round(base.p99Ms * tail),
    /* A longer window catches more incident minutes, so the blended error rate
       rises even when the steady state has not moved. */
    errorRate: base.errorRate * (1 + 0.09 * Math.log2(days)),
    endpoints: base.endpoints.map((e) => ({
      ...e,
      requests24h: Math.round(e.requests24h * scale),
      p99Ms: Math.round(e.p99Ms * tail),
    })),
    errorCodes: base.errorCodes.map((c) => ({ ...c, count: Math.round(c.count * scale) })),
    p99BinIndex: Math.min(base.latencyBins.length - 1, base.p99BinIndex + (days === 7 ? 2 : 4)),
  };
}

export function uiAnalytics(): UiAnalytics {
  const random = prng(0x5115);
  const markets = ["BTC", "ETH", "SOL", "XAU", "EUR"];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  /* Precomputed so the heatmap is stable across renders — a chart that changes
     when you scroll past it is not a measurement. */
  const grid = markets.map((_, m) =>
    days.map((_, d) => {
      const weekday = d < 5 ? 1 : 0.42;
      const depth = [1, 0.86, 0.51, 0.28, 0.19][m] ?? 0.2;
      return Math.round(900 * weekday * depth * (0.75 + random() * 0.5));
    }),
  );

  return {
    sessions7d: 5_842,
    medianSessionS: 447,
    funnel: [
      { label: "Visited", users: 5_842 },
      { label: "Connected wallet", users: 2_190 },
      { label: "Funded", users: 1_006 },
      { label: "Placed first order", users: 634 },
      { label: "Returned within 7d", users: 412 },
    ],
    uiOrders: 38_400,
    apiOrders: 61_600,
    devices: [
      { label: "Desktop", share: 0.71 },
      { label: "Mobile", share: 0.24 },
      { label: "Tablet", share: 0.05 },
    ],
    activity: { markets, days, value: (m, d) => grid[m]?.[d] ?? 0 },
    cohorts: [
      { label: "Jul 07", size: 184, retention: [1, 0.62, 0.48, 0.41, 0.38, 0.36] },
      { label: "Jul 14", size: 221, retention: [1, 0.66, 0.52, 0.44, 0.4] },
      { label: "Jul 21", size: 259, retention: [1, 0.69, 0.55, 0.47] },
      { label: "Jul 28", size: 302, retention: [1, 0.71, 0.58] },
      { label: "Aug 04", size: 344, retention: [1, 0.74] },
    ],
  };
}

// ── funding: how a trader gets money onto the venue ──────────────────────────
/*
 * Everything below describes the Halliday funding integration as the venue runs
 * it. Three facts drive the model and each is visible on the page:
 *
 *   1. Phase one is ONRAMP ONLY. There is no withdrawal series here — an empty
 *      column would imply we measured zero withdrawals rather than that the venue
 *      does not route withdrawals through these rails.
 *   2. Inbound USDC is credited 1:1 as USDX, and the credit is a distinct step
 *      from the transfer. So "credited" is a funnel step that can stall, and it is
 *      drawn as one.
 *   3. Halliday's analytics are REST polling of two dashboard endpoints, not a
 *      stream. A poll interval is a property of the data, so the page shows it
 *      rather than implying a live tape.
 *
 * The per-account deposit address is the genuinely interesting part. Nexus
 * derives one address per account and passes it per payment as
 * `destination_address`; the address therefore identifies the account on-chain
 * before a single order is signed, which makes it the attribution key for funding
 * flow the way the builder code is the attribution key for order flow.
 */

export type FundingRailKind = "card" | "bank" | "chain" | "cex";

export interface FundingRail {
  kind: FundingRailKind;
  label: string;
  detail: string;
}

export const FUNDING_RAILS: FundingRail[] = [
  {
    kind: "card",
    label: "Card",
    detail: "Debit and credit through Halliday's fiat onramp providers.",
  },
  {
    kind: "bank",
    label: "Bank transfer",
    detail: "ACH, SEPA and local rails, provider-dependent.",
  },
  {
    kind: "chain",
    label: "Any token, any chain",
    detail: "Halliday absorbs the swap and the bridge; it terminates as a plain ERC-20 transfer.",
  },
  {
    kind: "cex",
    label: "Exchange withdrawal",
    detail: "A trader withdraws from a CEX straight to their per-account address.",
  },
];

/**
 * The terminus, which is one thing however many origins feed it.
 *
 * ORIGIN AND TERMINUS ARE DIFFERENT FACTS and the console shows them as two
 * layers rather than one list. A trader's money starts on a card, a bank rail, a
 * CEX withdrawal, or some token on some chain; Halliday absorbs the fiat leg, the
 * cross-chain routing and the swap; and *all* of it lands the same way — a plain
 * ERC-20 transfer on Ethereum into the per-account address Nexus derives, which
 * the native bridge picks up and credits to the trader's venue account.
 *
 * Collapsing the two into "supported chains" would misdescribe how the money
 * moves. The reach is a property of the FUNDING RAILS, not of anything about the
 * settlement chain — and the venue operator integrates none of it.
 */
export const FUNDING_TERMINUS = {
  transfer: "a plain ERC-20 transfer on Ethereum",
  destination: "a per-account address Nexus derives, passed per payment as destination_address",
  pickup: "the native Nexus bridge credits it to the trader's venue account",
  /* USDX is the canonical dollar across Nexus venues. The trader should never
     have to think about it: they arrive with USDC, USDT, a card or a CEX
     withdrawal, and they end up trading. */
  asset: "USDX",
} as const;

export const RAIL_LABEL: Record<FundingRailKind, string> = {
  card: "Card",
  bank: "Bank",
  chain: "Chain",
  cex: "CEX",
};

export interface FundingAnalytics {
  /** Polled, not streamed — see the note above. */
  pollIntervalS: number;
  polledEndpoints: string[];
  depositsStarted: number;
  depositsSettled: number;
  grossDeposited: number;
  medianFirstDeposit: number;
  medianSettleS: number;
  /** Started → first trade. The only funding number a venue operator ranks on. */
  conversionToFirstTrade: number;
  medianStartToFirstTradeS: number;
  bySource: { kind: FundingRailKind; label: string; value: number; count: number }[];
  daily: { dayMs: number; byKind: Record<FundingRailKind, number> }[];
  funnel: FunnelStep[];
  /** Per-account deposit addresses — the attribution surface. */
  addresses: {
    account: string;
    address: string;
    firstSource: FundingRailKind;
    firstFundedMs: number;
    deposits: number;
    deposited: number;
    routedNotional: number;
  }[];
  failures: { code: string; count: number; meaning: string }[];
  /**
   * The METHODS a depositor actually picks, which is not the same list as the rails
   * that settle them. The trader chooses "Apple Pay"; the rail is `card`. An operator
   * looking at a four-row rail table cannot tell whether their card volume is people
   * typing a PAN or people using a wallet — and those have different support costs,
   * different fraud profiles and different conversion.
   */
  methods: { id: string; label: string; kind: FundingRailKind; gross: number; count: number }[];
  /**
   * Time from start to credited, per rail. A median alone hides the shape that
   * matters: a rail whose p90 is four times its median has a tail somebody has to
   * answer support tickets about.
   */
  settle: { kind: FundingRailKind; medianS: number; p90S: number }[];
  /** Deposit count by hour of UTC day and rail — where the support load lands. */
  hourly: { hour: number; byKind: Record<FundingRailKind, number> }[];
  /** Ticket-size distribution across every rail, log-spaced. */
  ticketBins: { label: string; value: number; upperUsd: number }[];
}

/**
 * The methods, and which rail each settles on.
 *
 * The share numbers are a split WITHIN a rail, so they sum to 1 per rail and the
 * method totals reconcile to the rail totals by construction. That is the property
 * that matters: two tables on one screen that do not add up to each other is the
 * defect an operator finds first.
 */
const METHOD_SPLIT: { id: string; label: string; kind: FundingRailKind; share: number; ticketUsd: number }[] = [
  { id: "stable", label: "Stablecoins", kind: "chain", share: 0.68, ticketUsd: 2_400 },
  { id: "crypto", label: "Transfer crypto", kind: "chain", share: 0.32, ticketUsd: 1_100 },
  { id: "cex", label: "From an exchange", kind: "cex", share: 1, ticketUsd: 1_900 },
  { id: "card", label: "Debit or credit card", kind: "card", share: 0.61, ticketUsd: 210 },
  { id: "wallet", label: "Apple Pay & Google Pay", kind: "card", share: 0.39, ticketUsd: 290 },
  { id: "bank", label: "Bank transfer", kind: "bank", share: 0.74, ticketUsd: 2_800 },
  { id: "wire", label: "Wire", kind: "bank", share: 0.26, ticketUsd: 21_000 },
];

/**
 * Settle times, per rail, in seconds.
 *
 * These are the SAME numbers the deposit screen quotes a trader — instant for chain,
 * about two minutes off an exchange, about a minute for a card, one to two days for a
 * bank. A console that told the operator something different from what their own
 * product tells their users would be the worst kind of dashboard.
 */
const SETTLE: Record<FundingRailKind, { medianS: number; p90S: number }> = {
  chain: { medianS: 42, p90S: 260 },
  cex: { medianS: 128, p90S: 720 },
  card: { medianS: 71, p90S: 340 },
  bank: { medianS: 118_800, p90S: 306_000 },
};

const RAIL_MIX: Record<FundingRailKind, number> = { card: 0.31, bank: 0.18, chain: 0.36, cex: 0.15 };

export function fundingAnalytics(days = 30): FundingAnalytics {
  const random = prng(0xf00d);
  const dayMsSize = 86_400_000;
  const today = 1_786_600_000_000;

  const daily = Array.from({ length: days }, (_, d) => {
    /* Same growth-plus-weekday rhythm as the flow ledger. Funding follows trading
       activity, so a series that did not share its shape would be the tell. */
    const trend = 1 + 0.04 * d;
    const dayMs = today - (days - 1 - d) * dayMsSize;
    const weekday = new Date(dayMs).getUTCDay();
    const rhythm = weekday === 0 || weekday === 6 ? 0.62 : 1;
    const base = 14_000 * trend * rhythm * (0.8 + random() * 0.4);
    const byKind = {} as Record<FundingRailKind, number>;
    for (const kind of Object.keys(RAIL_MIX) as FundingRailKind[]) {
      byKind[kind] = base * RAIL_MIX[kind] * (0.75 + random() * 0.5);
    }
    return { dayMs, byKind };
  });

  const bySource = (Object.keys(RAIL_MIX) as FundingRailKind[]).map((kind) => {
    const value = daily.reduce((s, d) => s + d.byKind[kind], 0);
    return {
      kind,
      label: RAIL_LABEL[kind],
      value,
      /* Card tickets are small and chain tickets are large; one count over one
         gross would hide that, and ticket size is what decides which rail is
         worth the integration. */
      count: Math.round(value / (kind === "card" ? 240 : kind === "bank" ? 3_400 : 1_900)),
    };
  });

  const grossDeposited = bySource.reduce((s, r) => s + r.value, 0);
  const depositsStarted = 3_180;
  const providerApproved = 2_612;
  const settled = 2_486;
  const credited = 2_401;
  const firstTrade = 1_642;

  const addresses = [
    ["0x8f2a…41c7", "chain", 1_786_120_000_000, 9, 184_200, 2_940_000],
    ["0x1b04…9de2", "cex", 1_786_268_000_000, 4, 61_500, 1_120_000],
    ["0xc733…07aa", "card", 1_786_390_000_000, 21, 12_840, 388_000],
    ["0x5e91…b310", "bank", 1_786_440_000_000, 2, 45_000, 902_000],
    ["0xa26d…5f48", "chain", 1_786_512_000_000, 6, 28_700, 214_000],
    ["0x77c1…e0b9", "card", 1_786_566_000_000, 3, 1_450, 0],
  ] as const;

  /*
   * Methods, derived FROM the rail totals rather than generated beside them.
   *
   * Gross splits a rail's own total, so the method table sums to the rail table
   * exactly. Counts then come from each method's ticket size — which is a property of
   * the METHOD and not of the rail, and is the reason this table exists at all — and
   * are scaled so they sum to the number of deposits the funnel says settled.
   *
   * Both of those are reconciliation an operator will actually do: the first time
   * someone adds a column up and finds it does not match the panel above it, every
   * other number on the screen becomes a maybe. The rail counts are then recomputed
   * as the sum of their methods rather than divided out of gross separately, because
   * two independent derivations of the same quantity is exactly how that drift starts.
   */
  const rawCounts = METHOD_SPLIT.map((m) => {
    const railGross = bySource.find((r) => r.kind === m.kind)?.value ?? 0;
    return (railGross * m.share) / m.ticketUsd;
  });
  const countScale = settled / Math.max(1, rawCounts.reduce((a, b) => a + b, 0));
  const methods = METHOD_SPLIT.map((m, i) => {
    const railGross = bySource.find((r) => r.kind === m.kind)?.value ?? 0;
    return {
      id: m.id,
      label: m.label,
      kind: m.kind,
      gross: railGross * m.share,
      count: Math.max(1, Math.round(rawCounts[i]! * countScale)),
    };
  });

  /* The rail count is now the sum of its methods, not a second division of gross. */
  for (const rail of bySource) {
    rail.count = methods.filter((m) => m.kind === rail.kind).reduce((sum, m) => sum + m.count, 0);
  }

  const settle = (Object.keys(SETTLE) as FundingRailKind[]).map((kind) => ({ kind, ...SETTLE[kind] }));

  /*
   * Hour of UTC day. The shape is deliberate rather than noise: card and wallet
   * deposits follow waking hours in the Americas and Europe, and chain deposits do
   * not follow anything, because a bot does not sleep. An operator staffing support
   * needs the first fact and needs to not be misled by the second.
   */
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const byKind = {} as Record<FundingRailKind, number>;
    /* Two humps — Europe afternoon and US afternoon — on the fiat rails. */
    const human =
      0.35 +
      0.65 * Math.exp(-Math.pow((hour - 14) / 3.4, 2)) +
      0.55 * Math.exp(-Math.pow((hour - 20) / 3.8, 2));
    for (const kind of Object.keys(RAIL_MIX) as FundingRailKind[]) {
      const humanness = kind === "card" ? 1 : kind === "bank" ? 0.9 : kind === "cex" ? 0.45 : 0.15;
      const shape = 1 - humanness + humanness * human;
      byKind[kind] = Math.round(
        (bySource.find((r) => r.kind === kind)?.value ?? 0) / (kind === "card" ? 240 : kind === "bank" ? 3_400 : 1_900) / 24 * shape * (0.85 + random() * 0.3),
      );
    }
    return { hour, byKind };
  });

  /*
   * Ticket size, log-spaced, because deposits are log-distributed and eight linear
   * bins would put ninety per cent of the mass in the first one. The bins are shared
   * across rails on purpose — the whole point is that a card deposit and a wire are
   * three orders of magnitude apart and a single axis is what shows that.
   */
  const TICKET_EDGES = [50, 150, 400, 1_000, 2_500, 6_000, 15_000, 40_000, 100_000];
  const ticketBins = TICKET_EDGES.map((upperUsd, i) => {
    const lower = i === 0 ? 0 : TICKET_EDGES[i - 1]!;
    /* Each method contributes a lognormal-ish bump around its own ticket size. */
    const value = METHOD_SPLIT.reduce((sum, m) => {
      const method = methods.find((x) => x.id === m.id);
      if (!method) return sum;
      const mid = Math.sqrt(Math.max(1, lower) * upperUsd);
      const z = Math.log(mid / m.ticketUsd) / 0.85;
      return sum + method.count * Math.exp(-0.5 * z * z);
    }, 0);
    return {
      label: upperUsd >= 1_000 ? `${upperUsd / 1_000}k` : `$${upperUsd}`,
      value: Math.round(value),
      upperUsd,
    };
  });

  return {
    pollIntervalS: 60,
    polledEndpoints: ["GET /dashboard/payments", "GET /dashboard/volume"],
    depositsStarted,
    depositsSettled: settled,
    grossDeposited,
    medianFirstDeposit: 310,
    medianSettleS: 214,
    conversionToFirstTrade: firstTrade / depositsStarted,
    medianStartToFirstTradeS: 1_140,
    bySource,
    daily,
    methods,
    settle,
    hourly,
    ticketBins,
    funnel: [
      { label: "Deposit started", users: depositsStarted },
      { label: "Provider approved", users: providerApproved },
      { label: "Settled to address", users: settled },
      { label: "Credited as USDX", users: credited },
      { label: "Placed first order", users: firstTrade },
    ],
    addresses: addresses.map(([account, firstSource, firstFundedMs, deposits, deposited, routedNotional]) => ({
      account,
      /* One address per account, derived by Nexus and passed per payment as
         `destination_address` — so it is stable, and stability is what makes it
         usable as an attribution key. */
      address: account,
      firstSource: firstSource as FundingRailKind,
      firstFundedMs,
      deposits,
      deposited,
      routedNotional,
    })),
    failures: [
      { code: "PROVIDER_DECLINED", count: 412, meaning: "the card issuer or bank refused — retryable by the trader" },
      { code: "KYC_REQUIRED", count: 118, meaning: "provider needs identity before it will settle" },
      { code: "ROUTE_UNAVAILABLE", count: 47, meaning: "no path from that token and chain at that size" },
      { code: "BELOW_MINIMUM", count: 96, meaning: "under the provider's floor — the gas would exceed the deposit" },
      { code: "UNSUPPORTED_REGION", count: 21, meaning: "geo control — permanent for that trader, never retry" },
    ],
  };
}

// ── per-market drill-down ────────────────────────────────────────────────────
/*
 * Aggregates hide the decision. "Rejection rate 1.2%" is not actionable; "GOLD
 * rejects 6% of orders, all MIN_NOTIONAL, and earns $40 a month" is — it says
 * drop the listing. So every market row opens to its own unit economics, and the
 * rejection taxonomy is per market rather than venue-wide.
 */

export interface MarketDetail {
  marketId: string;
  routedNotional: number;
  fills: number;
  traders: number;
  avgFillSize: number;
  makerShare: number;
  rejectionRate: number;
  feeAccrued: number;
  effectiveBps: number;
  /** Routed notional per day over the window, for the trend. */
  daily: { dayMs: number; notional: number }[];
  rejections: { code: string; count: number; meaning: string }[];
}

/** A stable per-market seed, so a market's page is the same on every load. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function marketDetail(marketId: string, feeBps: number, days = 30): MarketDetail {
  const random = prng(seedOf(marketId));
  const dayMsSize = 86_400_000;
  const today = 1_786_600_000_000;
  /* Depth follows the pair, not the venue: BTC carries the flow, the long tail
     carries the rejection rate. */
  const weight = marketId.startsWith("BTC") ? 1 : marketId.startsWith("ETH") ? 0.6 : marketId.startsWith("SOL") ? 0.33 : 0.08;

  const daily = Array.from({ length: days }, (_, d) => {
    const dayMs = today - (days - 1 - d) * dayMsSize;
    const weekday = new Date(dayMs).getUTCDay();
    const rhythm = weekday === 0 || weekday === 6 ? 0.58 : 1;
    return { dayMs, notional: 420_000 * weight * (1 + 0.03 * d) * rhythm * (0.8 + random() * 0.4) };
  });

  const routedNotional = daily.reduce((s, p) => s + p.notional, 0);
  const fills = Math.round(routedNotional / (2_800 + random() * 900));
  const feeAccrued = routedNotional * (feeBps / 10_000);
  /* Thin markets reject more, and they reject for a different reason — the
     minimum notional bites when the tick is large relative to the ticket. */
  const thin = weight < 0.3;
  const rejectionRate = thin ? 0.041 + random() * 0.02 : 0.008 + random() * 0.006;
  const rejected = Math.round(fills * rejectionRate * 4);

  return {
    marketId,
    routedNotional,
    fills,
    traders: Math.max(3, Math.round(fills / (18 + random() * 12))),
    avgFillSize: routedNotional / Math.max(1, fills),
    makerShare: thin ? 0.22 + random() * 0.1 : 0.44 + random() * 0.12,
    rejectionRate,
    feeAccrued,
    effectiveBps: routedNotional > 0 ? (feeAccrued / routedNotional) * 10_000 : 0,
    daily,
    rejections: [
      { code: "MIN_NOTIONAL", count: Math.round(rejected * (thin ? 0.54 : 0.28)), meaning: "order below the market minimum" },
      { code: "INSUFFICIENT_MARGIN", count: Math.round(rejected * 0.24), meaning: "account cannot support the position" },
      { code: "POST_ONLY_WOULD_CROSS", count: Math.round(rejected * (thin ? 0.09 : 0.31)), meaning: "PostOnly would have taken liquidity" },
      { code: "RATE_LIMITED", count: Math.round(rejected * 0.09), meaning: "429 — the key's budget was exhausted" },
      { code: "RESTRICTED_JURISDICTION", count: Math.round(rejected * 0.03), meaning: "geo control — permanent, never retry" },
    ].filter((r) => r.count > 0),
  };
}
