/*
 * The venue's attribution ledger, for the dashboards to read.
 *
 * The ledger is the join between orders this venue routed through the signing
 * proxy and the fills the exchange returned for them. Every figure a dashboard
 * shows about the venue's own flow resolves back to a row in here.
 *
 * A fee that has accrued but not settled is still an estimate, and it carries
 * that label all the way to the screen. The rule this project lives by is that
 * estimates are marked as estimates; a projection that renders like a settled
 * figure is the one failure mode a venue dashboard cannot have.
 *
 * The series is seeded off the ledger clock, so two loads of the dashboard agree
 * — the same discipline as the terminal's `(symbol, tick)` feed, and for the same
 * reason: a screenshot has to be reproducible.
 *
 * THE PLATFORM CONSOLE MADE THIS FILE A ROSTER, NOT JUST A LEDGER. A venue console
 * only ever needs one venue's flow. The platform console asks lifecycle questions —
 * how many signed up last week, how many of those ever routed an order, which ones
 * stopped — and none of those can be answered by a flow series alone. So the roster
 * below carries each venue's dates and operational state, and the flow generator
 * reads them: a venue that has not activated produces no fills, and a venue that
 * churned stops producing them on the day it churned. The alternative — asserting
 * "churned" in a table while the chart keeps drawing its flow — is the kind of
 * incoherence that teaches an operator to distrust the whole surface.
 */

import { AttributionLedger, type FillLike } from "@nexus-eaas/venue-kit";

/** Mulberry32 — small, fast, and identical across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/**
 * The clock every series on this console shares.
 *
 * Fixed, not `Date.now()`. Two panels that each read the wall clock disagree about
 * which day is "today" the moment a render straddles midnight, and a cohort table
 * that drifts against the flow chart beside it is worse than one that is frankly
 * frozen. It is also what keeps a screenshot reproducible.
 */
export const NOW_MS = 1_786_600_000_000;

/** Where a venue is in its life on the platform. */
export type VenueStatus = "live" | "onboarding" | "dormant" | "churned";

/** The venues on the platform. One per builder code. */
export interface DemoVenue {
  code: string;
  name: string;
  feeBps: number;
  /** Distinct wallets that traded through this venue. */
  traders: number;
  /**
   * Unix ms the venue first routed an order.
   *
   * Retained under its original name because it is part of an exported row shape.
   * It now reads `firstOrderMs ?? signedUpMs` — for a venue that never activated
   * there is no "live since", and the signup date is the only honest stand-in.
   * New code should read `firstOrderMs`, which says null when it means null.
   */
  liveSinceMs: number;
  /** Unix ms the venue's account was created — the top of the funnel. */
  signedUpMs: number;
  /** Unix ms of the first routed order. Null means signed up and never activated. */
  firstOrderMs: number | null;
  /** Unix ms of the last routed order, for a venue that stopped. Null while active. */
  lastOrderMs: number | null;
  status: VenueStatus;
  /** Seats on the venue's console — the size of the team operating it. */
  teamSeats: number;
  /** Markets the venue exposes to its traders. A subset of what the book offers. */
  markets: string[];
  /** Share of the venue's submitted orders that arrived over its API, not its UI. */
  apiOrderShare: number;
  /** Rejected ÷ submitted over 30 days, and over the last 7 — a rising pair is a signal. */
  rejectRate30d: number;
  rejectRate7d: number;
  /** Unix ms the venue's API key was last rotated. Null means never since issue. */
  keyRotatedMs: number | null;
  /**
   * How much of this venue's funding is expected to arrive as fiat rather than as
   * an on-chain transfer. Drives the deposit origin mix — see `buildDepositDays`.
   * A modelling input, not an observation: no venue has funded through Halliday yet.
   */
  fiatLean: number;
  /** Every builder-fee change, oldest first. The first entry is the venue's launch rate. */
  feeHistory: { atMs: number; bps: number }[];
}

const MARKET_SETS = {
  major: ["BTC-USDX-PERP", "ETH-USDX-PERP"],
  broad: ["BTC-USDX-PERP", "ETH-USDX-PERP", "SOL-USDX-PERP"],
  btcOnly: ["BTC-USDX-PERP"],
} as const;

/*
 * The roster. Fifteen venues, because a platform console with five is a table and
 * not a business: cohorts need enough signups per week to have a denominator, and
 * activation and churn are invisible unless some venues genuinely never activated
 * and some genuinely stopped.
 *
 * Dates are expressed as offsets from NOW_MS so the whole roster stays internally
 * consistent if the clock constant ever moves.
 */
const w = (weeks: number) => NOW_MS - weeks * WEEK_MS;
const d = (days: number) => NOW_MS - days * DAY_MS;
/* Signup + time-to-first-order. Stated as a duration rather than a second date
   because TTFO is the metric the growth page reads, and a roster where every
   venue happens to activate exactly one week after signing up produces a
   histogram with one bar and a median that means nothing. */
const activated = (signedUpMs: number, ttfoDays: number) => signedUpMs + ttfoDays * DAY_MS;

export const DEMO_VENUES: DemoVenue[] = [
  {
    code: "bld_orbit",
    name: "Orbit Trade",
    feeBps: 1,
    traders: 963,
    liveSinceMs: activated(w(18), 3),
    signedUpMs: w(18),
    firstOrderMs: activated(w(18), 3),
    lastOrderMs: null,
    status: "live",
    teamSeats: 9,
    markets: [...MARKET_SETS.broad],
    apiOrderShare: 0.21,
    rejectRate30d: 0.004,
    rejectRate7d: 0.005,
    keyRotatedMs: d(23),
    fiatLean: 0.62,
    feeHistory: [
      { atMs: w(17), bps: 3 },
      { atMs: w(9), bps: 2 },
      { atMs: w(3), bps: 1 },
    ],
  },
  {
    code: "bld_acme",
    name: "Acme Perps",
    feeBps: 2,
    traders: 412,
    liveSinceMs: activated(w(16), 7),
    signedUpMs: w(16),
    firstOrderMs: activated(w(16), 7),
    lastOrderMs: null,
    status: "live",
    teamSeats: 6,
    markets: [...MARKET_SETS.broad],
    apiOrderShare: 0.34,
    rejectRate30d: 0.006,
    rejectRate7d: 0.006,
    keyRotatedMs: d(41),
    fiatLean: 0.48,
    feeHistory: [
      { atMs: w(15), bps: 2 },
    ],
  },
  {
    code: "bld_harbor",
    name: "Harbor Futures",
    feeBps: 4,
    traders: 331,
    liveSinceMs: activated(w(13), 2),
    signedUpMs: w(13),
    firstOrderMs: activated(w(13), 2),
    lastOrderMs: null,
    status: "live",
    teamSeats: 4,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.72,
    rejectRate30d: 0.011,
    rejectRate7d: 0.028,
    keyRotatedMs: d(97),
    fiatLean: 0.19,
    feeHistory: [
      { atMs: w(12), bps: 5 },
      { atMs: w(4), bps: 4 },
    ],
  },
  {
    code: "bld_pine",
    name: "Pine Terminal",
    feeBps: 3,
    traders: 245,
    liveSinceMs: activated(w(11), 12),
    signedUpMs: w(11),
    firstOrderMs: activated(w(11), 12),
    lastOrderMs: null,
    status: "live",
    teamSeats: 3,
    markets: [...MARKET_SETS.broad],
    apiOrderShare: 0.12,
    rejectRate30d: 0.005,
    rejectRate7d: 0.004,
    keyRotatedMs: d(12),
    fiatLean: 0.77,
    feeHistory: [{ atMs: w(10), bps: 3 }],
  },
  {
    code: "bld_kestrel",
    name: "Kestrel Markets",
    feeBps: 5,
    traders: 188,
    liveSinceMs: activated(w(10), 5),
    signedUpMs: w(10),
    firstOrderMs: activated(w(10), 5),
    lastOrderMs: null,
    status: "live",
    teamSeats: 5,
    markets: [...MARKET_SETS.broad],
    apiOrderShare: 0.55,
    rejectRate30d: 0.008,
    rejectRate7d: 0.009,
    keyRotatedMs: d(31),
    fiatLean: 0.35,
    feeHistory: [
      { atMs: w(9), bps: 4 },
      { atMs: w(5), bps: 5 },
    ],
  },
  {
    code: "bld_vela",
    name: "Vela Exchange",
    feeBps: 2,
    traders: 118,
    liveSinceMs: activated(w(8), 1),
    signedUpMs: w(8),
    firstOrderMs: activated(w(8), 1),
    lastOrderMs: null,
    status: "live",
    teamSeats: 2,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.88,
    rejectRate30d: 0.003,
    rejectRate7d: 0.003,
    keyRotatedMs: null,
    fiatLean: 0.14,
    feeHistory: [{ atMs: w(7), bps: 2 }],
  },
  {
    code: "bld_tessel",
    name: "Tessel Capital",
    feeBps: 6,
    traders: 74,
    liveSinceMs: activated(w(7), 9),
    signedUpMs: w(7),
    firstOrderMs: activated(w(7), 9),
    lastOrderMs: null,
    status: "live",
    teamSeats: 2,
    markets: [...MARKET_SETS.btcOnly],
    apiOrderShare: 0.94,
    rejectRate30d: 0.014,
    rejectRate7d: 0.041,
    keyRotatedMs: d(118),
    fiatLean: 0.08,
    feeHistory: [{ atMs: w(6), bps: 6 }],
  },
  {
    code: "bld_lumen",
    name: "Lumen Derivatives",
    feeBps: 10,
    traders: 57,
    liveSinceMs: activated(w(6), 16),
    signedUpMs: w(6),
    firstOrderMs: activated(w(6), 16),
    lastOrderMs: null,
    status: "live",
    teamSeats: 3,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.4,
    rejectRate30d: 0.009,
    rejectRate7d: 0.012,
    keyRotatedMs: d(18),
    fiatLean: 0.71,
    feeHistory: [
      { atMs: w(5), bps: 8 },
      { atMs: w(2), bps: 10 },
    ],
  },
  {
    code: "bld_quill",
    name: "Quill Trading",
    feeBps: 8,
    traders: 41,
    liveSinceMs: activated(w(4), 4),
    signedUpMs: w(4),
    firstOrderMs: activated(w(4), 4),
    lastOrderMs: null,
    status: "live",
    teamSeats: 1,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.66,
    rejectRate30d: 0.007,
    rejectRate7d: 0.007,
    keyRotatedMs: null,
    fiatLean: 0.55,
    feeHistory: [{ atMs: w(3), bps: 8 }],
  },
  /* Stopped routing three weeks ago and let the key lapse. */
  {
    code: "bld_northwind",
    name: "Northwind Perps",
    feeBps: 7,
    traders: 96,
    liveSinceMs: activated(w(15), 6),
    signedUpMs: w(15),
    firstOrderMs: activated(w(15), 6),
    lastOrderMs: d(24),
    status: "churned",
    teamSeats: 2,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.3,
    rejectRate30d: 0.019,
    rejectRate7d: 0,
    keyRotatedMs: d(210),
    fiatLean: 0.44,
    feeHistory: [
      { atMs: w(14), bps: 6 },
      { atMs: w(8), bps: 7 },
    ],
  },
  /* Routed, then went quiet — not yet churned, which is exactly when to call. */
  {
    code: "bld_sable",
    name: "Sable Markets",
    feeBps: 4,
    traders: 63,
    liveSinceMs: activated(w(9), 21),
    signedUpMs: w(9),
    firstOrderMs: activated(w(9), 21),
    lastOrderMs: d(12),
    status: "dormant",
    teamSeats: 1,
    markets: [...MARKET_SETS.btcOnly],
    apiOrderShare: 0.5,
    rejectRate30d: 0.022,
    rejectRate7d: 0,
    keyRotatedMs: d(64),
    fiatLean: 0.6,
    feeHistory: [{ atMs: w(8), bps: 4 }],
  },
  /* Signed up, never routed. The activation gap, in three rows. */
  {
    code: "bld_meridian",
    name: "Meridian Desk",
    feeBps: 5,
    traders: 0,
    liveSinceMs: w(4),
    signedUpMs: w(4),
    firstOrderMs: null,
    lastOrderMs: null,
    status: "onboarding",
    teamSeats: 2,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0,
    rejectRate30d: 0,
    rejectRate7d: 0,
    keyRotatedMs: null,
    fiatLean: 0.5,
    feeHistory: [{ atMs: w(4), bps: 5 }],
  },
  {
    code: "bld_cobalt",
    name: "Cobalt Labs",
    feeBps: 3,
    traders: 0,
    liveSinceMs: w(2),
    signedUpMs: w(2),
    firstOrderMs: null,
    lastOrderMs: null,
    status: "onboarding",
    teamSeats: 1,
    markets: [...MARKET_SETS.btcOnly],
    apiOrderShare: 0,
    rejectRate30d: 0,
    rejectRate7d: 0,
    keyRotatedMs: null,
    fiatLean: 0.3,
    feeHistory: [{ atMs: w(2), bps: 3 }],
  },
  /*
   * The newest venue, and the reason it exists in the roster: it signed up four
   * days ago and activated three days later, so the current week has a signup
   * AND an activation in it. Without one, every "this week" tile on the console
   * reads zero and the weekly chart's rightmost column is empty — which looks
   * like a bug in the console rather than a quiet week on the platform.
   *
   * It also exercises the null-trend path: one week of flow and nothing before
   * it, so `flowChange` has no prior week and correctly refuses to render one.
   */
  {
    code: "bld_driftwood",
    name: "Driftwood",
    feeBps: 2,
    traders: 12,
    liveSinceMs: d(1),
    signedUpMs: d(4),
    firstOrderMs: d(1),
    lastOrderMs: null,
    status: "live",
    teamSeats: 1,
    markets: [...MARKET_SETS.major],
    apiOrderShare: 0.6,
    rejectRate30d: 0.002,
    rejectRate7d: 0.002,
    keyRotatedMs: null,
    fiatLean: 0.4,
    feeHistory: [{ atMs: d(1), bps: 2 }],
  },
  {
    code: "bld_glass",
    name: "Glass Markets",
    feeBps: 6,
    traders: 0,
    liveSinceMs: d(2),
    signedUpMs: d(2),
    firstOrderMs: null,
    lastOrderMs: null,
    status: "onboarding",
    teamSeats: 2,
    markets: [...MARKET_SETS.broad],
    apiOrderShare: 0,
    rejectRate30d: 0,
    rejectRate7d: 0,
    keyRotatedMs: null,
    fiatLean: 0.45,
    feeHistory: [{ atMs: d(2), bps: 6 }],
  },
];

export const venueByCode = (code: string): DemoVenue | null =>
  DEMO_VENUES.find((v) => v.code === code) ?? null;

const MARKETS = ["BTC-USDX-PERP", "ETH-USDX-PERP", "SOL-USDX-PERP"] as const;
const REF_PRICE: Record<string, number> = {
  "BTC-USDX-PERP": 64_000,
  "ETH-USDX-PERP": 1_880,
  "SOL-USDX-PERP": 138,
};

export interface AttributedFlow {
  ledger: AttributionLedger;
  fills: FillLike[];
  /** Per-day routed notional per venue, oldest first — for the charts. */
  daily: { dayMs: number; byCode: Record<string, number> }[];
}

/**
 * Build a deterministic flow across every demo venue.
 *
 * `fillsPerVenue` is sized for a legible daily series, not for load: two fills a
 * day per venue leaves the chart reading as noise however the days are weighted.
 * It is a ceiling, not a quota — a venue only gets fills on days it was actually
 * routing, so an onboarding venue gets none and a churned one stops.
 */
export function buildAttributedFlow(days = 30, fillsPerVenue = 240): AttributedFlow {
  const random = prng(0x5eed);
  const ledger = new AttributionLedger();
  const fills: FillLike[] = [];
  const today = NOW_MS;
  const daily: { dayMs: number; byCode: Record<string, number> }[] = Array.from(
    { length: days },
    (_, i) => ({ dayMs: today - (days - 1 - i) * DAY_MS, byCode: {} }),
  );

  /*
   * Days are not sampled uniformly. Uniform assignment produced a series that
   * read as noise — tall isolated spikes with nothing between them — which made
   * both the area chart and the trend signal meaningless. Real venue flow has a
   * growth trend and a weekday rhythm, so the weights below carry both, and the
   * anomaly detector then has something to actually detect against.
   */
  const dayWeights = Array.from({ length: days }, (_, i) => {
    const trend = 1 + 0.035 * i;
    const weekday = new Date(today - (days - 1 - i) * DAY_MS).getUTCDay();
    const rhythm = weekday === 0 || weekday === 6 ? 0.55 : 1;
    return trend * rhythm;
  });

  let orderSeq = 0;
  for (const venue of DEMO_VENUES) {
    /* A venue's own weight vector: the platform rhythm, masked by the window in
       which this venue was actually routing. Zero outside it, so lifecycle state
       and chart shape cannot disagree. */
    const from = venue.firstOrderMs;
    if (from === null) continue;
    const until = venue.lastOrderMs ?? Infinity;
    const weights = daily.map((bucket, i) =>
      bucket.dayMs + DAY_MS > from && bucket.dayMs < until ? (dayWeights[i] ?? 0) : 0,
    );
    const weightTotal = weights.reduce((s, x) => s + x, 0);
    if (weightTotal <= 0) continue;

    const activeDays = weights.filter((x) => x > 0).length;
    const count = Math.max(1, Math.round((fillsPerVenue * activeDays) / days));
    const pickDay = (r: number) => {
      let acc = 0;
      const target = r * weightTotal;
      for (let i = 0; i < days; i++) {
        acc += weights[i] ?? 0;
        if (target <= acc) return i;
      }
      return days - 1;
    };

    for (let i = 0; i < count; i++) {
      const market = venue.markets[Math.floor(random() * venue.markets.length)] ?? MARKETS[0];
      const ref = REF_PRICE[market] ?? 1_000;
      const price = ref * (1 + (random() - 0.5) * 0.02);
      /* Size scaled by trader count, so a venue with more users routes more —
         the shape a reader expects, rather than uniform noise. */
      const size = (0.05 + random() * 0.9) * (venue.traders / 400);
      const dayIndex = pickDay(random());
      const orderId = `sim-o${++orderSeq}`;

      ledger.record({
        orderId,
        builderCode: venue.code,
        feeBps: venue.feeBps,
        marketId: market,
        submittedAtMs: (daily[dayIndex]?.dayMs ?? today) + Math.floor(random() * DAY_MS),
      });

      const notional = price * size;
      fills.push({
        id: `sim-f${orderSeq}`,
        order_id: orderId,
        market_id: market,
        price: price.toFixed(2),
        size: size.toFixed(4),
        /* The venue's own taker fee, 2 bps net of the schedule in
           exchange-mainnet.toml — the same figure the fills endpoint returns. */
        fee: (notional * 0.0002).toFixed(6),
      });

      const bucket = daily[dayIndex];
      if (bucket) bucket.byCode[venue.code] = (bucket.byCode[venue.code] ?? 0) + notional;
    }
  }

  return { ledger, fills, daily };
}

/* One flow per process. Rebuilding it per request would still be deterministic,
   but it would also be wasted work on every dashboard paint. */
let cached: AttributedFlow | null = null;
export function attributedFlow(): AttributedFlow {
  if (!cached) cached = buildAttributedFlow();
  return cached;
}

// ── funding rails (the Halliday dimension) ───────────────────────────────────

/*
 * WHAT THIS MODELS, AND WHAT IT DOES NOT.
 *
 * Nexus is integrating Halliday (halliday.xyz) as the funding layer in front of
 * the USDX bridge, bundled into the Nexus API so every venue inherits it.
 *
 * The origin mix is driven by each venue's `fiatLean`, because that is the one
 * venue property the mix actually correlates with: a retail venue funds through
 * cards, an API-heavy venue funds by moving stablecoin it already holds.
 *
 * This file ships to tenants — the venue template IS their repository — so the
 * internal delivery detail that used to sit here (ticket ids, the legal gate, a
 * decision record's merge state, and who signed what) has been removed. It was
 * never a fact a tenant could act on, and publishing our own dependency status
 * into someone else's codebase is a commitment to keep it current.
 *
 * ORIGIN AND TERMINUS ARE TWO DIFFERENT FACTS, AND THE MODEL KEEPS THEM APART.
 * Upstream, Halliday absorbs fiat (cards, bank transfers, ACH, wire), CEX
 * withdrawals, and any token on any chain, including the routing and swapping to
 * get from one to another. Downstream, every one of those paths terminates the
 * same way: a plain ERC-20 transfer on Ethereum to a per-account address Nexus
 * derives, passed to Halliday per payment as `destination_address`, which the
 * native bridge then picks up and credits. Collapsing the two layers into one
 * "chains supported" number would misdescribe how the money actually moves.
 *
 * The reach is a property of the FUNDING RAILS. It is not a property of any
 * settlement chain, and nothing here should be read as one.
 *
 * FOUR ORIGINS, WHICH IS ALSO THE COLOUR BUDGET. A fifth would need a fifth hue,
 * and the palette does not have one — so cross-chain routing and swaps live
 * inside `chain`, which is where a trader would say the money came from anyway.
 */
export type RailKey = "card" | "bank" | "cex" | "chain";

export const RAILS: { key: RailKey; label: string; fiat: boolean; note: string }[] = [
  {
    key: "card",
    label: "Card",
    fiat: true,
    note: "Debit and credit onramp, aggregated across Halliday's providers.",
  },
  {
    key: "bank",
    label: "Bank transfer",
    fiat: true,
    note: "ACH, SEPA, wire and local rails. Slowest to settle, largest tickets.",
  },
  {
    key: "cex",
    label: "CEX withdrawal",
    fiat: false,
    note: "A withdrawal from an exchange account the trader already funded.",
  },
  {
    key: "chain",
    label: "On-chain",
    fiat: false,
    note: "Any token on any chain, routed and swapped as needed — or sent direct.",
  },
];

/** The origins that only exist because of the aggregator. */
export const HALLIDAY_RAILS: RailKey[] = ["card", "bank", "cex"];

/** Fiat origins — the two a venue would lose if the onramp went down. */
export const FIAT_RAILS: RailKey[] = ["card", "bank"];

export interface DepositDay {
  dayMs: number;
  /** venue code → origin rail → notional in USDC. */
  byCode: Record<string, Record<RailKey, number>>;
  /** venue code → origin rail → deposit count. */
  countsByCode: Record<string, Record<RailKey, number>>;
  /**
   * The slice of `chain` that arrived without the aggregator — a trader sending
   * USDC to the derived address themselves. It is the only path that works today,
   * which is why it is tracked apart from the rest rather than folded in.
   */
  directByCode: Record<string, number>;
}

const emptyRails = (): Record<RailKey, number> => ({ card: 0, bank: 0, cex: 0, chain: 0 });

/**
 * Project deposits by origin, per venue, per day.
 *
 * The mix is driven by each venue's `fiatLean`: a retail venue funds through
 * cards, a venue whose flow is 94% API funds by moving stablecoin it already
 * holds. That correlation is the point of the panel — it is what tells the
 * platform which venues would break if the fiat onramp went down.
 */
export function buildDepositDays(days = 30): DepositDay[] {
  const random = prng(0xf00d);
  const today = NOW_MS;

  return Array.from({ length: days }, (_, i) => {
    const dayMs = today - (days - 1 - i) * DAY_MS;
    const byCode: Record<string, Record<RailKey, number>> = {};
    const countsByCode: Record<string, Record<RailKey, number>> = {};
    const directByCode: Record<string, number> = {};

    for (const venue of DEMO_VENUES) {
      const rails = emptyRails();
      const counts = emptyRails();
      byCode[venue.code] = rails;
      countsByCode[venue.code] = counts;
      directByCode[venue.code] = 0;

      /* No orders routed, no funding to project. Deposits follow activation. */
      const from = venue.firstOrderMs;
      if (from === null || dayMs + DAY_MS <= from) continue;
      if (venue.lastOrderMs !== null && dayMs >= venue.lastOrderMs) continue;

      /* Deposit count scales with traders and is lumpy day to day. */
      const base = Math.max(1, Math.round((venue.traders / 55) * (0.5 + random())));
      const crypto = 1 - venue.fiatLean;
      const split: Record<RailKey, number> = {
        card: venue.fiatLean * 0.58,
        bank: venue.fiatLean * 0.42,
        cex: crypto * 0.38,
        chain: crypto * 0.62,
      };
      /* Typical ticket per origin. A bank transfer is a big, rare deposit; a card
         is a small, frequent one. Getting this backwards would make the mix
         chart lie about which rail carries the money. */
      const ticket: Record<RailKey, number> = {
        card: 320,
        bank: 4_100,
        cex: 1_450,
        chain: 2_600,
      };

      for (const rail of ["card", "bank", "cex", "chain"] as RailKey[]) {
        const n = Math.round(base * (split[rail] ?? 0) * (0.6 + random() * 0.8));
        counts[rail] = n;
        rails[rail] = n * ticket[rail] * (0.7 + random() * 0.6);
      }

      /* The crypto-native half of the on-chain origin sends its own transfer and
         never touches the aggregator. That share is larger for venues whose
         traders are already on-chain, which is the same axis as `fiatLean`. */
      directByCode[venue.code] = rails.chain * (0.35 + crypto * 0.4);
    }

    return { dayMs, byCode, countsByCode, directByCode };
  });
}

let depositsCache: DepositDay[] | null = null;
export function depositDays(): DepositDay[] {
  if (!depositsCache) depositsCache = buildDepositDays();
  return depositsCache;
}
