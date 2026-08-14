// Local order-book state, and the rules for when it may be trusted.
//
// The important idea here is not the data structure — it is `isFresh`. A
// trading app's worst outcome is not "no data", it is "old data that still
// looks like data": quoting off a book that stopped updating two minutes ago
// puts an order into a market that has moved on. So the book carries an
// explicit freshness verdict, `trader.ts` refuses to act unless it is fresh,
// and every path that could leave it doubtful — a gap signal, a payload shape
// we do not recognise, a silent socket — marks it stale rather than hoping.
//
// A note on the wire format. The `book` WebSocket channel's payload is
// forwarded **verbatim** by the API and is deliberately not pinned by the
// OpenAPI spec (the official SDKs reproduce it as an opaque value and do not
// reconstruct a book from it either). Rather than guess at a delta encoding
// that may change, this parses the one shape the REST snapshot documents —
// `{bids, asks}` as `[price, size]` pairs — and treats anything else as a
// prompt to re-snapshot over REST. That degrades to "slightly less live" if the
// channel turns out to publish deltas, instead of to a silently wrong book.

import * as dec from "./decimal.js";

export interface Level {
  readonly price: number;
  readonly size: number;
}

export interface TopOfBook {
  readonly bid: Level;
  readonly ask: Level;
  /** Mid as an exact decimal on the market's tick grid. */
  readonly mid: dec.Dec;
}

/** How long a book may go without an update before it stops being tradeable. */
const MAX_BOOK_AGE_MS = 10_000;

/**
 * Coerce one `[price, size]` pair from untrusted JSON.
 *
 * Returns `null` for anything that is not a pair of finite, non-negative
 * numbers. Zero sizes are dropped: on a snapshot they carry no liquidity, and
 * on a delta encoding they conventionally mean "level removed" — either way
 * there is nothing to trade against.
 */
function parseLevel(raw: unknown): Level | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const price = raw[0];
  const size = raw[1];
  if (typeof price !== "number" || typeof size !== "number") return null;
  if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
  if (price <= 0 || size <= 0) return null;
  return { price, size };
}

function parseSide(raw: unknown, descending: boolean): Level[] | null {
  if (!Array.isArray(raw)) return null;
  const levels: Level[] = [];
  for (const entry of raw) {
    const level = parseLevel(entry);
    if (level !== null) levels.push(level);
  }
  // Sort rather than trust the server's ordering: "top of book" is the whole
  // interface this exposes, and reading index 0 of a differently-sorted array
  // is a wrong answer that looks entirely plausible.
  levels.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  return levels;
}

export interface ParsedBook {
  readonly bids: readonly Level[];
  readonly asks: readonly Level[];
}

/** Parse the documented `{bids, asks}` shape, or `null` if that is not what this is. */
export function parseBook(raw: unknown): ParsedBook | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as { bids?: unknown; asks?: unknown };
  const bids = parseSide(candidate.bids, true);
  const asks = parseSide(candidate.asks, false);
  if (bids === null || asks === null) return null;
  return { bids, asks };
}

export type FrameOutcome =
  /** Applied; the book advanced. */
  | "applied"
  /** Older than what we hold — a replay overlap. Ignored. */
  | "duplicate"
  /** Not a shape we can apply. The caller should re-snapshot over REST. */
  | "unrecognised";

export class OrderBookState {
  private bids: readonly Level[] = [];
  private asks: readonly Level[] = [];
  private updatedAt = 0;
  private lastSeq: bigint | null = null;
  private trusted = false;
  /** Set when something told us continuity was lost; cleared by a snapshot. */
  private gapped = false;

  constructor(
    readonly market: string,
    /** Tick size, for putting the mid on the venue's own price grid. */
    private readonly tickSize: dec.Dec,
  ) {}

  /**
   * Replace the book wholesale from a REST snapshot.
   *
   * A snapshot is the only thing that clears the gap flag: it is the one source
   * that is complete by construction rather than by accumulation.
   */
  applySnapshot(book: ParsedBook): void {
    this.bids = book.bids;
    this.asks = book.asks;
    this.updatedAt = Date.now();
    this.trusted = true;
    this.gapped = false;
  }

  /**
   * Apply one streamed frame.
   *
   * `seq` is monotonic per (channel, market) but the contract does not promise
   * it is contiguous, so a jump is deliberately *not* treated as a gap — the
   * server signals real gaps explicitly with an `out_of_sync` frame, and
   * inventing gap detection here would only produce false re-snapshots. What is
   * checked is the direction: a frame at or below the last sequence is a replay
   * overlap after a reconnect and must not be applied on top of newer state.
   */
  applyFrame(seq: bigint, payload: unknown): FrameOutcome {
    if (this.lastSeq !== null && seq <= this.lastSeq) return "duplicate";

    const book = parseBook(payload);
    if (book === null) return "unrecognised";

    this.lastSeq = seq;
    this.bids = book.bids;
    this.asks = book.asks;
    this.updatedAt = Date.now();
    this.trusted = !this.gapped;
    return "applied";
  }

  /** The resume cursor to ask the server to replay from, if we have one. */
  get resumeCursor(): bigint | null {
    return this.lastSeq;
  }

  /**
   * Record that continuity was lost — an `out_of_sync`, a dropped frame, a
   * reconnect. The book keeps its contents (they are still the best guess for
   * display) but stops being tradeable until a snapshot replaces them.
   */
  markGap(): void {
    this.gapped = true;
    this.trusted = false;
  }

  /** Forget the cursor, so the next subscribe resumes from the live edge. */
  resetCursor(): void {
    this.lastSeq = null;
  }

  /**
   * Whether the book may be traded against: complete, uncrossed, and recent.
   *
   * The crossed check is not paranoia about the venue — it is a guard against
   * *us*. A book assembled from frames we half-understood can cross, and a
   * crossed book yields a mid that sits inside no real spread. Refusing to
   * quote off it costs nothing; quoting off it is an instant fill at a price
   * that was never on the screen.
   */
  isFresh(now = Date.now()): boolean {
    if (!this.trusted || this.gapped) return false;
    if (now - this.updatedAt > MAX_BOOK_AGE_MS) return false;
    const top = this.rawTop();
    if (top === null) return false;
    return top.bid.price < top.ask.price;
  }

  get ageMs(): number {
    return this.updatedAt === 0 ? Infinity : Date.now() - this.updatedAt;
  }

  private rawTop(): { bid: Level; ask: Level } | null {
    const bid = this.bids[0];
    const ask = this.asks[0];
    if (bid === undefined || ask === undefined) return null;
    return { bid, ask };
  }

  /**
   * Top of book with an exact mid, or `null` when either side is empty.
   *
   * The mid is computed on the tick grid rather than in floating point: the two
   * prices are snapped to ticks first, and the halved sum is floored back onto
   * a tick. That keeps every downstream price an exact multiple of the tick,
   * which is what the venue will accept — and it means the value shown on
   * screen is the value an order would actually carry.
   */
  top(): TopOfBook | null {
    const raw = this.rawTop();
    if (raw === null) return null;
    const scale = this.tickSize.scale;
    const bid = dec.fromNumber(raw.bid.price, scale);
    const ask = dec.fromNumber(raw.ask.price, scale);
    const sum = dec.add(bid, ask);
    // `applyBps(sum, 5000)` is `sum × 0.5`, exactly, then floored to a tick.
    const mid = dec.quantise(dec.applyBps(sum, 5_000), this.tickSize, "floor");
    return { bid: raw.bid, ask: raw.ask, mid };
  }

  get depth(): { bids: number; asks: number } {
    return { bids: this.bids.length, asks: this.asks.length };
  }
}
