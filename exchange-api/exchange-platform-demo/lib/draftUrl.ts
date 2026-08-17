/*
 * The order ticket, in the address bar.
 *
 * WHY
 *
 * The draft is the most specification-dense state in this app — side, type, price,
 * trigger, size, leverage, margin mode, time-in-force, reduce-only, a TP/SL bracket,
 * a scale ladder and a TWAP schedule, twenty-two fields whose interactions ARE the
 * ticket's contract. It lived entirely in `useState`, which meant the harness could
 * grade it at exactly one configuration: the opening default, buy / limit / PostOnly /
 * 10× cross. Every other combination — and the ones worth arguing about are all the
 * others — was unreachable, ungraded, and unlinkable.
 *
 * `audit/scripts/state.mjs` calls this the biggest single gap in the app and it is
 * right. A reviewer could not say "look at THIS" about a 10× short with a stop at
 * 58,200; they could only describe it and hope.
 *
 * WHY ONE PARAMETER AND NOT TWENTY-TWO
 *
 * Twenty-two keys would be twenty-two parse paths, twenty-two chances to write a key
 * and never clear it — and `sub` already taught us what that costs (it restored a
 * stale value on reload because it was written but never removed). One key, one
 * grammar, one parser.
 *
 * The grammar is readable on purpose, because a URL that has to be decoded before it
 * can be discussed is not much better than no URL:
 *
 *   order=sell:limit:0.5@61240:20x:iso:IOC:reduce:tp=68400:sl=58200
 *          │     │     │   │     │    │    │      │        │
 *          side  type  size price lev  margin tif  flags   bracket
 *
 * Every segment is OPTIONAL and anything absent falls back to `initialDraft` for the
 * market. `order=sell` is valid and means "the default ticket, selling". That matters
 * more than compactness: the shortest URL that expresses a difference should contain
 * only the difference.
 *
 * WHAT IS DELIBERATELY NOT ENCODED
 *
 * `scaleStart` / `scaleEnd` / `scaleSkew` / `twapRandomize` and the rest of the two
 * pro schedules. They are reachable through `type=scale` and `type=twap`, which is
 * enough to capture what those panels LOOK like, and their own fields are derived
 * defaults that a reader is unlikely to want to pin. If that turns out to be wrong the
 * grammar has room — `scale=5@1.4`, `twap=0h30` — and adding a segment cannot break an
 * existing URL, which is the whole reason for a positional-with-prefixes format rather
 * than a fixed tuple.
 */

import type { Draft } from "@/components/terminal/OrderTicket";
import type { Market } from "./markets";

const SIDES = ["buy", "sell"] as const;
const TYPES = ["limit", "market", "stop_limit", "stop_market", "scale", "twap"] as const;
const TIFS = ["GTC", "IOC", "FOK", "PostOnly"] as const;
const MARGINS = ["cross", "iso"] as const;

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Draft → `order=…`, emitting ONLY what differs from the market's opening draft.
 *
 * A URL that restates every default is a URL nobody reads. It also makes the diff
 * between two states — the thing a reviewer is actually comparing — invisible.
 */
export function encodeDraft(draft: Draft, base: Draft): string {
  const out: string[] = [];
  /* Side and type are positional and lead, because they are what the reader looks for
     first. Side is always emitted when anything else is: `order=:market:2` reads as a
     typo, `order=buy:market:2` does not. */
  const anyDiff =
    draft.side !== base.side ||
    draft.type !== base.type ||
    draft.size !== base.size ||
    draft.price !== base.price ||
    draft.lev !== base.lev ||
    draft.margin !== base.margin ||
    draft.tif !== base.tif ||
    draft.reduceOnly !== base.reduceOnly ||
    draft.tpsl !== base.tpsl ||
    draft.tp !== base.tp ||
    draft.sl !== base.sl ||
    draft.trigger !== base.trigger;
  if (!anyDiff) return "";

  out.push(draft.side);
  if (draft.type !== base.type) out.push(draft.type);

  if (draft.size !== base.size || draft.price !== base.price) {
    const size = draft.size !== base.size ? String(draft.size) : "";
    const price = draft.price !== null && draft.price !== base.price ? `@${draft.price}` : "";
    if (size || price) out.push(`${size}${price}`);
  }
  if (draft.trigger !== null && draft.trigger !== base.trigger) out.push(`t${draft.trigger}`);
  if (draft.lev !== base.lev) out.push(`${draft.lev}x`);
  if (draft.margin !== base.margin) out.push(draft.margin);
  if (draft.tif !== base.tif) out.push(draft.tif);
  if (draft.reduceOnly !== base.reduceOnly && draft.reduceOnly) out.push("reduce");
  if (draft.tpsl !== base.tpsl && draft.tpsl) out.push("tpsl");
  if (draft.tp !== null && draft.tp !== base.tp) out.push(`tp=${draft.tp}`);
  if (draft.sl !== null && draft.sl !== base.sl) out.push(`sl=${draft.sl}`);

  return out.join(":");
}

/**
 * `order=…` → Draft, over the market's opening draft.
 *
 * TOLERANT BY DESIGN. An unrecognised segment is skipped rather than rejected: these
 * URLs get typed by hand and pasted into reviews, and a ticket that refuses to render
 * because somebody wrote `20X` instead of `20x` is worse than one that ignores it. The
 * result is always a valid draft — the caller can render it without checking.
 */
export function decodeDraft(raw: string | undefined, base: Draft, market: Market): Draft {
  if (!raw) return base;
  const d: Draft = { ...base };
  let sawSize = false;

  for (const seg of raw.split(":")) {
    const s = seg.trim();
    if (!s) continue;
    const lower = s.toLowerCase();

    if ((SIDES as readonly string[]).includes(lower)) {
      d.side = lower as Draft["side"];
      continue;
    }
    if ((TYPES as readonly string[]).includes(lower)) {
      d.type = lower as Draft["type"];
      continue;
    }
    if ((MARGINS as readonly string[]).includes(lower)) {
      d.margin = lower as Draft["margin"];
      continue;
    }
    const tif = TIFS.find((t) => t.toLowerCase() === lower);
    if (tif) {
      d.tif = tif;
      continue;
    }
    if (lower === "reduce") {
      d.reduceOnly = true;
      continue;
    }
    if (lower === "tpsl") {
      d.tpsl = true;
      continue;
    }
    if (lower.startsWith("tp=")) {
      const v = num(s.slice(3));
      if (v !== null) {
        d.tp = v;
        d.tpsl = true;
      }
      continue;
    }
    if (lower.startsWith("sl=")) {
      const v = num(s.slice(3));
      if (v !== null) {
        d.sl = v;
        d.tpsl = true;
      }
      continue;
    }
    if (/^t[\d.]+$/.test(lower)) {
      const v = num(s.slice(1));
      if (v !== null) d.trigger = v;
      continue;
    }
    if (/^[\d.]+x$/.test(lower)) {
      const v = num(s.slice(0, -1));
      /* Clamped to the market, not trusted. `?order=500x` on a 20× market must not
         render a ticket claiming leverage the venue does not offer — the ticket is a
         specification and an impossible number in it is a lie a reader may copy. */
      if (v !== null) d.lev = Math.max(1, Math.min(market.maxLev, Math.round(v)));
      continue;
    }
    // size[@price] — the only unprefixed numeric segment, so it is checked last.
    const m = /^([\d.]*)(?:@([\d.]+))?$/.exec(s);
    if (m && (m[1] || m[2])) {
      if (m[1] && !sawSize) {
        const v = num(m[1]);
        if (v !== null && v > 0) {
          d.size = v;
          sawSize = true;
        }
      }
      if (m[2]) {
        const v = num(m[2]);
        if (v !== null && v > 0) d.price = v;
      }
    }
  }

  /* A market order carries no price, whatever the URL said. Coercing here rather than
     rejecting keeps the parser tolerant while making the ticket's own rule the thing
     that wins — same reason `coerceTimeInForce` exists at the wire boundary. */
  if (d.type === "market" || d.type === "stop_market") d.price = null;
  return d;
}
