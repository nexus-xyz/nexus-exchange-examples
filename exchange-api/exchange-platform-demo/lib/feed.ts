/*
 * The mock feed — now emitting wire shapes.
 *
 * Turns (market, tick, grouping) into the shapes the panels render: candles, an
 * order book, a trades tape, and a funding history. Pure functions — no state,
 * no effects — so a panel can be rendered at any tick for a screenshot.
 *
 * Convention: fixed history + a breathing tail. History is seeded off the symbol
 * alone so it never rewrites itself; only the last candle, the book, and the tape
 * move with the tick.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THIS BECAME CONTRACT-SHAPED
 *
 * The PRNG is unchanged — same mulberry32, same seeds, still no Math.random and
 * no Date.now, so a given (symbol, tick) renders one and only one frame. What
 * changed is the pipeline:
 *
 *     PRNG ──► wire payloads (lib/api/types.ts) ──► adapter ──► Feed (UI)
 *
 * The generators below produce EXACTLY what the endpoint would return:
 *   wireCandles      → GET /markets/{id}/candles      [ts,o,h,l,c,v] tuples, NUMBERS
 *   wireOrderBook    → GET /markets/{id}/orderbook    [price,amount] pairs, NUMBERS
 *   wireTrades       → GET /markets/{id}/trades       CCXT trades, NUMBERS
 *   wireTicker       → GET /markets/{id}/ticker       CCXT ticker, NUMBERS
 *   wireFundingSamples → GET /markets/{id}/funding    FundingSample, DECIMAL STRINGS
 *   wireMarkPrice    → GET /markets/{id}/mark-price   DECIMAL STRING
 *
 * `buildFeed` then parses those through lib/api/adapter.ts, which is the same
 * code path a live response would take. Swapping the mock for the real venue is
 * deleting the generators and awaiting `fetch` — the adapter and every component
 * below it stay put.
 *
 * Precision is derived from the market's real `tick_size` / `lot_size`. Prices
 * land on the tick grid and sizes on the lot grid, so no level, print, or candle
 * in this mock is at a price or size the engine would reject.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { comma, rng, seedOf } from "./format";
import type { Market } from "./markets";
import { decimalsFor } from "./markets";
import {
  dec,
  decFromNumber,
  parseCandles,
  parseFundingSample,
  parseOrderBook,
  parsePublicTrade,
  parseTicker,
  type UiCandle,
} from "./api/adapter";
import { TIMEFRAME_SECONDS, type Timeframe } from "./api/enums";
import { snapToLot, snapToTick } from "./api/markets";
import type {
  WireBookLevel,
  WireCandle,
  WireFundingSample,
  WireMarkPrice,
  WireOrderBook,
  WirePublicTrade,
  WireTicker,
} from "./api/types";

/** UI candle. `ts` added so a chart can label a real time axis. */
export type Candle = { ts: number; o: number; h: number; l: number; c: number; v: number };

export type BookRow = {
  /** Formatted at the market's tick precision. */
  price: string;
  /** Raw numeric price, for click-to-price on the ticket. Always on the tick grid. */
  px: number;
  size: string;
  /** Raw numeric size, on the lot grid. */
  sz: number;
  /** Cumulative size from the top of book. */
  total: string;
  /** Cumulative size, numeric. */
  cum: number;
  /** Cumulative depth as a percent of the deepest level, for the bar. */
  depth: number;
  /**
   * The tick this level's size last changed.
   *
   * Two uses, and the second is why it is a tick rather than a boolean. `fresh` says
   * "flash now"; `seq` is what a React key is built from, so the flash element
   * REMOUNTS on a change and the CSS animation restarts. A class toggled on a live
   * element does not replay — the same trick `useFlash` uses on the price.
   */
  seq: number;
  /** True on the tick this level changed, for either reason. */
  fresh: boolean;
  /**
   * True when the change was a MATCH — a taker sweeping this side from the touch —
   * rather than a quote update. Drawn brighter, because it is a different event.
   */
  matched: boolean;
};

export type Trade = {
  price: string;
  px: number;
  size: string;
  sz: number;
  time: string;
  /** Wire timestamp (ms). Deterministic — derived from the tick, not the clock. */
  ts: number;
  /** true = buy aggressor. Equivalent to the wire's `side === "buy"`. */
  up: boolean;
};

export type Feed = {
  candles: Candle[];
  last: number;
  bids: BookRow[];
  /** Ordered far → near, i.e. ready to render above the mid. */
  asks: BookRow[];
  spread: number;
  spreadBps: number;
  trades: Trade[];
  /** Per-interval funding rate history, in PERCENT (0.012 means 0.012%). */
  funding: number[];
  /** Engine fills/second, breathing with the tick. */
  fillsPerSec: number;
  /**
   * Oracle (index) price. Shown beside the mark so the basis is visible — the
   * mark is what the engine trades at, the oracle is what it is benchmarked to,
   * and the gap between them is the thing a trader actually watches.
   */
  oracle: number;
  /** Seconds until the next funding settlement. */
  fundingIn: number;
  /**
   * The untouched wire payloads this frame was parsed from. Not used for
   * rendering — kept so a panel (or a test) can assert against the contract
   * rather than against the UI model.
   */
  wire: {
    candles: WireCandle[];
    orderbook: WireOrderBook;
    trades: WirePublicTrade[];
    funding: WireFundingSample[];
    ticker: WireTicker;
    markPrice: WireMarkPrice;
  };
};

/**
 * Wall-clock anchor. Taken from the openapi.json candle example
 * (1776033900000 = 2026-04-12T22:45:00Z) so mock timestamps look like the ones
 * the real venue emits. A FIXED constant, never Date.now() — the server render
 * and the first client render must agree or React throws a hydration error.
 */
export const EPOCH_MS = 1776033900000;

/** Wall-clock seconds per UI tick. */
const TICK_SEC = 1.1;
export const TICK_MS = TICK_SEC * 1000;

/** The chart's timeframe. `1m` is the API default and one of only four legal values. */
export const DEFAULT_TIMEFRAME: Timeframe = "1m";

const CANDLES = 64;
const BOOK_LEVELS = 13;
const TAPE_ROWS = 22;
const FUNDING_BARS = 56;

/** Deterministic "now" for a tick. */
export const tickTime = (tick: number) => EPOCH_MS + Math.round(tick * TICK_MS);

/** ISO-8601 for a ms timestamp. CCXT payloads carry both forms. */
const isoOf = (ms: number) => new Date(ms).toISOString();

/** hh:mm:ss (UTC) from a ms timestamp, by arithmetic — no locale, no TZ drift. */
function hms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/** mm:ss (UTC) from a ms timestamp — the tape's compact form. */
function ms_mmss(ms: number): string {
  return hms(ms).slice(3);
}

/**
 * Size decimals for a market — from `lot_size`.
 *
 * Was a magnitude heuristic (`ref > 10000 ? 4 : ...`). That is now the market's
 * real lot precision: DOGE trades in lots of 100 (0 decimals), BTC in 0.001
 * (3 decimals). Kept exported under the old name because the order ticket imports
 * it from here.
 */
export function sizeDecimals(m: Market): number {
  return m.sizeDp;
}

/** Dollar notional resting on a typical level, by liquidity tier. */
const TIER_LEVEL_NOTIONAL: Record<1 | 2 | 3 | 4, number> = { 1: 26000, 2: 14000, 3: 6000, 4: 2200 };

/** A size in base units, snapped to lot and never below one lot. */
function lotSize(m: Market, units: number): number {
  const snapped = snapToLot(m.wire, units);
  return snapped > 0 ? snapped : m.lotSize;
}

// ───────────────────────────────────────────────────────── wire generators

/**
 * `GET /markets/{id}/candles` — `[ts, o, h, l, c, v][]`, JSON numbers.
 *
 * Fixed history seeded off the symbol, plus a tail that wobbles with the tick.
 * Every OHLC value is snapped to the market's tick.
 */
export function wireCandles(m: Market, tick: number, timeframe: Timeframe = DEFAULT_TIMEFRAME): WireCandle[] {
  const R = rng(seedOf(m.sym + ":candles"));
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  /*
   * The timeframe has to move the PRICES, not just the axis labels.
   *
   * `stepMs` used to scale the timestamps alone, so 1s and 1h drew the identical 64
   * candles under different time labels — the control looked like it worked and the
   * data underneath it never changed. Two things scale with the window:
   *
   *   • Volatility, as the square root of time. That is the random walk's own law:
   *     a bar covering 3600× the interval has ~60× the range, not 3600×.
   *   • How much of the 24h move the window can contain. 64 one-second bars are 64
   *     seconds of history and cannot show a whole day's change; 64 hourly bars are
   *     more than two days and show all of it.
   */
  const tfScale = Math.sqrt(TIMEFRAME_SECONDS[timeframe] / TIMEFRAME_SECONDS[DEFAULT_TIMEFRAME]);
  // Volatility scales with price so the same walk reads correctly at any magnitude.
  const vol = m.ref * 0.0019 * tfScale;
  const covered = Math.min(1, (CANDLES * stepMs) / 86_400_000);
  const now = tickTime(tick);
  const snap = (v: number) => snapToTick(m.wire, v);

  const out: WireCandle[] = [];
  let p = m.ref * (1 - (m.chg24 / 100) * covered);
  for (let i = 0; i < CANDLES; i++) {
    const o = p;
    // Drift the walk toward the reference price so the series lands near `ref`.
    p = p + (R() - 0.47) * vol * 2 + (m.ref - p) * 0.03;
    const c = p;
    const wick = R() * vol;
    const h = Math.max(o, c) + wick;
    const l = Math.min(o, c) - R() * vol;
    // Candle volume in base units: notional / price, so a 1 BTC bar and a
    // 2.4M JPY bar are the same money.
    const v = lotSize(m, (TIER_LEVEL_NOTIONAL[m.tier] * (1.5 + R() * 3)) / Math.max(1e-9, c));
    out.push([now - (CANDLES - 1 - i) * stepMs, snap(o), snap(h), snap(l), snap(c), v]);
  }

  // Breathe the last bar with the tick. Only the tail moves.
  const tail = out[out.length - 1];
  const wob = Math.sin(tick * 0.5) * vol + (rng(seedOf(m.sym) + tick)() - 0.5) * vol;
  const o = tail[1];
  const c = snap(o + wob);
  out[out.length - 1] = [
    tail[0],
    o,
    snap(Math.max(tail[2], c + vol * 0.3)),
    snap(Math.min(tail[3], c - vol * 0.3)),
    c,
    tail[5],
  ];
  return out;
}

/**
 * When level `i` refreshes.
 *
 * THE BOOK PERSISTS BETWEEN TICKS. It used to be redrawn whole from
 * `rng(seed + tick * 7)` every second — every price and every size, all thirteen
 * levels, all at once. Two things follow from that and both are wrong:
 *
 *   · A real book does not rewrite itself every second. The deep levels sit there for
 *     minutes; the churn is at the touch.
 *   · Nothing can be highlighted ON CHANGE, because everything changed. The reference
 *     flashes the rows that just traded or refreshed, which is the single most useful
 *     thing a book can show you, and it is only legible because the other rows held
 *     still.
 *
 * So each level has its own cadence, and it gets faster the closer to the touch you
 * are: level 0 refreshes every other tick, the back of the book roughly every ten. The
 * phase is seeded per level so the whole ladder does not update in lockstep.
 */
function refreshPeriod(i: number) {
  return 2 + Math.floor(i * 0.7);
}

/**
 * A taker sweep at tick `s`, or null.
 *
 * THE TWO SIDES ARE NOT SYMMETRIC, and matches are not per-level events.
 *
 * The first version keyed each level's phase on `sym:lvl:i` with no side in it, so bid
 * level 3 and ask level 3 shared a period AND a phase and always refreshed on the same
 * tick. The book flashed in mirror image — every bright row on the left had a twin at
 * the same height on the right, as though every trade were one bid matching one ask.
 * No book does that. A match consumes liquidity on ONE side.
 *
 * So there are two kinds of change now, and they are different events:
 *
 *   · a QUOTE UPDATE — one level restated, an order added or pulled. Independent per
 *     side, faster near the touch. The common case.
 *   · a MATCH — a taker crossing the spread and eating the top `depth` levels of one
 *     side. Clustered at the touch, asymmetric by construction, and rarer.
 *
 * Which is what makes the second one worth showing differently: a sweep of the top two
 * asks is the book telling you someone just bought, and a lone level restating itself
 * three rows down is not.
 */
function sweepAt(sym: string, s: number): { dir: number; depth: number } | null {
  const h = seedOf(`${sym}:sweep:${s}`);
  // Roughly one tick in four carries a sweep. Sparse enough that a cluster reads as an
  // event rather than as the background rate.
  if (h % 4 !== 0) return null;
  return {
    dir: (h >>> 3) % 2 === 0 ? -1 : 1,
    // One to three levels. A sweep deeper than the visible book would just look like
    // the whole side repainting, which is the thing this replaced.
    depth: 1 + ((h >>> 5) % 3),
  };
}

/** True when level `i` on side `dir` changes at tick `s`, for either reason. */
function refreshesAt(sym: string, dir: number, i: number, s: number): boolean {
  const sweep = sweepAt(sym, s);
  if (sweep && sweep.dir === dir && i < sweep.depth) return true;
  const period = refreshPeriod(i);
  // `dir` in the seed: without it the two sides share a phase and flash in mirror.
  const phase = seedOf(`${sym}:lvl:${dir}:${i}`) % period;
  return ((s % period) + period) % period === phase;
}

/** True when the change at tick `s` was a MATCH rather than a quote update. */
function matchedAt(sym: string, dir: number, i: number, s: number): boolean {
  const sweep = sweepAt(sym, s);
  return Boolean(sweep && sweep.dir === dir && i < sweep.depth);
}

/**
 * The most recent tick at or before `tick` when level `i` changed.
 *
 * Pure, and therefore replayable: the size a level shows is a function of the tick it
 * last changed, not of any accumulated state, so two loads of `?tick=7` still produce
 * byte-identical books. Bounded so this cannot walk backwards forever.
 */
function lastRefresh(sym: string, dir: number, i: number, tick: number): number {
  const limit = refreshPeriod(i) + 1;
  for (let s = tick; s > tick - limit; s--) if (refreshesAt(sym, dir, i, s)) return s;
  return tick;
}

/** One side of the book as `[price, amount]` pairs. `dir` is -1 bids, +1 asks. */
function wireSide(m: Market, last: number, grouping: number, tick: number, dir: number): WireBookLevel[] {
  const perLevel = TIER_LEVEL_NOTIONAL[m.tier];
  // The grouping is always a decade multiple of tick_size (see groupingsFor), so
  // a level placed on the grouping grid is on the tick grid by construction.
  const step = Math.max(grouping, m.tickSize);
  /*
   * The ladder's SHAPE is seeded on the symbol and the side, not on the tick, so the
   * gaps between levels are a property of this market rather than of this second. The
   * whole ladder translates as the mid moves, which is what a book does.
   */
  const shape = rng(seedOf(`${m.sym}:shape:${dir}`));
  const out: WireBookLevel[] = [];
  /*
   * Distance from the touch ACCUMULATES. It used to be computed per level as
   * `round((i + 0.5) * (1 + R() * 0.9))`, which draws a fresh multiplier every time —
   * so level 7 could land nearer the touch than level 6, and the ladder came back
   * non-monotonic: `…287.0, 287.5, 287.0, 284.0, 285.5, 283.0…` on the bid side.
   *
   * That is not cosmetic. This function's own contract, below in `wireOrderBook`, is
   * "bids best-first descending, asks best-first ascending" — a consumer is entitled to
   * stop at the first level past its limit. And a book whose prices go backwards is the
   * kind of thing a reader of a specification would reasonably implement.
   */
  let steps = 0;
  for (let i = 0; i < BOOK_LEVELS; i++) {
    // At least one step per level, and a random extra — gaps where liquidity is thin,
    // but always further out than the level before it.
    steps += 1 + Math.round(shape() * 1.7);
    const px = snapToTick(m.wire, last + dir * steps * step);
    // Size is derived from dollar notional, so 0.4 BTC and 12,000 EUR are the same
    // depth. Levels thicken away from the touch — a normal book. Drawn from the tick
    // this level last refreshed, so it HOLDS between refreshes.
    const R = rng(seedOf(`${m.sym}:sz:${dir}:${i}`) + lastRefresh(m.sym, dir, i, tick) * 991);
    /*
     * Converted at the market's REFERENCE price, not at `last`.
     *
     * `last` moves every tick, so dividing by it made every size move every tick even
     * when the level had not refreshed — measured at 11 to 13 of 13 levels changing
     * per second, which defeats the refresh cadence entirely and would make the match
     * flash fire on the whole book.
     *
     * It is also just wrong: a resting order is a quantity of the instrument. It does
     * not shrink because the mid ticked up.
     */
    const sz = lotSize(m, (perLevel * (0.35 + R() * 1.3) * (1 + i * 0.14)) / Math.max(1e-9, m.ref));
    out.push([px, sz]);
  }
  return out;
}

/**
 * `GET /markets/{id}/orderbook` — CCXT shape: bids best-first descending, asks
 * best-first ascending, `nonce` monotonic in the tick so a diff consumer can gap-detect.
 */
export function wireOrderBook(m: Market, tick: number, grouping: number, last: number): WireOrderBook {
  const bids = wireSide(m, last, grouping, tick, -1);
  const asks = wireSide(m, last, grouping, tick, 1);
  const ts = tickTime(tick);
  return {
    symbol: m.sym,
    bids,
    asks,
    timestamp: ts,
    datetime: isoOf(ts),
    nonce: 1000 + tick,
  };
}

/** `GET /markets/{id}/trades` — CCXT public tape, newest first. */
export function wireTrades(m: Market, tick: number, grouping: number, last: number): WirePublicTrade[] {
  const RT = rng(seedOf(m.sym + ":tape") + tick * 11);
  const now = tickTime(tick);
  return Array.from({ length: TAPE_ROWS }, (_, i) => {
    const buy = RT() > 0.5;
    const px = snapToTick(m.wire, last + (RT() - 0.5) * Math.max(grouping, m.tickSize) * 12);
    // Prints are a fraction of a resting level — most fills are small.
    const amount = lotSize(m, (TIER_LEVEL_NOTIONAL[m.tier] * (0.04 + RT() * 0.5)) / Math.max(1e-9, last));
    // Timestamps march backwards from now at a seeded cadence, so the tape has a
    // believable arrival pattern without touching the clock.
    const ts = now - Math.round(i * (400 + RT() * 2600));
    return {
      // Deterministic pseudo-uuid: the wire says uuid, and a stable id per row
      // keeps React keys stable across re-renders of the same tick.
      id: `${m.base.toLowerCase()}-${tick}-${i}`,
      symbol: m.sym,
      price: px,
      amount,
      cost: px * amount,
      side: buy ? "buy" : "sell",
      timestamp: ts,
      datetime: isoOf(ts),
      takerOrMaker: "taker",
      is_liquidation: false,
      info: {},
    } satisfies WirePublicTrade;
  });
}

/**
 * `GET /markets/{id}/funding` — `FundingSample[]`, DECIMAL STRINGS.
 *
 * Note the units flip: the wire carries a RATIO (`"0.000000016"`), while every
 * funding display in this app is in percent. The ratio is generated here and the
 * adapter does the ×100 exactly once.
 */
export function wireFundingSamples(m: Market, tick: number): WireFundingSample[] {
  const RF = rng(seedOf(m.sym + ":funding"));
  // The engine clamps |rate| to the market's funding_rate_cap, so the mock does too.
  const cap = Number(m.wire.extra.funding_rate_cap);
  const stepMs = m.fundingIntervalS * 1000;
  const now = tickTime(tick);
  const out: WireFundingSample[] = [];
  /* The walk's scale is the authority for funding across the whole app: its stationary
     magnitude is recorded as `FUNDING_TYPICAL_FRACTION` in markets.ts, and the
     per-market fixture in `getStats` is scaled by that constant so the header and the
     market switcher cannot disagree about the same market. If the step or the pull
     below changes, re-measure the constant. */
  let f = cap * 0.04;
  for (let i = 0; i < FUNDING_BARS; i++) {
    // Mean-revert toward zero. A pure random walk drifts to one sign and stays
    // there, so the history never shows the flip between longs and shorts paying
    // — which is the only thing this chart exists to show.
    f += (RF() - 0.5) * cap * 0.11 - f * 0.22;
    f = Math.max(-cap, Math.min(cap, f));
    const isLast = i === FUNDING_BARS - 1;
    const rate = isLast ? Math.max(-cap, Math.min(cap, f + Math.sin(tick * 0.4) * cap * 0.04)) : f;
    const mark = m.ref * (1 + rate * 20);
    out.push({
      timestamp: now - (FUNDING_BARS - 1 - i) * stepMs,
      // 9 dp: the spec's own example rate is "0.000000016", so anything coarser
      // would round a real rate to zero.
      funding_rate: decFromNumber(rate, 9),
      premium_index: decFromNumber(rate * 260, 6),
      mark_price: decFromNumber(snapToTick(m.wire, mark), m.priceDp),
      oracle_price: decFromNumber(snapToTick(m.wire, m.ref), m.priceDp),
    });
  }
  return out;
}

/** `GET /markets/{id}/ticker` — CCXT ticker, JSON numbers. */
export function wireTicker(
  m: Market,
  tick: number,
  candles: UiCandle[],
  best: { bid: number | null; ask: number | null; bidSz: number | null; askSz: number | null },
  oracle: number,
): WireTicker {
  const ts = tickTime(tick);
  const last = candles.length ? candles[candles.length - 1].c : m.ref;
  const open = candles.length ? candles[0].o : m.ref;
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const baseVolume = candles.reduce((a, c) => a + c.v, 0);
  return {
    symbol: m.sym,
    timestamp: ts,
    datetime: isoOf(ts),
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    bid: best.bid,
    bidVolume: best.bidSz,
    ask: best.ask,
    askVolume: best.askSz,
    open,
    close: last,
    last,
    change: last - open,
    // CCXT `percentage` is a PERCENT, not a ratio.
    percentage: open ? ((last - open) / open) * 100 : null,
    baseVolume,
    quoteVolume: baseVolume * last,
    // The mark is the engine's (oracle + premium index); `last` is the raw print.
    // They are deliberately different numbers here, as they are on the venue.
    markPrice: last,
    indexPrice: oracle,
    info: {},
  };
}

/** `GET /markets/{id}/mark-price` — decimal STRING, unlike the CCXT routes. */
export function wireMarkPrice(m: Market, mark: number): WireMarkPrice {
  return { market_id: m.sym, mark_price: decFromNumber(snapToTick(m.wire, mark), m.priceDp) };
}

// ─────────────────────────────────────────────────────────────── UI assembly

/** Cumulative-depth ladder rows from wire levels, nearest-touch first. */
function ladder(m: Market, levels: { px: number; sz: number }[], tick: number, dir: number): BookRow[] {
  const d = decimalsFor(m);
  const szDec = m.sizeDp;
  let cum = 0;
  const rows = levels.map((l) => {
    cum += l.sz;
    return { ...l, cum };
  });
  const max = rows.length ? rows[rows.length - 1].cum : 1;
  return rows.map((r, i) => ({
    seq: lastRefresh(m.sym, dir, i, tick),
    fresh: lastRefresh(m.sym, dir, i, tick) === tick,
    matched: matchedAt(m.sym, dir, i, tick),
    price: comma(r.px, d),
    px: r.px,
    size: comma(r.sz, szDec),
    sz: r.sz,
    total: comma(r.cum, Math.max(0, szDec - 1)),
    cum: r.cum,
    depth: (r.cum / (max || 1)) * 100,
  }));
}

export function buildFeed(
  m: Market,
  tick: number,
  grouping: number,
  /*
   * The chart's timeframe.
   *
   * This parameter did not exist, and `wireCandles` was called without one — so it
   * fell to its own `DEFAULT_TIMEFRAME` on every call and the 1s / 1m / 5m / 1h
   * control changed nothing but the "TF 1m" text beside it. `wireCandles` has always
   * honoured the argument; nothing ever passed it.
   */
  timeframe: Timeframe = DEFAULT_TIMEFRAME,
): Feed {
  // 1. Generate the wire payloads.
  const wCandles = wireCandles(m, tick, timeframe);
  const candles = parseCandles(wCandles);
  const last = candles.length ? candles[candles.length - 1].c : m.ref;

  const wBook = wireOrderBook(m, tick, grouping, last);
  const book = parseOrderBook(wBook);

  const wTrades = wireTrades(m, tick, grouping, last);
  const wFunding = wireFundingSamples(m, tick);

  // Oracle tracks the mark within a few basis points, drifting on its own clock —
  // a constant offset would read as a rounding artifact rather than a basis.
  const oracle = last * (1 + Math.sin(tick * 0.17 + (seedOf(m.sym) % 7)) * 0.00035);

  const wTicker = wireTicker(
    m,
    tick,
    candles,
    {
      bid: book.bestBid,
      ask: book.bestAsk,
      bidSz: book.bids.length ? book.bids[0].sz : null,
      askSz: book.asks.length ? book.asks[0].sz : null,
    },
    oracle,
  );

  // 2. Parse them back through the same adapter a live response would use.
  const ticker = parseTicker(wTicker);
  const trades = wTrades.map(parsePublicTrade);
  const funding = wFunding.map(parseFundingSample);

  const spread = book.spread ?? m.tickSize;

  return {
    candles,
    last,
    bids: ladder(m, book.bids, tick, -1),
    // The wire sends asks best-first ascending; a ladder renders them far → near.
    asks: ladder(m, book.asks, tick, 1).slice().reverse(),
    spread,
    spreadBps: (spread / (last || 1)) * 10000,
    trades: trades.map((t) => ({
      price: comma(t.px, m.priceDp),
      px: t.px,
      size: comma(t.sz, m.sizeDp),
      sz: t.sz,
      time: ms_mmss(t.ts),
      ts: t.ts,
      up: t.up,
    })),
    // `ratePct` — the adapter has already converted the wire's ratio to percent.
    funding: funding.map((f) => f.ratePct),
    fillsPerSec: 5.4 + Math.sin(tick * 0.31) * 1.1 + rng(seedOf(m.sym) + tick * 3)() * 0.6,
    oracle: ticker.index ?? oracle,
    // Real funding interval from the registry — 3600s on every market. The old
    // mock counted down from 8h, which is Binance's cadence, not this venue's.
    fundingIn: Math.round(m.fundingIntervalS - ((tick * TICK_SEC) % m.fundingIntervalS)),
    wire: {
      candles: wCandles,
      orderbook: wBook,
      trades: wTrades,
      funding: wFunding,
      ticker: wTicker,
      markPrice: wireMarkPrice(m, ticker.mark ?? last),
    },
  };
}

/** Engine heartbeat bars — 22 activity levels that re-roll each tick. */
export function heartbeat(tick: number): number[] {
  const R = rng(900 + tick);
  return Array.from({ length: 22 }, () => 0.2 + R() * 0.8);
}

/** Re-exported so a caller can hand-build a Decimal fixture without a second import. */
export { dec, hms };
