// The replica: one market's book, the sequence it is at, and whether to trust it.
//
// Three rules carry the whole design.
//
// **1. Sequence is the only ordering there is.** Book frames carry no timestamp
// (ENG-15966), so "newer" can only mean "higher sequence". A frame at or below
// the replica's sequence is stale — a redelivery, or a REST snapshot that has
// already overtaken it — and is dropped, however recently it arrived.
//
// **2. A sequence jump is not a gap.** The indexer's book sequence is
// `max(engine_sequence, previous + 1)`: a poll-produced frame advances it by
// one, and a fill-time frame jumps it to the engine's *global* event sequence,
// which moves for every market. Treating `seq > last + 1` as loss would
// re-snapshot on every trade. Jumps are counted, for the reader to see; gaps
// are what the server says they are (`gap`, `out_of_sync`) plus what this
// client knows it missed (a reconnect, a silence).
//
// **3. A gap does not corrupt a snapshot replica — but it is still a resync.**
// Every frame is a complete top-of-book, so the next one after a gap repairs
// the book on its own. The replica still re-fetches REST at once, because
// "the next frame" may be a second away and the replica is the thing a reader
// would quote from. What a gap *does* corrupt is any history derived from the
// book — which is why it is surfaced, not absorbed.

import * as dec from "./decimal.js";
import type { BookSnapshot, Level } from "./frames.js";

export type Source = "stream" | "rest";

export type ApplyOutcome =
  | { readonly result: "applied"; readonly jump: bigint; readonly changed: boolean }
  | { readonly result: "stale"; readonly held: bigint }
  /** The frame carried no sequence. Applied, but it makes the ordering unverifiable. */
  | { readonly result: "unsequenced"; readonly changed: boolean };

export interface Top {
  readonly bid: Level | undefined;
  readonly ask: Level | undefined;
  /** `ask - bid`, exact; `null` when a side is empty. Negative means crossed. */
  readonly spread: dec.Dec | null;
}

export class Replica {
  private book: BookSnapshot = { bids: [], asks: [] };
  private seqValue: bigint | null = null;
  private sourceValue: Source | null = null;
  /** Local arrival time of the last applied book — the only clock the frames allow. */
  private appliedAt = 0;
  /** Set by anything that lost continuity; cleared only by a REST snapshot. */
  private resyncing = true;

  constructor(readonly market: string) {}

  /**
   * Apply a complete snapshot, if it advances the replica.
   *
   * Content that has not changed still advances the sequence: the poller
   * republishes every cycle whether or not anything moved, and a replica that
   * refused those would drift behind REST's `nonce` and never cross-check as
   * equal.
   */
  apply(
    seq: bigint | null,
    book: BookSnapshot,
    source: Source,
    now = Date.now(),
    /** Replace even at an equal sequence — only for a REST read that contradicted the replica. */
    force = false,
  ): ApplyOutcome {
    const held = this.seqValue;
    if (seq !== null && held !== null && (seq < held || (seq === held && !force))) {
      return { result: "stale", held };
    }
    const jump = seq !== null && held !== null ? seq - held : 1n;
    const changed = !sameBook(this.book, book);
    this.book = book;
    if (seq !== null) this.seqValue = seq;
    this.sourceValue = source;
    this.appliedAt = now;
    if (source === "rest") this.resyncing = false;
    return seq === null ? { result: "unsequenced", changed } : { result: "applied", jump, changed };
  }

  /**
   * Record lost continuity. The book keeps its contents — still the best guess
   * for display — but is flagged until a REST snapshot replaces it.
   */
  markResyncing(): void {
    this.resyncing = true;
  }

  /**
   * End a resync without replacing the book: REST answered with a snapshot
   * *older* than one the stream has since delivered. Every frame is complete,
   * so the newer stream frame is the repair — overwriting it with the older
   * REST read would be the one wrong move available.
   */
  resyncSatisfiedByStream(): void {
    this.resyncing = false;
  }

  /**
   * Forget the sequence, so the next frame is accepted whatever it says.
   *
   * Used only when the stream's numbering evidently restarted (an indexer
   * restart resets its projection to zero). Without this, a replica that had
   * seen sequence 90,000 would refuse every frame of the restarted indexer as
   * stale — and go silent while traffic was still arriving.
   */
  resetSequence(): void {
    this.seqValue = null;
  }

  get seq(): bigint | null {
    return this.seqValue;
  }

  get source(): Source | null {
    return this.sourceValue;
  }

  get isResyncing(): boolean {
    return this.resyncing;
  }

  get snapshot(): BookSnapshot {
    return this.book;
  }

  ageMs(now = Date.now()): number {
    return this.appliedAt === 0 ? Infinity : now - this.appliedAt;
  }

  top(): Top {
    const bid = this.book.bids[0];
    const ask = this.book.asks[0];
    const spread = bid !== undefined && ask !== undefined ? dec.subtract(ask.price, bid.price) : null;
    return { bid, ask, spread };
  }

  /** Crossed or locked: a best bid at or above the best ask. Never true of a sane venue book. */
  get isCrossed(): boolean {
    const { spread } = this.top();
    return spread !== null && !dec.isPositive(spread);
  }
}

function sameSide(a: readonly Level[], b: readonly Level[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((level, i) => {
    const other = b[i];
    return other !== undefined && dec.equals(level.price, other.price) && dec.equals(level.size, other.size);
  });
}

function sameBook(a: BookSnapshot, b: BookSnapshot): boolean {
  return sameSide(a.bids, b.bids) && sameSide(a.asks, b.asks);
}

// ── Cross-check ─────────────────────────────────────────────────────────────

/** A REST level as it came off the wire: two doubles. Kept raw for `sameAsDouble`. */
export interface RestLevel {
  readonly price: number;
  readonly size: number;
}

export interface RestBook {
  readonly nonce: bigint | null;
  readonly bids: readonly RestLevel[];
  readonly asks: readonly RestLevel[];
}

export type CrossCheck =
  /** Same sequence, same levels. The only verdict that proves anything. */
  | { readonly verdict: "match"; readonly seq: bigint; readonly levels: number }
  /** Same sequence, different levels. A real divergence: both claim the same moment. */
  | { readonly verdict: "diverged"; readonly seq: bigint; readonly detail: string }
  /** REST is ahead: the replica has not yet seen what REST already serves. */
  | { readonly verdict: "replica-behind"; readonly by: bigint; readonly levelsDiffer: boolean }
  /** The replica is ahead of REST — REST read an older projection than the stream delivered. */
  | { readonly verdict: "rest-behind"; readonly by: bigint; readonly levelsDiffer: boolean }
  /** One side carries no sequence, so the two cannot be placed in time. */
  | { readonly verdict: "incomparable"; readonly why: string };

/**
 * Compare the replica against a REST snapshot — only as far as the evidence goes.
 *
 * REST's `nonce` is the same projection sequence the stream stamps on its
 * frames, so a REST book and a replica at the **same** sequence are two reads of
 * one stored book and must agree level for level. That is the only case in
 * which a difference is a divergence. At different sequences a difference is
 * just time passing, and calling it divergence would train a reader to ignore
 * the alarm; it is reported as lag, with whether the levels happen to differ.
 */
export function crossCheck(replica: Replica, rest: RestBook): CrossCheck {
  const seq = replica.seq;
  if (seq === null) return { verdict: "incomparable", why: "the replica has no sequence yet" };
  if (rest.nonce === null) return { verdict: "incomparable", why: "the REST book carried no nonce" };
  const difference = firstDifference(replica.snapshot, rest);
  if (rest.nonce === seq) {
    const book = replica.snapshot;
    return difference === null
      ? { verdict: "match", seq, levels: book.bids.length + book.asks.length }
      : { verdict: "diverged", seq, detail: difference };
  }
  return rest.nonce > seq
    ? { verdict: "replica-behind", by: rest.nonce - seq, levelsDiffer: difference !== null }
    : { verdict: "rest-behind", by: seq - rest.nonce, levelsDiffer: difference !== null };
}

/** The first level at which the two books disagree, described; `null` if they agree. */
function firstDifference(book: BookSnapshot, rest: RestBook): string | null {
  for (const [name, mine, theirs] of [
    ["bids", book.bids, rest.bids],
    ["asks", book.asks, rest.asks],
  ] as const) {
    const depth = Math.max(mine.length, theirs.length);
    for (let i = 0; i < depth; i += 1) {
      const a = mine[i];
      const b = theirs[i];
      if (a === undefined || b === undefined) {
        return `${name} depth ${mine.length} (replica) vs ${theirs.length} (REST)`;
      }
      if (!dec.sameAsDouble(a.price, b.price) || !dec.sameAsDouble(a.size, b.size)) {
        return (
          `${name}[${i}] replica ${dec.toString(a.price)} × ${dec.toString(a.size)}` +
          ` vs REST ${b.price} × ${b.size}`
        );
      }
    }
  }
  return null;
}
