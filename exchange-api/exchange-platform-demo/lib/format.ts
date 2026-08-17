/*
 * Deterministic PRNG + number formatting.
 *
 * Every "live" figure in the terminal is derived from a seeded PRNG rather than
 * Math.random, so a given (seed, tick) always renders the same frame. That keeps
 * the server render and the first client render identical — no hydration drift —
 * and makes the mock reproducible in screenshots.
 */

/** mulberry32 — small, fast, good enough for visual noise. */
export function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed from a string, so a market symbol maps to its own PRNG stream. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Thousands-separated, fixed decimals. */
export const comma = (n: number, d = 1) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Price decimals scale with magnitude — an FX pair needs 4, an index needs 0.
 * Keeping this in one place stops each panel from inventing its own rule.
 */
export const priceDecimals = (n: number) => (n < 10 ? 4 : n < 1000 ? 2 : 1);

/** Format a price at its market-appropriate precision. */
export const price = (n: number) => comma(n, priceDecimals(n));

/** Signed percent, always with an explicit sign. */
export const pct = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d) + "%";

/** Signed USD, always with an explicit sign. */
export const usd = (n: number) =>
  (n >= 0 ? "+$" : "-$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Compact notional — $1.42B, $684M, $9.1M. */
export function notional(n: number): string {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/** Compact count — 4.07M, 41.2k. */
export function count(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Seconds → hh:mm:ss, for the funding countdown. */
export function countdown(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** mm:ss from a seeded pair of integers. */
export const clock = (m: number, s: number) =>
  `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
