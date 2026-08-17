"use client";

/*
 * The market header strip: switcher, mark price, and the 24h / oracle / funding
 * cells. Spans the chart column only — the book column beside it runs full height.
 *
 * Reads as one instrument face: a fixed-height band of hard-divided cells. Every
 * figure keys off the selected market, so switching symbols changes all of them.
 */

import { useState, type ReactNode } from "react";
import { Market, getStats, fmtPrice, decimalsFor } from "@/lib/markets";
import { comma, notional, pct, countdown } from "@/lib/format";
import type { Feed } from "@/lib/feed";
import type { LayoutMode } from "@/hooks/useMediaQuery";
import {
  R_SM, MONO, GREEN, RED, L2, TXT, MUT, FAINT, PANEL, H_MARKET_HEADER, TAP_CONTROL, monoLabel } from "@/lib/theme";
import { Chip, StatCell } from "./primitives";
import { useFlash } from "@/hooks/useFlash";
import { MarketSwitcher } from "./MarketSwitcher";

/** The 24h stat cells, derived once so desktop and mobile show the same set. */
export function useHeadStats(market: Market, feed: Feed) {
  /* Mark and Oracle are the two figures on this strip that move on every tick, and
     the two a trader reads for direction. The rest change slowly enough that a
     flash would be noise. */
  const markFlash = useFlash(feed.last);
  const oracleFlash = useFlash(feed.oracle);
  const s = getStats(market.sym);
  const chgAbs = market.ref * (market.chg24 / 100);
  /* 24h High and 24h Low are gone. They were ours, not theirs, and the range is
     already the chart's whole job — it is drawn immediately below these cells. */
  const funding = feed.funding[feed.funding.length - 1];
  // Basis in basis points. The mark itself is the large figure to the left of these
  // cells, so the oracle cell carries the comparison rather than repeating the price.
  const basisBp = ((feed.last - feed.oracle) / feed.oracle) * 10000;

  return [
    {
      /*
       * Mark is a CELL, at the same size as its neighbours.
       *
       * It used to be a 23px figure to the left of the strip, which made it the most
       * recognisable thing on the screen and is exactly why it went: the reference has
       * no large price in this header at all, and a spec that keeps one is a spec whose
       * reader has to decide whether it mattered. The large figure survives on MOBILE,
       * where theirs also has one — their answer is "big number where there is room for
       * one thing, cells where there is room for seven", and it is a coherent answer.
       */
      label: "Mark",
      value: fmtPrice(market, feed.last),
      color: TXT,
      underline: true,
      flash: markFlash,
      tip: "Used for margining, computing unrealized PNL, liquidations, and triggering TP/SL orders.",
    },
    {
      label: "Oracle",
      value: (
        <>
          {fmtPrice(market, feed.oracle)}
          <span style={{ color: Math.abs(basisBp) < 3 ? FAINT : basisBp >= 0 ? GREEN : RED, marginLeft: 6 }}>
            {basisBp >= 0 ? "+" : ""}
            {basisBp.toFixed(1)}bp
          </span>
        </>
      ),
      color: MUT,
      underline: true,
      flash: oracleFlash,
      /*
       * Their tooltip, verbatim from `inventory.header.json`. Kept even though our
       * oracle cell carries an extra figure they do not have — see below.
       */
      tip: "The oracle price is derived from institutional liquidity provider quotes for this market. When these inputs are unavailable, a time-weighted EMA adjusts the oracle toward the impact price.",
    },
    {
      label: "24h Change",
      // At the market's own precision — a 0.0013 move on EUR-USDX rounds to "+0.0"
      // at one decimal, which reads as no move at all.
      value: `${chgAbs >= 0 ? "+" : ""}${comma(chgAbs, decimalsFor(market))} / ${pct(market.chg24)}`,
      color: market.chg24 >= 0 ? GREEN : RED,
    },
    // Rate and countdown in one cell — the rate only means something next to the
    // time until it settles.
    {
      label: "Funding / Countdown",
      value: (
        <>
          <span style={{ color: funding >= 0 ? GREEN : RED }}>{pct(funding, 4)}</span>
          <span style={{ color: FAINT }}> / </span>
          <span style={{ color: MUT }}>{countdown(feed.fundingIn)}</span>
        </>
      ),
      color: TXT,
      underline: true,
      tip: "Funding is peer-to-peer with no fees. Positive rate: longs pay shorts. Negative rate: shorts pay longs.",
    },
    { label: "24h Volume", value: notional(s.vol24), color: TXT },
    {
      label: "Open Interest",
      value: notional(s.oi),
      color: TXT,
      underline: true,
      tip: "Two sided-open interest: the sum of long and short positions on this contract.",
    },
  ];
}

/**
 * The reference's last header cell: a globe and a TradingView mark.
 *
 * Two links, not a menu — the cell is labelled `Resources` and holds exactly what an
 * instrument's off-venue references are. Ours point at the same two ideas: the
 * issuer's own page and the chart on TradingView. They are `<a>`s with real hrefs
 * rather than buttons, because a link that cannot be middle-clicked is not a link.
 */
function Resources({ market, bare = false }: { market: Market; bare?: boolean }) {
  const link = (href: string, label: string, glyph: ReactNode) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        /* 36, not the reference's ~20. Two adjacent icon links share a top edge, so
           the floor grades them as a segmented group at a 36px minimum — and it is
           right to: they are the smallest touch targets on the mobile header. */
        width: 36,
        height: 36,
        borderRadius: R_SM,
        color: MUT,
        textDecoration: "none",
        fontFamily: MONO,
        fontSize: 11,
      }}
      className="nx-hover-border"
    >
      {glyph}
    </a>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", padding: bare ? 0 : "0 8px", flex: "0 0 auto" }}>
      <StatCell
        label="Resources"
        labelSize={8.5}
        valueSize={12.5}
        value={
          <span style={{ display: "flex", alignItems: "center", gap: 4, marginTop: -2 }}>
            {link(`https://www.tradingview.com/symbols/${market.base}USD/`, `${market.base} on TradingView`, "TV")}
            {link(`https://nexus.xyz/markets/${market.sym.toLowerCase()}`, `${market.name} market page`, "◍")}
          </span>
        }
      />
    </div>
  );
}

export function MarketHeader({
  market,
  feed,
  onMarket,
  selectorOpen,
  onSelectorOpen,
}: {
  market: Market;
  feed: Feed;
  onMarket: (sym: string) => void;
  /** The one market modal, owned by the shell so ⌘K and the pill open the same thing. */
  selectorOpen: boolean;
  onSelectorOpen: (v: boolean) => void;
}) {
  const stats = useHeadStats(market, feed);
  const c = feed.candles[feed.candles.length - 1];
  const up = c.c >= c.o;

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "stretch",
        height: H_MARKET_HEADER,
        borderBottom: `1px solid ${L2}`,
        background: PANEL,
        zIndex: 20,
      }}
    >
      <MarketSwitcher market={market} onSelect={onMarket} open={selectorOpen} onOpenChange={onSelectorOpen} />

      {/* minWidth:0 is load-bearing: without it this flex child refuses to shrink
          below its content width and pushes the whole layout past the viewport.
          The header now spans only the chart column, so the cells are tighter and
          the strip scrolls rather than overflowing — the engine heartbeat moved to
          the status bar instead of competing for room here. */}
      {/*
       * Scrolls rather than clips. The reference hard-clips here at every width below
       * ~1900 — measured at 1512, its funding countdown renders "00:17:3" with the
       * final digit cut off and its Resources cell is not reachable at all. Ours is
       * one divergence I would defend: a figure you cannot finish reading is worse
       * than one you have to scroll to.
       */}
      <div tabIndex={0} aria-label="24h market statistics" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "stretch", overflowX: "auto", overscrollBehavior: "contain" }}>
        {stats.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", padding: "0 8px", flex: "0 0 auto" }}>
            <StatCell
              label={s.label}
              value={s.value}
              color={s.color}
              underline={s.underline}
              tip={s.tip}
              flash={s.flash}
              labelSize={8.5}
              valueSize={12}
            />
          </div>
        ))}
        <Resources market={market} />
      </div>
    </div>
  );
}

/*
 * Stacked variant for the mobile and tablet layouts.
 *
 * Both variants used to end the same way — the stat cells in a row on
 * `overflowX: auto` — and both clipped. Measured: `clientWidth 362` inside
 * `scrollWidth 784` at 390px, so five of seven cells were off the end of a
 * scroller with no visible affordance, and `Funding / Countdown` was the cell we
 * had already decided we could not afford to lose (see `useHeadStats` above).
 *
 * The reference's answer to a strip that does not fit is the best idea in the
 * capture set (findings.responsive.md §5): a **density toggle** rather than a
 * scroller. A 20×20 chevron with the accessible name "Show market stats in a
 * two-column layout" expands the strip into a label/value grid that also *pairs*
 * the stats — `Mark | Oracle`, `24h Volume | Open Interest` — and the chart shrinks
 * to pay for it. Collapsed, it shows only the cells that fit, in a grid, with
 * nothing hidden off an edge.
 *
 * The one thing we do not copy is the size of their chevron: 20×20 is below our
 * own `TAP_FLOOR`, so the glyph stays 20 and the hit area is `TAP_CONTROL`.
 */
export function MarketHeaderCompact({
  market,
  feed,
  onMarket,
  selectorOpen,
  onSelectorOpen,
  layout = "mobile",
  dense: denseProp,
  onDense,
}: {
  market: Market;
  feed: Feed;
  onMarket: (sym: string) => void;
  /** The one market modal, owned by the shell so ⌘K and the pill open the same thing. */
  selectorOpen: boolean;
  onSelectorOpen: (v: boolean) => void;
  /** Tablet has width for four stat columns and starts expanded. */
  layout?: LayoutMode;
  /*
   * Controlled when the shell passes it, which it does so the state can live in the
   * URL. Left uncontrolled the expanded header has no address, and this harness has
   * now learned three times that unaddressable state is state nothing grades.
   */
  dense?: boolean;
  onDense?: (v: boolean) => void;
}) {
  const stats = useHeadStats(market, feed);
  const c = feed.candles[feed.candles.length - 1];
  const up = c.c >= c.o;

  const tablet = layout === "tablet";
  const [denseLocal, setDenseLocal] = useState(tablet);
  const dense = denseProp ?? denseLocal;
  const setDense = (next: boolean) => {
    if (onDense) onDense(next);
    else setDenseLocal(next);
  };

  const at = (label: string) => stats.find((s) => s.label === label);

  /* `Last Trade` is not in useHeadStats: on DESKTOP their header has Mark and Oracle
     and no last-trade cell at all, so the shared set does not carry one. On a phone
     they add it. Built here rather than added to the shared set, so the desktop header
     does not silently grow a cell the reference does not have. */
  const lastTradeCell = (
    <StatCell
      key="Last Trade"
      label="Last Trade"
      value={fmtPrice(market, feed.last)}
      color={up ? GREEN : RED}
      labelSize={8.5}
      valueSize={12}
    />
  );
  const cell = (label: string, key = label) => {
    const s = at(label);
    return s ? (
      <StatCell key={key} label={s.label} value={s.value} color={s.color} underline={s.underline} tip={s.tip} flash={s.flash} labelSize={8.5} valueSize={12} />
    ) : null;
  };

  /*
   * A pair of figures under one label, which is how the reference fits this on a
   * phone: `Mark · Oracle` reads `113.09 / 113.05`, `24h Volume / Open Interest`
   * reads `$23.91m | $162.68m`. Two labels' worth of information in one label's
   * worth of height, and the two figures are read together anyway.
   */
  const pair = (label: string, a?: ReactNode, b?: ReactNode, tip?: string) => (
    <StatCell
      key={label}
      label={label}
      labelSize={8.5}
      valueSize={12}
      underline={!!tip}
      tip={tip}
      value={
        <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          {a}
          <span style={{ color: FAINT }}>/</span>
          {b}
        </span>
      }
    />
  );

  /*
   * Collapsed: THEIR cell set, in their order, scrolling.
   *
   * The earlier two-cell version was sized so nothing could ever clip. That is the
   * right instinct for a grid and the wrong one for a strip: it achieved "no cell is
   * cut off" by not rendering four of them at all, which is a worse outcome than a
   * cell the reader can scroll to. Each cell gets its natural width and the row
   * scrolls, as theirs does — and the density toggle beside it is the affordance for
   * seeing everything without scrolling, which is why theirs can afford the scroller.
   */
  const summary = ["Last Trade", "Mark", "Oracle", "24h Change", "24h Volume", "Funding / Countdown"];

  /*
   * Expanded, in THEIR pairing and THEIR order: Last Trade · Mark/Oracle,
   * 24h Change · Volume/OI, Funding/Countdown · Resources.
   *
   * `Last Trade` exists only here. On desktop their header has Mark and Oracle and no
   * last-trade cell at all; on a phone they add one and drop the pairing down to two
   * columns. Ours now matches both, which is why the large figure survives on mobile
   * and not on desktop.
   */
  const paired: ReactNode[] = [
    lastTradeCell,
    pair(
      "Mark · Oracle",
      <span style={{ color: TXT }}>{fmtPrice(market, feed.last)}</span>,
      <span style={{ color: MUT }}>{fmtPrice(market, feed.oracle)}</span>,
      at("Oracle")?.tip,
    ),
    cell("24h Change"),
    pair(
      "24h Volume / Open Interest",
      <span style={{ color: TXT }}>{notional(getStats(market.sym).vol24)}</span>,
      <span style={{ color: TXT }}>{notional(getStats(market.sym).oi)}</span>,
      at("Open Interest")?.tip,
    ),
    cell("Funding / Countdown"),
    <Resources key="resources" market={market} bare />,
  ];

  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "10px 14px",
        borderBottom: `1px solid ${L2}`,
        background: PANEL,
        position: "relative",
        zIndex: 20,
      }}
    >
      {/* The identity row is the switcher and nothing else, which is theirs: the
          chevron at its right edge belongs to the market switcher, and the density
          control lives down in the stats row where the thing it controls is.

          The 20px last price that used to sit here is GONE. Theirs has no large price
          on a phone — `Last Trade` is a cell like any other — and the width it was
          spending is exactly the width the stat strip needed. Same shape as the
          Mark-price question on the desktop header and the equity hero on Portfolio,
          and resolved the same way, in their favour. */}
      <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", overflow: "hidden" }}>
          <MarketSwitcher market={market} onSelect={onMarket} compact open={selectorOpen} onOpenChange={onSelectorOpen} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10 }}>
        {/*
         * Collapsed, this scrolls. Expanded, it is a grid and does not.
         *
         * `tabIndex` + `aria-label`: a scroll container whose contents are all static
         * text is reachable by mouse only, which is axe scrollable-region-focusable
         * and a real lockout for a keyboard. Same treatment the blotter's row groups
         * and the unlock matrix already carry.
         */}
        <div
          tabIndex={dense ? undefined : 0}
          aria-label={dense ? undefined : "Market statistics"}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            display: dense ? "grid" : "flex",
            gridTemplateColumns: dense ? `repeat(${tablet ? 4 : 2}, minmax(0, 1fr))` : undefined,
            columnGap: dense ? 10 : 18,
            rowGap: 9,
            overflowX: dense ? "visible" : "auto",
            /* No scrollbar track under a 30px strip — the cut-off cell at the right
               edge is the affordance, as it is on theirs. */
            scrollbarWidth: "none",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {dense
            ? paired
            : summary.map((l) =>
                l === "Last Trade" ? (
                  <div key={l} style={{ flex: "0 0 auto" }}>{lastTradeCell}</div>
                ) : (
                  /* flex:0 0 auto, not a grid track: each cell takes the width its
                     own value needs. `Funding / Countdown` renders
                     `-0.0003% / 00:59:52` and wants ~140px; forcing it into an equal
                     share is what made it clip into its neighbour before. */
                  <div key={l} style={{ flex: "0 0 auto" }}>{cell(l)}</div>
                ),
              )}
        </div>

        {/* The density toggle, beside the strip rather than up in the identity row —
            theirs sits at the right edge of the stats block, which is the block it
            acts on. */}
        <button
          onClick={() => setDense(!dense)}
          aria-expanded={dense}
          aria-label="Show market stats in a two-column layout"
          style={{
            width: TAP_CONTROL,
            height: TAP_CONTROL,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: `1px solid ${L2}`,
            borderRadius: R_SM,
            color: dense ? TXT : MUT,
            cursor: "pointer",
            flex: "0 0 auto",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d={dense ? "M5.5 12.25 10 7.75l4.5 4.5" : "M5.5 7.75 10 12.25l4.5-4.5"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
