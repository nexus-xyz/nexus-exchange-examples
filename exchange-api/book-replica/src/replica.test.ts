// Offline tests for the parts of the replica that make correctness claims:
// frame classification, sequence ordering, and the cross-check verdicts.
//
// The fixtures are the wire shapes as the indexer serialises them — see the
// header of `frames.ts` — not shapes invented to make the tests pass. No
// network: CI runs these with no venue in reach.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as dec from "./decimal.js";
import { classify } from "./frames.js";
import { parseRestBook, toSnapshot } from "./rest.js";
import { crossCheck, Replica } from "./replica.js";
import type { BookSnapshot } from "./frames.js";

const MARKET = "BTC-USDX-PERP";

/** A `/stream` BookUpdate exactly as `IndexerUpdate` serialises it. */
function bookUpdate(sequence: number, bids: [string, string][], asks: [string, string][]) {
  const side = (levels: [string, string][]) =>
    levels.map(([price, quantity]) => ({ price, quantity, order_count: 1 }));
  return {
    type: "BookUpdate",
    market_id: MARKET,
    book: { bids: side(bids), asks: side(asks), sequence },
  };
}

function book(frame: unknown): { seq: bigint | null; book: BookSnapshot } {
  const classified = classify(frame, MARKET);
  assert.equal(classified.kind, "book");
  if (classified.kind !== "book") throw new Error("unreachable");
  return { seq: classified.seq, book: classified.book };
}

describe("decimal", () => {
  it("normalises trailing zeros, so equal values are equal keys", () => {
    assert.ok(dec.equals(dec.parse("62815.50"), dec.parse("62815.5")));
    assert.equal(dec.toString(dec.parse("100.000")), "100");
  });

  it("reads exponent form, which String(double) can produce", () => {
    assert.equal(dec.toString(dec.fromNumber(1e-7)), "0.0000001");
    assert.equal(dec.toString(dec.parse("1.5e3")), "1500");
  });

  it("refuses what Number() would quietly accept", () => {
    for (const bad of ["", " 1", "1,000", "Infinity", "NaN", "0x10", "."]) {
      assert.throws(() => dec.parse(bad), RangeError, bad);
    }
  });

  it("subtracts exactly where doubles do not", () => {
    assert.equal(dec.toString(dec.subtract(dec.parse("0.3"), dec.parse("0.1"))), "0.2");
    assert.notEqual(0.3 - 0.1, 0.2);
  });
});

describe("classify", () => {
  it("reads a /stream BookUpdate as a sorted snapshot with its sequence", () => {
    const { seq, book: snapshot } = book(
      bookUpdate(42, [["100.0", "1"], ["101.5", "2"]], [["103", "1"], ["102", "3"]]),
    );
    assert.equal(seq, 42n);
    assert.deepEqual(snapshot.bids.map((l) => dec.toString(l.price)), ["101.5", "100"]);
    assert.deepEqual(snapshot.asks.map((l) => dec.toString(l.price)), ["102", "103"]);
  });

  it("reads the op-envelope event shape the same way", () => {
    const frame = {
      op: "event",
      channel: "book",
      market: MARKET,
      seq: "43",
      payload: { bids: [[101.5, 2]], asks: [[102, 3]] },
    };
    const { seq, book: snapshot } = book(frame);
    assert.equal(seq, 43n);
    assert.equal(snapshot.bids.length, 1);
  });

  it("ignores another market's book rather than applying it", () => {
    const other = { ...bookUpdate(1, [], []), market_id: "ETH-USDX-PERP" };
    assert.equal(classify(other, MARKET).kind, "ignored");
  });

  it("turns the server's gap and out_of_sync into their own kinds", () => {
    assert.deepEqual(classify({ type: "gap", missed: 12 }, MARKET), { kind: "gap", missed: 12 });
    const sync = classify(
      { op: "out_of_sync", channel: "book", market: MARKET, oldest_seq: 100 },
      MARKET,
    );
    assert.deepEqual(sync, { kind: "out_of_sync", market: MARKET, oldestSeq: 100n });
  });

  it("calls a book frame without bids/asks unrecognised, never a snapshot", () => {
    const frame = { type: "BookUpdate", market_id: MARKET, book: { changes: [["buy", "1", "2"]] } };
    assert.equal(classify(frame, MARKET).kind, "unrecognised");
  });

  it("drops and counts zero-size, unreadable and duplicate-price levels", () => {
    const frame = bookUpdate(1, [["100", "1"], ["100.0", "5"], ["99", "0"], ["x", "1"]], []);
    const classified = classify(frame, MARKET);
    assert.equal(classified.kind, "book");
    if (classified.kind !== "book") return;
    assert.equal(classified.book.bids.length, 1);
    assert.equal(classified.rejectedLevels, 3);
  });
});

describe("Replica sequence ordering", () => {
  it("drops a frame at or below the held sequence", () => {
    const replica = new Replica(MARKET);
    const a = book(bookUpdate(10, [["100", "1"]], [["101", "1"]]));
    const b = book(bookUpdate(10, [["99", "1"]], [["101", "1"]]));
    assert.equal(replica.apply(a.seq, a.book, "stream").result, "applied");
    assert.deepEqual(replica.apply(b.seq, b.book, "stream"), { result: "stale", held: 10n });
    assert.equal(dec.toString(replica.top().bid!.price), "100");
  });

  it("applies a jump — fill-time frames skip ahead, and that is not loss", () => {
    const replica = new Replica(MARKET);
    const a = book(bookUpdate(10, [["100", "1"]], []));
    const b = book(bookUpdate(15_994, [["100", "1"]], []));
    replica.apply(a.seq, a.book, "stream");
    const outcome = replica.apply(b.seq, b.book, "stream");
    assert.deepEqual(outcome, { result: "applied", jump: 15_984n, changed: false });
  });

  it("stays resyncing until REST answers, then clears", () => {
    const replica = new Replica(MARKET);
    assert.ok(replica.isResyncing);
    const a = book(bookUpdate(1, [], []));
    replica.apply(a.seq, a.book, "stream");
    assert.ok(replica.isResyncing, "a stream frame does not end a resync");
    const rest = parseRestBook({ bids: [], asks: [], nonce: 2 })!;
    replica.apply(rest.nonce, toSnapshot(rest), "rest");
    assert.ok(!replica.isResyncing);
  });

  it("reports a crossed book instead of repairing it", () => {
    const replica = new Replica(MARKET);
    const a = book(bookUpdate(1, [["101", "1"]], [["100", "1"]]));
    replica.apply(a.seq, a.book, "stream");
    assert.ok(replica.isCrossed);
  });
});

describe("crossCheck", () => {
  function replicaAt(seq: number, bids: [string, string][], asks: [string, string][]): Replica {
    const replica = new Replica(MARKET);
    const frame = book(bookUpdate(seq, bids, asks));
    replica.apply(frame.seq, frame.book, "stream");
    return replica;
  }

  it("matches level for level at the same sequence, across string and double encodings", () => {
    const replica = replicaAt(7, [["62815.50", "0.250"]], [["62816.0", "1.5"]]);
    const rest = parseRestBook({ bids: [[62815.5, 0.25]], asks: [[62816, 1.5]], nonce: 7 })!;
    assert.deepEqual(crossCheck(replica, rest), { verdict: "match", seq: 7n, levels: 2 });
  });

  it("calls a difference at the same sequence a divergence, and says where", () => {
    const replica = replicaAt(7, [["62815.5", "0.25"]], []);
    const rest = parseRestBook({ bids: [[62815.5, 0.3]], asks: [], nonce: 7 })!;
    const result = crossCheck(replica, rest);
    assert.equal(result.verdict, "diverged");
    if (result.verdict === "diverged") assert.match(result.detail, /bids\[0\]/);
  });

  it("calls a difference at different sequences lag, never divergence", () => {
    const replica = replicaAt(7, [["100", "1"]], []);
    const ahead = parseRestBook({ bids: [[99, 1]], asks: [], nonce: 9 })!;
    const behind = parseRestBook({ bids: [[99, 1]], asks: [], nonce: 5 })!;
    assert.deepEqual(crossCheck(replica, ahead), { verdict: "replica-behind", by: 2n, levelsDiffer: true });
    assert.deepEqual(crossCheck(replica, behind), { verdict: "rest-behind", by: 2n, levelsDiffer: true });
  });

  it("refuses to compare without a sequence on both sides", () => {
    const replica = replicaAt(7, [], []);
    const rest = parseRestBook({ bids: [], asks: [] })!;
    assert.equal(crossCheck(replica, rest).verdict, "incomparable");
  });

  it("treats an empty book on both sides at one sequence as a match — the testnet-outage case", () => {
    const replica = new Replica(MARKET);
    const rest = parseRestBook({ bids: [], asks: [], nonce: 0 })!;
    replica.apply(rest.nonce, toSnapshot(rest), "rest");
    assert.deepEqual(crossCheck(replica, rest), { verdict: "match", seq: 0n, levels: 0 });
  });
});
