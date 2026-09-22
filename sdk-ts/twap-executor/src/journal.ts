// The run journal: what this run intended, and what it knows happened.
//
// One JSON file per run in `runs/`, rewritten atomically after every state
// change. It's half of the idempotency story. The other half is the venue's
// record, keyed by the same derived client ids, and a resume reads both.
//
// The one rule that matters: **the intent is written before the order is
// sent.** A slice goes to `sending` on disk, and only then is `POST /orders`
// made. So a crash at any point leaves one of two states. Either the slice
// was never marked (so it was never sent), or it's marked `sending` (so it may
// or may not have reached the venue, and a resume asks rather than assumes).
// Writing after the send would open a window where an order exists and the
// journal has never heard of it.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";

import type { FillRecord, Side } from "./plan.js";

export type SliceState =
  /** Not reached yet. */
  | "pending"
  /** Written just before `POST /orders`. Outcome unknown until reconciled. */
  | "sending"
  /** The venue answered, or reconcile found it. `filled` is final. */
  | "done"
  /** Nothing sent: no liquidity inside the limit, nothing to catch up, and so on. */
  | "skipped"
  /** Nothing sent: a later slice was already due, so this one's quantity rolled forward. */
  | "missed"
  /** Sent and refused (`4xx`/`429`). The venue says it wasn't placed. */
  | "refused";

export interface SliceRecord {
  index: number;
  clientId: string;
  dueAt: number;
  state: SliceState;
  orderId: string | null;
  quantity: string | null;
  price: string | null;
  filled: string;
  fills: FillRecord[];
  note: string;
}

export interface Journal {
  version: 1;
  runId: string;
  live: boolean;
  baseUrl: string;
  createdAt: number;
  parent: {
    market: string;
    side: Side;
    size: string;
    durationMs: number;
    slices: number;
    limit: string | null;
  };
  startAt: number;
  arrival: { bid: string | null; ask: string | null; mid: string | null };
  slices: SliceRecord[];
  finishedAt: number | null;
}

const DIR = new URL("../runs/", import.meta.url);

function pathFor(runId: string): URL {
  return new URL(`${runId}.json`, DIR);
}

export function journalPath(runId: string): string {
  return pathFor(runId).pathname;
}

export function exists(runId: string): boolean {
  return existsSync(pathFor(runId));
}

export function load(runId: string): Journal {
  const file = pathFor(runId);
  if (!existsSync(file)) throw new Error(`no journal for run ${runId} at ${file.pathname}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Journal;
  if (parsed.version !== 1 || parsed.runId !== runId) {
    throw new Error(`${file.pathname} is not a version-1 journal for run ${runId}`);
  }
  return parsed;
}

/**
 * Persist, atomically: write a sibling temp file, then rename over the
 * journal. A rename within one directory is atomic on every filesystem this
 * runs on, so a crash mid-write leaves the previous journal intact, never
 * half of a new one.
 */
export function save(journal: Journal): void {
  mkdirSync(DIR, { recursive: true });
  const target = pathFor(journal.runId);
  const temp = new URL(`${journal.runId}.json.tmp`, DIR);
  writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(temp, target);
}
