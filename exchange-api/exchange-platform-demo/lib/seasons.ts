/*
 * Mock feed for the Seasons programme.
 *
 * Emits WIRE shapes (decimal strings, nullable timestamps) and runs them through
 * the adapter in ./api/seasons.ts, so the parsing path is genuinely exercised
 * rather than bypassed. Swapping this for `fetch` should change this file only.
 *
 * The numbers track the growth-programme model this feature was designed
 * against: a 4-week season, a pool that starts near $38k and ramps, scoring
 * weights that rotate from volume toward depth, and ladders that lengthen as
 * the programme matures.
 */

import {
  parseAccountSeason,
  parseLeaderboard,
  parseRewardUnlock,
  parseSeason,
  type AccountSeason,
  type RewardUnlock,
  type Season,
  type Leaderboard,
  type WireAccountSeason,
  type WireLeaderboard,
  type WireLeaderboardEntry,
  type WireRewardUnlock,
  type WireSeason,
} from "./api/seasons";
import { rng, seedOf } from "./format";

/** Mock NEX mark. The API never returns this — the client fetches it separately. */
export const NEX_MARK_USD = 0.85;

/** Programme epoch, fixed so the demo is deterministic across reloads. */
const EPOCH = new Date("2026-02-02T00:00:00Z").getTime();
const SEASON_MS = 28 * 24 * 3600 * 1000;
const MONTH_MS = 30.44 * 24 * 3600 * 1000;

/** "Now" is pinned mid-Season-7 so the screen shows an open season with history behind it. */
export const NOW = new Date(EPOCH + 6 * SEASON_MS + 16 * 24 * 3600 * 1000);

const LADDER_SHORT = [
  [0, 0.25],
  [1, 0.25],
  [3, 0.25],
  [6, 0.25],
] as const;
const LADDER_MID = [
  [0, 0.15],
  [1, 0.15],
  [3, 0.2],
  [6, 0.25],
  [12, 0.25],
] as const;
const LADDER_LONG = [
  [0, 0.1],
  [1, 0.1],
  [3, 0.2],
  [6, 0.3],
  [12, 0.3],
] as const;

type Spec = {
  weights: { volume: number; depth: number; balance: number };
  poolNex: number;
  ladder: readonly (readonly [number, number])[];
};

/*
 * Seasons are numbered, not named, and carry no theme. A codename and a stated
 * objective ("Genesis — maker depth") read as editorial: they invite a trader to
 * work out which season they are temperamentally suited to, when the only thing
 * that changes between seasons is the pool and the scoring weights. Numbering
 * makes the sequence the point and keeps the page to figures.
 */
const SPECS: Spec[] = [
  { weights: { volume: 1, depth: 0, balance: 0 }, poolNex: 44_899, ladder: LADDER_SHORT },
  { weights: { volume: 0.7, depth: 0, balance: 0.3 }, poolNex: 54_245, ladder: LADDER_SHORT },
  { weights: { volume: 0.7, depth: 0, balance: 0.3 }, poolNex: 65_552, ladder: LADDER_MID },
  { weights: { volume: 0.1, depth: 0.9, balance: 0 }, poolNex: 79_078, ladder: LADDER_MID },
  { weights: { volume: 0.5, depth: 0.5, balance: 0 }, poolNex: 95_055, ladder: LADDER_MID },
  { weights: { volume: 0.3, depth: 0.5, balance: 0.2 }, poolNex: 113_664, ladder: LADDER_LONG },
  { weights: { volume: 0.4, depth: 0.4, balance: 0.2 }, poolNex: 135_028, ladder: LADDER_LONG },
  { weights: { volume: 0.4, depth: 0.4, balance: 0.2 }, poolNex: 160_000, ladder: LADDER_LONG },
];

const dec = (n: number, d = 2) => n.toFixed(d);

/** Normalise three components onto the simplex and emit them as decimal strings. */
function mix(v: number, d: number, b: number) {
  const t = v + d + b;
  return { volume: dec(v / t, 4), depth: dec(d / t, 4), balance: dec(b / t, 4) };
}

/**
 * Ten ascending decile shares with a controllable concentration.
 * `top` is the share held by the richest decile; the rest decay geometrically,
 * which is the shape real points programmes actually produce.
 */
function decileShares(top: number, r: () => number): string[] {
  const raw = Array.from({ length: 10 }, (_, k) => Math.pow(top / (1 - top), k) * (0.9 + 0.2 * r()));
  const t = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => dec(x / t, 6));
}

function wireSeasons(): WireSeason[] {
  return SPECS.map((s, i) => {
    const opens = EPOCH + i * SEASON_MS;
    const closes = opens + SEASON_MS;
    const settled = closes + 24 * 3600 * 1000;
    const isPast = NOW.getTime() >= settled;
    const isOpen = NOW.getTime() >= opens && NOW.getTime() < closes;
    const r = rng(seedOf(`S${i + 1}`));
    return {
      seasonId: `S${i + 1}`,
      name: `Season ${i + 1}`,
      status: isPast ? "settled" : isOpen ? "open" : NOW.getTime() < opens ? "upcoming" : "closed",
      weights: {
        volume: dec(s.weights.volume),
        depth: dec(s.weights.depth),
        balance: dec(s.weights.balance),
      },
      poolNex: dec(s.poolNex),
      opensAt: new Date(opens).toISOString(),
      closesAt: new Date(closes).toISOString(),
      settledAt: isPast ? new Date(settled).toISOString() : null,
      // Null until settled — the denominator does not exist yet, and the UI must
      // not print a number that implies it does.
      totalPoints: isPast || isOpen ? dec(4_100_000 + r() * 2_600_000 + i * 900_000) : null,
      participants: isPast || isOpen ? Math.round(900 + r() * 400 + i * 520) : null,
      unlockSchedule: s.ladder.map(([offsetMonths, share]) => ({
        offsetMonths,
        share: dec(share),
      })),
      // Concentration tightens as the venue matures and market makers scale up.
      pointsDistribution:
        isPast || isOpen
          ? decileShares(0.62 + 0.022 * i, r)
          : null,
    };
  });
}

function wireAccountSeasons(ws: WireSeason[]): WireAccountSeason[] {
  return ws
    .filter((w) => w.status !== "upcoming")
    .map((w, i) => {
      const r = rng(seedOf(w.seasonId + "acct"));
      const total = Number(w.totalPoints ?? "0");
      const points = total * (0.0009 + r() * 0.0016);
      const share = total > 0 ? points / total : 0;
      const pool = Number(w.poolNex);
      const settled = w.status === "settled";
      const ent = pool * share;
      // Fraction of that season's ladder that has matured by NOW.
      const vestedShare = settled
        ? w.unlockSchedule
            .filter(
              (t) =>
                new Date(w.settledAt as string).getTime() + t.offsetMonths * MONTH_MS <=
                NOW.getTime(),
            )
            .reduce((a, t) => a + Number(t.share), 0)
        : 0;
      return {
        seasonId: w.seasonId,
        status: w.status,
        points: dec(points, 1),
        rank: Math.max(1, Math.round(180 + r() * 900 - i * 20)),
        shareOfPool: dec(share, 8),
        entitlementNex: settled ? dec(ent) : null,
        estimatedNex: settled ? null : dec(ent),
        vestedNex: dec(ent * vestedShare),
        unvestedNex: dec(ent * (1 - vestedShare)),
        streakMultiplier: dec(Math.min(1.5, 1 + 0.1 * i), 2),
        // Track A scales with the fees this account actually paid, so it tracks
        // their activity in the window rather than the pool. Partial while open.
        trackARebateUsdx: dec(points * 0.0138 * (settled ? 1 : 0.57), 2),
        feesPaidUsd: dec(points * 0.0276 * (settled ? 1 : 0.57), 2),
        // This account leans toward depth: it does best in depth-weighted seasons
        // and worst in pure-volume ones.
        activityMix: mix(0.30 + 0.06 * r(), 0.52 - 0.04 * r(), 0.18),
      };
    });
}

function wireUnlocks(ws: WireSeason[], as: WireAccountSeason[]): WireRewardUnlock[] {
  const byDate = new Map<number, { seasonId: string; amountNex: number }[]>();
  for (const a of as) {
    const w = ws.find((x) => x.seasonId === a.seasonId);
    if (!w || !w.settledAt) continue;
    const ent = Number(a.entitlementNex ?? "0");
    for (const t of w.unlockSchedule) {
      const at = new Date(w.settledAt).getTime() + t.offsetMonths * MONTH_MS;
      const day = new Date(at).setUTCHours(12, 0, 0, 0);
      const arr = byDate.get(day) ?? [];
      arr.push({ seasonId: a.seasonId, amountNex: ent * Number(t.share) });
      byDate.set(day, arr);
    }
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0] - b[0]);
  // Index of the 2nd FUTURE tranche. Pausing by absolute index silently picked a
  // past date, so the state never rendered — the demo has to actually show it.
  const futureIdx = sorted.map(([d]) => d).filter((d) => d > NOW.getTime());
  const pausedDay = futureIdx.length > 1 ? futureIdx[1] : -1;
  return sorted
    .map(([day, sources]) => {
      const amount = sources.reduce((s, x) => s + x.amountNex, 0);
      const past = day <= NOW.getTime();
      // One tranche is deliberately paused, to exercise the state that matters
      // most: nothing is forfeited, the schedule simply has not advanced.
      const paused = day === pausedDay;
      return {
        unlockAt: new Date(day).toISOString(),
        amountNex: dec(amount),
        status: past ? "vested" : paused ? "paused" : "scheduled",
        pausedReason: paused ? "activity_threshold_not_met" : null,
        sources: sources.map((s) => ({ seasonId: s.seasonId, amountNex: dec(s.amountNex) })),
      };
    });
}

// ------------------------------------------------------------------ leaderboard

/** Deterministic 40-hex account address. No name, because the API has no name. */
function address(r: () => number): string {
  let h = "0x";
  for (let i = 0; i < 40; i++) h += "0123456789abcdef"[Math.floor(r() * 16)];
  return h;
}

/**
 * A window of the board around the caller: `radius` above, the caller, `radius`
 * below, clipped at the ends. This is the whole shape of the feature — a top-ten
 * table is a list of accounts that are not you, and it makes the pool look
 * captured. The window is the view that produces "I could pass two of these".
 *
 * Points are synthesised BACKWARD from the caller's own figure so the board and
 * the account card can never disagree: rank r carries the caller's points scaled
 * by its rank distance, which keeps the series strictly decreasing in rank.
 *
 * Null when the caller is unranked: there is no window around an account that
 * does not appear on the board, and inventing one would be a lie about standing.
 */
function wireLeaderboard(
  w: WireSeason,
  a: WireAccountSeason,
  radius = 5,
): WireLeaderboard | null {
  const participants = w.participants ?? 0;
  const myRank = a.rank;
  if (myRank === null || participants === 0) return null;
  const myPoints = Number(a.points);
  const total = Number(w.totalPoints ?? "0");
  const lo = Math.max(1, myRank - radius);
  const hi = Math.min(participants, myRank + radius);

  const entries: WireLeaderboardEntry[] = [];
  for (let rank = lo; rank <= hi; rank++) {
    const self = rank === myRank;
    const r = rng(seedOf(`${w.seasonId}:${rank}`));
    // ~1.9% per rank near the middle of the board, jittered. Positive for ranks
    // above the caller, negative below, so the column is monotonic by construction.
    const points = self
      ? myPoints
      : myPoints * (1 + (myRank - rank) * (0.017 + 0.005 * r()));
    const share = total > 0 ? points / total : 0;
    entries.push({
      rank,
      address: self ? SELF_ADDRESS : address(r),
      points: dec(points, 1),
      shareOfPool: dec(share, 8),
      // A tenth of the window is new this week and has no prior standing.
      rankDelta7d: r() < 0.1 ? null : Math.round((r() - 0.45) * 26),
      isSelf: self,
    });
  }
  return {
    seasonId: w.seasonId,
    participants,
    entries,
    pointsDistribution: w.pointsDistribution,
  };
}

/** The demo account. Truncated for display like every other row — no special case. */
export const SELF_ADDRESS = "0x8d41f27a0c6e5b93d2af10c7e4b8951736ac0e2d";

// ------------------------------------------------------------------ public API

export type SeasonsSnapshot = {
  seasons: Season[];
  accountSeasons: AccountSeason[];
  unlocks: RewardUnlock[];
  /** Per-season boards, keyed by season id. Windowed around the demo account. */
  leaderboards: Record<string, Leaderboard>;
  /** Lifetime Track A rebate paid, in USDX. Separate programme, shown alongside. */
  trackARebateUsdx: number;
};

export function loadSeasons(): SeasonsSnapshot {
  const ws = wireSeasons();
  const wa = wireAccountSeasons(ws);
  const wu = wireUnlocks(ws, wa);
  const accountSeasons = wa.map(parseAccountSeason);
  const leaderboards: Record<string, Leaderboard> = {};
  for (const a of wa) {
    const w = ws.find((x) => x.seasonId === a.seasonId);
    const board = w ? wireLeaderboard(w, a) : null;
    if (board) leaderboards[a.seasonId] = parseLeaderboard(board);
  }
  return {
    seasons: ws.map(parseSeason),
    accountSeasons,
    leaderboards,
    unlocks: wu.map(parseRewardUnlock),
    // Lifetime is the sum of the per-season settlements, not a separate figure —
    // the two must agree or the summary contradicts the matrix.
    trackARebateUsdx: accountSeasons.reduce(
      (a, x) => a + (typeof x.trackARebateUsdx === "number" ? x.trackARebateUsdx : 0),
      0,
    ),
  };
}
