// What the stream sends, turned into something the replica can act on.
//
// Two protocols can arrive here, and this file is the only place that knows
// the difference.
//
// 1. The public market-data stream, `GET /stream` — what this example connects
//    to, because it needs no token. Untagged subscribe, `type`-tagged frames,
//    exactly as the indexer serialises its internal `IndexerUpdate`:
//
//      → {"subscribe":["book:BTC-USDX-PERP"]}
//      ← {"type":"BookUpdate","market_id":"BTC-USDX-PERP",
//         "book":{"bids":[{"price":"62815.5","quantity":"0.25","order_count":3},…],
//                 "asks":[…],"sequence":15994}}
//      ← {"type":"gap","missed":12}
//
//    `sequence` is the indexer's per-market book projection sequence. It is the
//    same number `GET /markets/{id}/orderbook` returns as `nonce`, which is what
//    makes the REST cross-check possible at all. There is no timestamp on the
//    frame (ENG-15966) and no replay: `gap` is sent when this connection fell
//    behind the server's broadcast buffer and `missed` frames were dropped.
//
// 2. The `op`-envelope protocol that `GET /ws` speaks (token-gated), which the
//    spec names as the preferred one:
//
//      ← {"op":"subscribed","channel":"book","market":"…","seq_at_join":42}
//      ← {"op":"event","channel":"book","market":"…","seq":43,"payload":{…}}
//      ← {"op":"out_of_sync","channel":"book","market":"…","oldest_seq":100}
//      ← {"op":"error","message":"…"}
//
//    Handled here so the replica keeps working if the public stream converges
//    on it, and so a reader pointing `NEXUS_EXCHANGE_STREAM_URL` at a local
//    stack that speaks it gets the same behaviour.
//
// Both carry **full snapshots** of the top of the book, not deltas. A frame
// this cannot read as a complete snapshot is reported as `unrecognised` — never
// merged on a guess. If the venue ever ships an incremental encoding, the place
// it goes is a new `kind` here, gated on contiguous sequence numbers; until the
// encoding is documented, re-snapshotting over REST is the only honest answer.

import * as dec from "./decimal.js";

export interface Level {
  readonly price: dec.Dec;
  readonly size: dec.Dec;
}

export interface BookSnapshot {
  /** Best first: bids descending, asks ascending. */
  readonly bids: readonly Level[];
  readonly asks: readonly Level[];
}

export type Frame =
  | {
      readonly kind: "book";
      readonly market: string;
      readonly channel: string;
      /** Monotonic per (channel, market); `null` if the frame carried none. */
      readonly seq: bigint | null;
      readonly book: BookSnapshot;
      /** Levels that were dropped while parsing (bad number, zero size, duplicate price). */
      readonly rejectedLevels: number;
    }
  | { readonly kind: "gap"; readonly missed: number | null }
  | {
      readonly kind: "out_of_sync";
      readonly market: string | null;
      readonly oldestSeq: bigint | null;
    }
  | { readonly kind: "subscribed"; readonly market: string | null; readonly seq: bigint | null }
  | { readonly kind: "error"; readonly message: string }
  /** Well-formed, just not about this market's book — trades, stats, another market. */
  | { readonly kind: "ignored"; readonly why: string }
  /** Claims to be about the book but is not a shape this can apply. */
  | { readonly kind: "unrecognised"; readonly why: string };

/** Coerce an untrusted sequence number. u64 on the server, so strings are allowed. */
export function toSeq(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return BigInt(value);
  return null;
}

/** A number or decimal string, as an exact decimal; `null` if it is neither. */
function toDec(value: unknown): dec.Dec | null {
  try {
    if (typeof value === "number") return dec.fromNumber(value);
    if (typeof value === "string") return dec.parse(value);
  } catch {
    return null;
  }
  return null;
}

/**
 * One price level, in either encoding the venue uses:
 * `{price, quantity}` objects of decimal strings (the stream), or
 * `[price, size]` pairs (the REST book, and any CCXT-shaped payload).
 */
function parseLevel(raw: unknown): Level | null {
  let price: unknown;
  let size: unknown;
  if (Array.isArray(raw)) {
    [price, size] = raw;
  } else if (raw !== null && typeof raw === "object") {
    const level = raw as Record<string, unknown>;
    price = level["price"];
    size = level["quantity"] ?? level["size"] ?? level["amount"];
  } else {
    return null;
  }
  const p = toDec(price);
  const s = toDec(size);
  // A zero size on a snapshot carries no liquidity; a negative anything is a bug.
  if (p === null || s === null || !dec.isPositive(p) || !dec.isPositive(s)) return null;
  return { price: p, size: s };
}

/**
 * Parse one side, sorted best-first, with duplicates removed.
 *
 * Sorting rather than trusting the server's order: "top of book" is the whole
 * product, and index 0 of a differently-sorted array is a wrong answer that
 * looks entirely plausible. A duplicated price is dropped (keeping the first)
 * and counted, because two sizes for one price cannot both be the truth.
 */
function parseSide(
  raw: unknown,
  descending: boolean,
): { levels: Level[]; rejected: number } | null {
  if (!Array.isArray(raw)) return null;
  const levels: Level[] = [];
  let rejected = 0;
  for (const entry of raw) {
    const level = parseLevel(entry);
    if (level === null) rejected += 1;
    else levels.push(level);
  }
  levels.sort((a, b) => (descending ? -1 : 1) * dec.compare(a.price, b.price));
  const unique: Level[] = [];
  for (const level of levels) {
    const previous = unique[unique.length - 1];
    if (previous !== undefined && dec.equals(previous.price, level.price)) rejected += 1;
    else unique.push(level);
  }
  return { levels: unique, rejected };
}

/** `{bids, asks}` → a snapshot, or `null` if either side is not an array. */
export function parseBook(raw: unknown): { book: BookSnapshot; rejected: number } | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const bids = parseSide(candidate["bids"], true);
  const asks = parseSide(candidate["asks"], false);
  if (bids === null || asks === null) return null;
  return {
    book: { bids: bids.levels, asks: asks.levels },
    rejected: bids.rejected + asks.rejected,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Classify one parsed JSON frame, for a replica of `market`. */
export function classify(frame: unknown, market: string): Frame {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return { kind: "ignored", why: "not a JSON object" };
  }
  const message = frame as Record<string, unknown>;
  const op = str(message["op"]);
  if (op !== null) return classifyOp(op, message, market);
  const type = str(message["type"]);
  if (type !== null) return classifyLegacy(type, message, market);
  return { kind: "ignored", why: "neither an `op` nor a `type` frame" };
}

function classifyLegacy(type: string, message: Record<string, unknown>, market: string): Frame {
  switch (type) {
    case "BookUpdate": {
      const frameMarket = str(message["market_id"]);
      if (frameMarket !== market) return { kind: "ignored", why: `book for ${frameMarket}` };
      const raw = message["book"];
      const parsed = parseBook(raw);
      if (parsed === null) return { kind: "unrecognised", why: "BookUpdate without bids/asks" };
      const seq = toSeq((raw as Record<string, unknown>)["sequence"]);
      return {
        kind: "book",
        channel: "book",
        market,
        seq,
        book: parsed.book,
        rejectedLevels: parsed.rejected,
      };
    }
    case "gap": {
      const missed = message["missed"];
      return {
        kind: "gap",
        missed: typeof missed === "number" && Number.isFinite(missed) ? missed : null,
      };
    }
    case "MarketHalted":
    case "MarketResumed":
      // Not sent for a `book:` subscription, but worth surfacing if it ever is:
      // a halted market's book is a still life, and a silent replica is the
      // expected, correct outcome rather than a fault.
      return str(message["market_id"]) === market
        ? { kind: "error", message: `${type} for ${market}` }
        : { kind: "ignored", why: `${type} for another market` };
    default:
      return { kind: "ignored", why: `${type} frame` };
  }
}

function classifyOp(op: string, message: Record<string, unknown>, market: string): Frame {
  const channel = str(message["channel"]);
  const frameMarket = str(message["market"]);
  // A frame that names no market is the server declining to echo it, not a mismatch.
  const otherMarket = frameMarket !== null && frameMarket !== market;
  switch (op) {
    case "subscribed":
      return { kind: "subscribed", market: frameMarket, seq: toSeq(message["seq_at_join"]) };
    case "event": {
      if (channel !== "book") return { kind: "ignored", why: `${channel} event` };
      if (otherMarket) return { kind: "ignored", why: `book for ${frameMarket}` };
      const parsed = parseBook(message["payload"]);
      if (parsed === null) return { kind: "unrecognised", why: "book event payload is not {bids, asks}" };
      return {
        kind: "book",
        channel,
        market,
        seq: toSeq(message["seq"]),
        book: parsed.book,
        rejectedLevels: parsed.rejected,
      };
    }
    case "out_of_sync":
      if (channel !== "book" || otherMarket) return { kind: "ignored", why: "out_of_sync elsewhere" };
      return { kind: "out_of_sync", market: frameMarket, oldestSeq: toSeq(message["oldest_seq"]) };
    case "error":
      return { kind: "error", message: str(message["message"]) ?? "unspecified server error" };
    default:
      // `unsubscribed`, and any op a later API version adds.
      return { kind: "ignored", why: `${op} frame` };
  }
}
