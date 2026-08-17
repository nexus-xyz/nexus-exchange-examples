/*
 * Seasons — wire types and adapter for the incentive programme.
 *
 * WHAT THIS MIRRORS
 *
 * The proposed read-only extension to the Nexus Exchange API, specified in
 * `personal/daniel/pod-roadmaps/proposals/growth-engine/seasons-prd.md` §9. Per
 * repo AGENTS.md rule 20 the real spec is contract-first and lives in
 * `nexus-xyz/nexus-exchange-api`; these types are the terminal's side of that
 * contract, written to the same conventions as ./types.ts:
 *
 *   • Every monetary or token quantity arrives as a DECIMAL STRING, never a
 *     float. Parsing happens here and nowhere else.
 *   • Optional timestamps are nullable, never a zero date.
 *   • Enums are additive. `SeasonStatus` and `UnlockStatus` both carry an
 *     unknown-member fallback, because the contract gates validate schema
 *     *names* and not enum *membership* — the `TimeInForce`/`PostOnly` drift
 *     documented in eng/apps/exchange/INTERFACES-ARCHITECTURE.md §5. A closed
 *     enum here would turn any future member into a runtime parse failure in
 *     already-deployed clients.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   • No USD figures. The API returns NEX quantities only; a dollar value on an
 *     unvested balance is a price promise. The UI multiplies by a mark it
 *     fetches separately and labels it as an estimate.
 *   • No write endpoints. Distribution is pushed by the Foundation, so there is
 *     no claim, no opt-in, and nothing for a client to submit.
 *   • No lifetime points total. Points are season-scoped by construction.
 */

import { absent, type Maybe } from "./absence";

// ---------------------------------------------------------------- wire shapes

/** Additive. Anything unrecognised parses to `"unknown"` rather than throwing. */
export type SeasonStatus = "upcoming" | "open" | "closed" | "settled" | "exhausted" | "unknown";

const SEASON_STATUSES: readonly SeasonStatus[] = [
  "upcoming",
  "open",
  "closed",
  "settled",
  "exhausted",
];

/** A tranche is paused when an activity gate has not been met — never forfeited. */
export type UnlockStatus = "vested" | "scheduled" | "paused" | "unknown";

const UNLOCK_STATUSES: readonly UnlockStatus[] = ["vested", "scheduled", "paused"];

export type WireUnlockTranche = {
  offsetMonths: number;
  /** Decimal string. Shares across a schedule sum to 1. */
  share: string;
};

export type WireSeason = {
  seasonId: string;
  name?: string;
  status: string;
  weights?: { volume?: string; depth?: string; balance?: string };
  /** Decimal string. A fixed NEX quantity — never a USD target. */
  poolNex: string;
  opensAt: string;
  closesAt: string;
  settledAt: string | null;
  /** Null until the season settles. */
  totalPoints: string | null;
  participants: number | null;
  unlockSchedule: WireUnlockTranche[];
  /**
   * Share of the season's points held by each decile of participants, ascending.
   * Ten decimal strings summing to 1. Aggregate only — never per-account — so the
   * venue can publish its own concentration without exposing anybody's activity.
   * Null until the season settles.
   */
  pointsDistribution: string[] | null;
};

export type WireAccountSeason = {
  seasonId: string;
  status: string;
  points: string;
  rank: number | null;
  shareOfPool: string | null;
  entitlementNex: string | null;
  /** Live estimate while a season is open. Explicitly NOT a commitment. */
  estimatedNex: string | null;
  vestedNex: string | null;
  unvestedNex: string | null;
  streakMultiplier: string;
  /**
   * Track A rebate settled at this season's close, in USDX.
   *
   * Track A is a SEPARATE programme — a straight 50% rebate of net fees paid, with
   * no pro-rata and no ladder. It is carried on this resource because both tracks
   * settle on the same event, so a client rendering a season almost always wants
   * both figures. It is never part of `poolNex` and never affects the pro-rata.
   */
  trackARebateUsdx: string | null;
  /** Net fees this account paid during the season, USD. Denominator for yield. */
  feesPaidUsd: string | null;
  /**
   * How this account's points were composed, as a 3-simplex summing to 1. Compared
   * against the season's own `weights` it explains performance: an account whose
   * mix sits far from the scoring weights does badly however active it was.
   */
  activityMix: { volume: string; depth: string; balance: string } | null;
};

/**
 * One row of a season leaderboard.
 *
 * The board is PSEUDONYMOUS by construction, and that is a contract decision
 * rather than a UI one. The API returns an account address and nothing else —
 * no display name, no handle, no avatar reference, no linked social. There is
 * therefore no field a client could render that would identify a person, and no
 * later product decision can quietly add one without changing this type.
 *
 * `isSelf` is server-side because the window is server-selected: a client asking
 * for "the rows around me" must be told which row it is, and matching on address
 * client-side would force the caller to hold its own address to read a board.
 */
/*
 * NO REWARD VALUE PER ROW, and that is a privacy constraint rather than a layout
 * one. Track B is pro-rata and therefore already implied by `shareOfPool` — a NEX
 * column would print the same number twice. Track A is NOT: it is half of the net
 * fees that account paid, so any figure combining the two tracks can be inverted
 * to recover another trader's fee volume for the season. Per-account activity is
 * exactly what this programme publishes as decile shares instead. The caller's own
 * entitlement is on `/account/seasons`, where it belongs.
 */
export type WireLeaderboardEntry = {
  rank: number;
  /** Full account address. The client truncates for display; it is never a name. */
  address: string;
  points: string;
  /** Share of the season pool, decimal string. */
  shareOfPool: string;
  /**
   * Rank movement over the trailing 7 days. Null for an account with no prior
   * standing — a new entrant has not moved, and rendering that as 0 would claim
   * they held their place.
   */
  rankDelta7d: number | null;
  isSelf: boolean;
};

export type WireLeaderboard = {
  seasonId: string;
  /** Total ranked accounts. The denominator for "#312 of 4,180". */
  participants: number;
  /** The requested window, ascending by rank. */
  entries: WireLeaderboardEntry[];
  /** Ten ascending decile shares of points. Published instead of identities. */
  pointsDistribution: string[] | null;
};

export type WireRewardUnlock = {
  unlockAt: string;
  amountNex: string;
  status: string;
  pausedReason: string | null;
  sources: { seasonId: string; amountNex: string }[];
};

// ------------------------------------------------------------------ UI models

export type Tranche = { offsetMonths: number; share: number };

export type Season = {
  id: string;
  name: string;
  status: SeasonStatus;
  weights: { volume: number; depth: number; balance: number };
  poolNex: number;
  opensAt: Date;
  closesAt: Date;
  settledAt: Date | null;
  /** Absent until settlement — the denominator genuinely does not exist yet. */
  totalPoints: Maybe<number>;
  participants: Maybe<number>;
  schedule: Tranche[];
  /** Ten ascending decile shares. Absent until settled. */
  pointsDistribution: Maybe<number[]>;
};

export type AccountSeason = {
  seasonId: string;
  status: SeasonStatus;
  points: number;
  rank: Maybe<number>;
  shareOfPool: Maybe<number>;
  /** Fixed at settlement. Absent while the season is still open. */
  entitlementNex: Maybe<number>;
  /** Live, moves with everyone else's activity. Absent once settled. */
  estimatedNex: Maybe<number>;
  vestedNex: number;
  unvestedNex: number;
  streakMultiplier: number;
  /** Track A, settled at this season's close. Liquid on arrival — no ladder. */
  trackARebateUsdx: Maybe<number>;
  feesPaidUsd: Maybe<number>;
  activityMix: Maybe<{ volume: number; depth: number; balance: number }>;
};

export type LeaderboardEntry = {
  rank: number;
  address: string;
  points: number;
  shareOfPool: number;
  rankDelta7d: Maybe<number>;
  isSelf: boolean;
};

export type Leaderboard = {
  seasonId: string;
  participants: number;
  entries: LeaderboardEntry[];
  pointsDistribution: Maybe<number[]>;
};

export type RewardUnlock = {
  unlockAt: Date;
  amountNex: number;
  status: UnlockStatus;
  pausedReason: string | null;
  sources: { seasonId: string; amountNex: number }[];
};

// -------------------------------------------------------------------- parsing

/** Decimal string → number. Returns `Absent` rather than 0 when the field is unusable. */
function decimal(v: string | null | undefined, field: string): Maybe<number> {
  if (v === null || v === undefined || v === "") return absent("missing", undefined, field);
  const n = Number(v);
  return Number.isFinite(n) ? n : absent("unparseable", undefined, field);
}

/** Same, but for fields the contract guarantees. Falls back to 0 only for shares. */
function decimalOr(v: string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function status<T extends string>(raw: string, known: readonly T[]): T | "unknown" {
  return (known as readonly string[]).includes(raw) ? (raw as T) : "unknown";
}

export function parseSeason(w: WireSeason): Season {
  return {
    id: w.seasonId,
    name: w.name ?? w.seasonId,
    status: status(w.status, SEASON_STATUSES),
    weights: {
      volume: decimalOr(w.weights?.volume, 0),
      depth: decimalOr(w.weights?.depth, 0),
      balance: decimalOr(w.weights?.balance, 0),
    },
    poolNex: decimalOr(w.poolNex, 0),
    opensAt: new Date(w.opensAt),
    closesAt: new Date(w.closesAt),
    settledAt: w.settledAt ? new Date(w.settledAt) : null,
    totalPoints: decimal(w.totalPoints, "totalPoints"),
    participants:
      w.participants === null ? absent("missing", undefined, "participants") : w.participants,
    schedule: w.unlockSchedule.map((t) => ({
      offsetMonths: t.offsetMonths,
      share: decimalOr(t.share, 0),
    })),
    pointsDistribution:
      w.pointsDistribution === null || w.pointsDistribution === undefined
        ? absent("missing", undefined, "pointsDistribution")
        : w.pointsDistribution.map((d) => decimalOr(d, 0)),
  };
}

export function parseAccountSeason(w: WireAccountSeason): AccountSeason {
  return {
    seasonId: w.seasonId,
    status: status(w.status, SEASON_STATUSES),
    points: decimalOr(w.points, 0),
    rank: w.rank === null ? absent("missing", undefined, "rank") : w.rank,
    shareOfPool: decimal(w.shareOfPool, "shareOfPool"),
    entitlementNex: decimal(w.entitlementNex, "entitlementNex"),
    estimatedNex: decimal(w.estimatedNex, "estimatedNex"),
    vestedNex: decimalOr(w.vestedNex, 0),
    unvestedNex: decimalOr(w.unvestedNex, 0),
    streakMultiplier: decimalOr(w.streakMultiplier, 1),
    trackARebateUsdx: decimal(w.trackARebateUsdx, "trackARebateUsdx"),
    feesPaidUsd: decimal(w.feesPaidUsd, "feesPaidUsd"),
    activityMix:
      w.activityMix == null
        ? absent("missing", undefined, "activityMix")
        : {
            volume: decimalOr(w.activityMix.volume, 0),
            depth: decimalOr(w.activityMix.depth, 0),
            balance: decimalOr(w.activityMix.balance, 0),
          },
  };
}

export function parseRewardUnlock(w: WireRewardUnlock): RewardUnlock {
  return {
    unlockAt: new Date(w.unlockAt),
    amountNex: decimalOr(w.amountNex, 0),
    status: status(w.status, UNLOCK_STATUSES),
    pausedReason: w.pausedReason,
    sources: w.sources.map((s) => ({
      seasonId: s.seasonId,
      amountNex: decimalOr(s.amountNex, 0),
    })),
  };
}

export function parseLeaderboard(w: WireLeaderboard): Leaderboard {
  return {
    seasonId: w.seasonId,
    participants: w.participants,
    entries: w.entries.map((e) => ({
      rank: e.rank,
      address: e.address,
      points: decimalOr(e.points, 0),
      shareOfPool: decimalOr(e.shareOfPool, 0),
      // Absent, not 0. A new entrant has not held its place.
      rankDelta7d:
        e.rankDelta7d === null ? absent("missing", undefined, "rankDelta7d") : e.rankDelta7d,
      isSelf: e.isSelf,
    })),
    pointsDistribution: w.pointsDistribution
      ? w.pointsDistribution.map((d) => decimalOr(d, 0))
      : absent("missing", undefined, "pointsDistribution"),
  };
}

/** The six read endpoints this screen consumes. Kept here so the swap to real fetch is one file. */
export const SEASONS_ENDPOINTS = [
  { method: "GET", path: "/api/v1/seasons", auth: false, note: "all seasons, newest first" },
  { method: "GET", path: "/api/v1/seasons/{seasonId}", auth: false, note: "pool, weights, schedule" },
  { method: "GET", path: "/api/v1/seasons/{seasonId}/leaderboard", auth: false, note: "windowed around the caller, pseudonymous" },
  { method: "GET", path: "/api/v1/account/seasons", auth: true, note: "points, share, entitlement" },
  { method: "GET", path: "/api/v1/account/rewards", auth: true, note: "aggregated unlock calendar" },
  { method: "GET", path: "/api/v1/account/rewards/summary", auth: true, note: "vested / unvested / next" },
] as const;
