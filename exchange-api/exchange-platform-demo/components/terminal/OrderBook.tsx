"use client";

/*
 * The order book ladder.
 *
 * Asks fill downward from the top of the panel and bids fill from the mid down,
 * so the touch is always adjacent to the mid band no matter how tall the panel
 * is — that's what the two `flex: 1 1 0` halves with opposing justification do.
 *
 * Clicking a level pushes its price into the order ticket, which is the
 * interaction that makes the book feel like a control rather than a readout.
 */

import { useFlash } from "@/hooks/useFlash";
import { usePhase } from "@/lib/dataphase";
import { TableState } from "./states";
import type { BookRow, Feed } from "@/lib/feed";
import { Market, fmtPrice } from "@/lib/markets";
import { notional } from "@/lib/format";
import { GREEN, RED, MONO, L1, L2, TXT, MUT, DIM, FAINT, GREEN_BAR, RED_BAR, GREEN_WASH, R_XS, monoLabel } from "@/lib/theme";

const COLS = "1fr 1fr 1fr";

function Level({
  row,
  tone,
  onPick,
}: {
  row: BookRow;
  tone: "bid" | "ask";
  onPick: (px: number) => void;
}) {
  const color = tone === "bid" ? GREEN : RED;
  const bar = tone === "bid" ? GREEN_BAR : RED_BAR;
  return (
    <div
      onClick={() => onPick(row.px)}
      className="nx-row"
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: COLS,
        padding: "2.5px 14px",
        fontFamily: MONO,
        fontSize: 11.5,
        cursor: "pointer",
      }}
    >
      {/* The depth bar EASES. It used to snap to a new width on every tick, which
          reads as flicker across thirteen rows at once; 180ms is long enough to be a
          movement and short enough that the bar still means "now". */}
      <span
        style={{
          position: "absolute",
          right: 0,
          top: 1,
          bottom: 1,
          width: `${row.depth}%`,
          background: bar,
          borderRadius: `${R_XS}px 0 0 ${R_XS}px`,
          transition: "width .18s ease-out",
        }}
      />
      {/* Same match flash as the compact book. The desktop ladder is the surface a
          trader watches for minutes at a time, so if the event is worth showing at all
          it is worth showing here. */}
      {row.fresh && (
        <span
          key={row.seq}
          aria-hidden="true"
          className={`nx-book-flash nx-book-flash-${tone}${row.matched ? "" : " nx-book-flash-quote"}`}
        />
      )}
      <span style={{ position: "relative", color }}>{row.price}</span>
      <span style={{ position: "relative", textAlign: "right", color: MUT }}>{row.size}</span>
      {/* DIM, not FAINT. The depth bar behind this column lifts the background to
          ~#01120c, which drops FAINT to 4.47:1 — under AA. The bar is an absolutely
          positioned sibling, so our own contrast walker (ancestors only) cannot see
          it; axe composites siblings and caught it. */}
      <span style={{ position: "relative", textAlign: "right", color: DIM }}>{row.total}</span>
    </div>
  );
}

export function OrderBook({
  market,
  feed,
  grouping,
  onGrouping,
  onPickPrice,
}: {
  market: Market;
  feed: Feed;
  grouping: number;
  onGrouping: (g: number) => void;
  onPickPrice: (px: number) => void;
}) {
  const c = feed.candles[feed.candles.length - 1];
  const up = c.c >= c.o;
  const flash = useFlash(feed.last);
  /* A book with no response yet is not a book with no orders in it, and the two
     must not look the same: "No resting orders in this book" during a cold start
     tells a trader the market is dead. */
  const { loading, error } = usePhase("/v1/book");
  if (loading || error) {
    return (
      <>
        <div style={{ flex: "0 0 auto", display: "grid", gridTemplateColumns: COLS, padding: "6px 14px 4px", ...monoLabel(9, "0.08em") }}>
          <span>PRICE</span>
          <span style={{ textAlign: "right" }}>SIZE</span>
          <span style={{ textAlign: "right" }}>TOTAL</span>
        </div>
        <TableState count={0} surface="book" loading={loading} error={error} minHeight={180} />
      </>
    );
  }

  return (
    <>
      <div style={{ flex: "0 0 auto", display: "grid", gridTemplateColumns: COLS, padding: "6px 14px 4px", ...monoLabel(9, "0.08em") }}>
        <span>PRICE</span>
        <span style={{ textAlign: "right" }}>SIZE</span>
        <span style={{ textAlign: "right" }}>TOTAL</span>
      </div>

      {/* asks — anchored to the bottom of their half so the touch meets the mid */}
      <div tabIndex={0} aria-label="Order book levels" style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" }}>
        {feed.asks.map((r, i) => (
          <Level key={i} row={r} tone="ask" onPick={onPickPrice} />
        ))}
      </div>

      {/* mid band */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "9px 14px",
          borderTop: `1px solid ${L1}`,
          borderBottom: `1px solid ${L1}`,
          background: GREEN_WASH,
        }}
      >
        {/* The mid is the largest live number in the panel and it repainted in
            silence. It flashes on change like the header's Mark does, and the arrow
            gets the same easing as everything else that turns. */}
        <span
          key={flash}
          className={flash}
          style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 16, color: up ? GREEN : RED, padding: "1px 5px", margin: "-1px -5px" }}
        >
          <span style={{ fontSize: 10, transition: "transform .18s ease-out", transform: up ? "none" : "rotate(180deg)", display: "inline-block" }}>▲</span>
          {fmtPrice(market, feed.last)}
        </span>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <span style={monoLabel(9, "0.08em")}>SPREAD</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: MUT }}>
            {feed.spread.toFixed(Math.max(1, String(grouping).split(".")[1]?.length ?? 1))}
            <span style={{ color: DIM }}> · {feed.spreadBps.toFixed(1)}bp</span>
          </span>
        </div>
      </div>

      {/* bids */}
      <div tabIndex={0} aria-label="Order book levels" style={{ flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
        {feed.bids.map((r, i) => (
          <Level key={i} row={r} tone="bid" onPick={onPickPrice} />
        ))}
      </div>
    </>
  );
}

/**
 * The mobile book: two-sided, bids left, asks right.
 *
 * Measured against theirs at 390 — a divider at x=178, eleven levels PER SIDE, and
 * columns `TOTAL │ PRICE ‖ PRICE │ TOTAL` with no size column at all. That is 22 levels
 * where our stacked ladder showed 18, in less height per level, and it is not a
 * density trick: a level only needs a price and a cumulative total to be read, and
 * putting the two price columns either side of the divider makes the spread legible
 * without a band announcing it.
 *
 * Which is why the mid/spread band is gone here. It cost 45px to state a number the
 * two adjacent price columns already show, on the screen with the least room.
 *
 * Desktop keeps the stacked ladder — so does theirs. This is a breakpoint on both
 * sides, not a fallback.
 */
export function OrderBookCompact({
  market,
  feed,
  units,
  onPickPrice,
  /* 13 — every level the feed generates (BOOK_LEVELS). 11 was theirs at their tick
     size; capping ours at their number left a third of the pane empty. */
  rows = 13,
}: {
  market: Market;
  feed: Feed;
  units: "base" | "quote";
  onPickPrice: (px: number) => void;
  rows?: number;
}) {
  /*
   * `feed.asks` arrives FAR→NEAR, because the stacked desktop ladder renders asks
   * downward with the best ask at the bottom, touching the mid. Side by side the best
   * ask belongs at the TOP, level with the best bid — otherwise the two columns are
   * read against each other in opposite directions and the spread is at the bottom of
   * one and the top of the other. Rendering it unreversed put a 10.62 cumulative total
   * on the first ask row and an unsorted-looking price column under it.
   */
  const asks = feed.asks.slice().reverse();
  const compactPhase = usePhase("/v1/book");
  /*
   * Quote sizes are derived, not stored: a cumulative size times its own price is the
   * notional resting at that level, which is the number a trader thinking in dollars
   * wants. Rounded to whole units because a cent of cumulative depth is noise.
   */
  const totalOf = (r: BookRow) =>
    units === "base" ? r.total : notional(r.cum * r.px);

  const half = (side: BookRow[], tone: "bid" | "ask") =>
    (compactPhase.phase === "ready" ? side.slice(0, rows) : []).map((r, i) => (
      <button
        key={i}
        onClick={() => onPickPrice(r.px)}
        className="nx-row"
        style={{
          position: "relative",
          width: "100%",
          display: "grid",
          /* Price always adjacent to the divider: total on the outside for bids,
             on the inside for asks. */
          gridTemplateColumns: tone === "bid" ? "1fr auto" : "auto 1fr",
          alignItems: "center",
          gap: 8,
          /*
           * 32px, which is both the default tap tier and theirs. The rows came out
           * 25px and 26 of them failed the floor at once — a book level is a control
           * (it prices the ticket), so it is graded like one. Thirteen at 32px is
           * taller than the pane, and the list scrolls; theirs shows eleven for the
           * same reason.
           */
          minHeight: 32,
          padding: "4px 10px",
          border: "none",
          background: "transparent",
          fontFamily: MONO,
          fontSize: 11.5,
          cursor: "pointer",
          textAlign: tone === "bid" ? "left" : "right",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* The bar grows OUTWARD from the divider, which is theirs and is the only
            direction that reads: depth is a quantity measured from the touch, so it
            should start at the touch. Anchored to the outer edge it grew toward the
            spread, which says the opposite.

            Rounded on the outer end only, so the bar reads as a quantity extending
            from the spread rather than as a block that happens to be there. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            [tone === "bid" ? "right" : "left"]: 0,
            top: 2,
            bottom: 2,
            width: `${r.depth}%`,
            background: tone === "bid" ? GREEN_BAR : RED_BAR,
            borderRadius: tone === "bid" ? `${R_XS}px 0 0 ${R_XS}px` : `0 ${R_XS}px ${R_XS}px 0`,
            transition: "width .18s ease-out",
          }}
        />
        {/* The match flash. Keyed on `seq` — the tick this level last changed — so the
            element REMOUNTS when it changes and the animation replays. Toggling a class
            on a live element does not restart a CSS animation, which is the same reason
            `useFlash` re-keys the price. */}
        {r.fresh && (
          <span
            key={r.seq}
            aria-hidden="true"
            className={`nx-book-flash nx-book-flash-${tone}${r.matched ? "" : " nx-book-flash-quote"}`}
          />
        )}
        {tone === "bid" ? (
          <>
            <span style={{ position: "relative", color: DIM }}>{totalOf(r)}</span>
            <span style={{ position: "relative", color: GREEN }}>{r.price}</span>
          </>
        ) : (
          <>
            <span style={{ position: "relative", color: RED }}>{r.price}</span>
            <span style={{ position: "relative", color: DIM, textAlign: "right" }}>{totalOf(r)}</span>
          </>
        )}
      </button>
    ));

  const head = (left: string, right: string, align: "left" | "right") => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: align === "left" ? "1fr auto" : "auto 1fr",
        gap: 8,
        padding: "6px 10px 5px",
        ...monoLabel(8.5, "0.08em"),
      }}
    >
      <span>{left}</span>
      <span style={{ textAlign: "right" }}>{right}</span>
    </div>
  );

  const unit = units === "base" ? market.base : market.quote;

  return (
    /* Natural height, no internal scroll: this sits inside the trade screen's single
       scrolling region, and a scroller inside a scroller is the nested-gesture trap
       that the 87px blotter window was. Still a named focus stop — the rows are
       buttons, so the region is reachable, but axe grades the container. */
    <div
      aria-label="Order book levels"
      style={{ flex: "0 0 auto", display: "flex", flexDirection: "column" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${L1}` }}>
        <div style={{ borderRight: `1px solid ${L1}` }}>{head(`TOTAL ${unit}`, "PRICE", "left")}</div>
        <div>{head("PRICE", `TOTAL ${unit}`, "right")}</div>
      </div>
      {compactPhase.phase === "ready" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", flex: "1 1 auto", minHeight: 0 }}>
          <div style={{ borderRight: `1px solid ${L1}` }}>{half(feed.bids, "bid")}</div>
          <div>{half(asks, "ask")}</div>
        </div>
      ) : (
        /* One state across the full width, not one per side: two "Loading" lines
           side by side would read as two independent books. */
        <TableState
          count={0}
          surface="book"
          loading={compactPhase.loading}
          error={compactPhase.error}
          minHeight={140}
        />
      )}
    </div>
  );
}
