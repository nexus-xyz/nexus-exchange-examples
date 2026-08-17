/*
 * One clock for the operate panes, and it is a constant.
 *
 * WHY A CONSTANT. `audit/floor.json` makes non-determinism a blocking convention
 * — no `Date.now()` and no argless `new Date()` anywhere in `lib/` or
 * `components/` — because two captures of the same state have to be
 * byte-identical or visual regression is impossible. A request log is the most
 * tempting place in the console to reach for the real clock and the worst place
 * to do it: every row would move on every render and the pane could never be
 * graded.
 *
 * The value is the venue's most recent recorded event, rounded to the hour. It
 * is deliberately the same instant the rest of the console's event data is
 * anchored to (the demo rows are written relative to it, so the newest entry sits at
 * 1_786_684_500_000), so "5 minutes ago" on this page and "5 minutes ago" on
 * Keys mean the same 5 minutes. Two clocks that disagree is how a console starts
 * contradicting itself.
 *
 * WHY TIMES ARE FORMATTED FROM THE ISO STRING. `toLocaleTimeString` reads the
 * host time zone, so the server renders 14:05 and a reader in Berlin sees 16:05
 * in a screenshot that claims to be the same capture. Slicing the ISO string is
 * UTC by construction, which is also the only time zone a request log should
 * ever be written in — a developer correlating this tape with their own logs is
 * comparing to a server, not to a wall.
 */

/** The instant every operate pane treats as "now". UTC, on the hour. */
export const CONSOLE_NOW_MS = 1_786_684_800_000;

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/**
 * The start of each of the last `count` hours, oldest first, ending at the hour
 * containing `CONSOLE_NOW_MS`.
 */
export function hourStarts(count = 24): number[] {
  return Array.from({ length: count }, (_, i) => CONSOLE_NOW_MS - (count - 1 - i) * HOUR_MS);
}

/** `14:00` — UTC, from the ISO string. */
export function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** `14:03:27` — UTC. The precision a request tape needs and a chart axis does not. */
export function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * How long ago, said the way an operator says it.
 *
 * Relative to the constant above rather than to the real clock, for the same
 * determinism reason — and it is the honest reading either way, because the data
 * it describes is anchored there too.
 */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((CONSOLE_NOW_MS - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * A small, seeded PRNG. Same generator as `lib/venue/product-analytics.ts`.
 *
 * Duplicated rather than imported because these three models are the operate
 * panes' own series and belong beside the panes that read them; a shared
 * eight-line helper is a much smaller liability than a dependency in the wrong
 * direction.
 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable numeric seed from a string, so a key's series follows its id. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
