"use client";

/*
 * The public trades tape. Newest at the top; only the price is coloured, so the
 * column reads as a run of aggressor direction rather than a wall of green/red.
 *
 * TIME IS THE FIRST COLUMN, and each row carries a decaying tint.
 *
 * Both are theirs, and both are the same idea. A tape is not a table of trades, it is
 * a record of *when* — the question it answers is "what is happening right now", and
 * ours answered it with the timestamp in the last column and no visual weighting at
 * all, so the newest fill looked exactly like the fill from a minute ago. Theirs tints
 * the row background by recency, fading toward the page as a fill ages, which turns the
 * top of the list into a trace you read without reading.
 */

import type { Feed } from "@/lib/feed";
import type { Market } from "@/lib/markets";
import { notional } from "@/lib/format";
import { MONO, GREEN, RED, MUT, FAINT, DIM, monoLabel } from "@/lib/theme";
import { usePhase } from "@/lib/dataphase";
import { TableState } from "./states";

const COLS = "auto 1fr 1fr";

/**
 * How far down the list the tint reaches, and how strong it starts.
 *
 * Eight rows, not all of them: a gradient that never lands flat has no baseline, so
 * "recent" stops meaning anything. The alpha is small because a tape repaints
 * constantly, and a strong wash on a moving list is noise rather than signal.
 */
const TINT_ROWS = 8;

/**
 * How many fills the phone tape shows.
 *
 * The list is unbounded and the screen now scrolls as one, so without a cap the trade
 * screen's scroll length would be decided by however many trades the feed happens to
 * hold. Thirty is more history than anyone scrolls to on a phone.
 */
const TAPE_ROWS = 30;
const TINT_MAX = 0.1;

/** Headerless — the containing panel owns the header and tab strip. */
export function TradesTape({
  feed,
  market,
  units = "base",
}: {
  feed: Feed;
  /** Only needed to name and convert the size column. Omitted on desktop. */
  market?: Market;
  units?: "base" | "quote";
}) {
  const unit = market ? (units === "base" ? market.base : market.quote) : "";
  const { phase, loading, error } = usePhase("/v1/trades");
  /* Empty when nothing has arrived — the tape must not paint fixtures underneath its
     own loading line, and `TableState` must be told the count it is actually about
     to render or it reports "No trades" on a healthy tape. */
  const shown = phase === "ready" ? feed.trades.slice(0, TAPE_ROWS) : [];
  const sizeOf = (tr: Feed["trades"][number]) =>
    units === "base" || !market ? tr.size : notional(tr.sz * tr.px);

  return (
    <>
      <div
        style={{
          flex: "0 0 auto",
          display: "grid",
          gridTemplateColumns: COLS,
          gap: 10,
          padding: "6px 14px 4px",
          ...monoLabel(9, "0.08em"),
        }}
      >
        <span>TIME</span>
        <span style={{ textAlign: "right" }}>PRICE</span>
        <span style={{ textAlign: "right" }}>{unit ? `SIZE ${unit}` : "SIZE"}</span>
      </div>
      {/* Natural height — the trade screen scrolls as one, so this does not scroll
          inside itself. Capped, because a tape is unbounded and the page should not be. */}
      <div aria-label="Recent trades" style={{ flex: "0 0 auto" }}>
        <TableState count={shown.length} surface="tape" loading={loading} error={error} minHeight={140} />
        {shown.map((tr, i) => {
          const heat = i < TINT_ROWS ? TINT_MAX * (1 - i / TINT_ROWS) : 0;
          return (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 10,
                padding: "2.5px 14px",
                fontFamily: MONO,
                fontSize: 11.5,
                /* Tinted in the aggressor's colour, so the trace reads as pressure and
                   not merely as age. An rgba literal rather than a token because the
                   alpha is the whole point and a token cannot carry a per-row value. */
                background: heat > 0 ? `rgba(${tr.up ? "14,203,129" : "246,70,93"},${heat.toFixed(3)})` : undefined,
              }}
            >
              {/* Same rule as the size column: FAINT drops under AA once the tint
                  lifts the background, and it was the first column a reader looks at. */}
              <span style={{ color: heat > 0 ? DIM : FAINT }}>{tr.time}</span>
              <span style={{ textAlign: "right", color: tr.up ? GREEN : RED }}>{tr.price}</span>
              {/* DIM on a tinted row: MUT drops under AA once the wash lifts the
                  background, and the tint is strongest exactly where the eye lands. */}
              <span style={{ textAlign: "right", color: heat > 0 ? DIM : MUT }}>{sizeOf(tr)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
