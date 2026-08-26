"use client";

/*
 * The terminal's shared vocabulary: ticked panels, panel headers, tab strips,
 * chips, label/value stat cells, and the grid-based table row.
 *
 * These exist so a new panel is assembled from named parts rather than from
 * fresh inline styles, and so the same "machine" detailing (corner ticks, mono
 * micro-labels, green underline on the active tab) appears identically everywhere.
 */

import {
  Children,
  cloneElement,
  CSSProperties,
  isValidElement,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MONO,
  ARCHIVO,
  GREEN,
  RED,
  L0,
  L1,
  L2,
  L3,
  TXT,
  HI,
  MUT,
  DIM,
  FAINT,
  PANEL,
  SUNK,
  monoLabel,
  titleLabel,
  R_LG,
  R_SM,
  TAP_FLOOR,
} from "@/lib/theme";
import { useDataPhase, type Surface } from "@/lib/dataphase";
import { LoadingFigure } from "./states";
import { ABSENT_GLYPH } from "@/lib/api/absence";

/** The four L-shaped rules that mark a panel as an instrument, not a card. */
export function CornerTicks({ inset = 7, size = 9, color = L3 }: { inset?: number; size?: number; color?: string }) {
  const base: CSSProperties = { position: "absolute", width: size, height: size, pointerEvents: "none" };
  return (
    <>
      <span style={{ ...base, top: inset, left: inset, borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}` }} />
      <span style={{ ...base, top: inset, right: inset, borderTop: `1px solid ${color}`, borderRight: `1px solid ${color}` }} />
      <span style={{ ...base, bottom: inset, left: inset, borderBottom: `1px solid ${color}`, borderLeft: `1px solid ${color}` }} />
      <span style={{ ...base, bottom: inset, right: inset, borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}` }} />
    </>
  );
}

/** Raised panel. `ticked` adds the corner rules. */
export function Panel({
  children,
  ticked = false,
  radius = R_LG,
  style,
}: {
  children: ReactNode;
  ticked?: boolean;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "relative", background: PANEL, border: `1px solid ${L2}`, borderRadius: radius, ...style }}>
      {ticked && <CornerTicks />}
      {children}
    </div>
  );
}

/**
 * Sunk container for tables and tapes.
 *
 * No role by default. An earlier attempt put `role="table"` here, but Surface also
 * wraps a SectionHeader, and a table whose child is not a row is
 * aria-required-children. The table role belongs on the element that directly
 * contains the rows — see `Table` below.
 */
export function Surface({ children, style, role }: { children: ReactNode; style?: CSSProperties; role?: string }) {
  return (
    <div role={role} style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: R_LG, overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

/** Mono uppercase header bar for a fixed-height panel. */
export function PanelHeader({
  title,
  right,
  height = 34,
}: {
  title: string;
  right?: ReactNode;
  height?: number;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 16,
        height,
        padding: "0 14px",
        borderBottom: `1px solid ${L1}`,
        ...monoLabel(10, "0.12em"),
      }}
    >
      {/* The panel's NAME is sentence case; whatever the caller puts in `right` is
          usually a field label and keeps the mono voice it inherits from this row. */}
      <span style={{ ...titleLabel(12.5), color: TXT }}>{title}</span>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/** Sentence-case header for a content panel (Portfolio, Markets). */
export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div
      style={{
        padding: "13px 18px",
        borderBottom: `1px solid ${L2}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: TXT, fontFamily: ARCHIVO }}>{title}</span>
      {right}
    </div>
  );
}

/**
 * The element that directly contains rows, and nothing else.
 *
 * HeadRow and Row carry role="row" / role="columnheader"; a row with no table
 * ancestor is aria-required-parent, and a table with a non-row child is
 * aria-required-children. So the role goes exactly here — around the header row and
 * the row group, and around nothing else.
 */
export function Table({ children, label, style }: { children: ReactNode; label: string; style?: CSSProperties }) {
  return (
    <div role="table" aria-label={label} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto", ...style }}>
      {children}
    </div>
  );
}

/**
 * A scrollable group of rows.
 *
 * tabIndex={0} is required, not optional: a scroll container that is not focusable
 * has content reachable only by mouse, which axe reports as
 * scrollable-region-focusable and which genuinely locks keyboard users out of the
 * book, the tape and the blotter.
 */
export function RowGroup({ children, label, style }: { children: ReactNode; label: string; style?: CSSProperties }) {
  return (
    <div
      role="rowgroup"
      tabIndex={0}
      aria-label={label}
      /* `contain` stops a flick past the end of a table from chaining into the shell
         behind it — the single most common way a fixed-layout app feels broken on a
         phone. Every blotter table scrolls through this one component. */
      style={{ flex: "1 1 0", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", ...style }}
    >
      {children}
    </div>
  );
}

/**
 * Base ⇄ quote unit toggle.
 *
 * The reference carries one on both liquidity panes — `USDC` on the book, `SPCX` on the
 * tape — and the two show the SAME control with a different current value, which is the
 * clue that it is one setting and not two. Ours is one piece of URL state for that
 * reason: switching units on the tape and finding the book still in the other unit
 * would be a bug you could only find by looking at both.
 *
 * Sizes are the thing being converted. A size in base answers "how much of the
 * instrument", a size in quote answers "how much money", and which one a trader wants
 * depends entirely on whether they think in coins or in dollars.
 */
export function UnitToggle({
  base,
  quote,
  value,
  onChange,
}: {
  base: string;
  quote: string;
  value: "base" | "quote";
  onChange: (v: "base" | "quote") => void;
}) {
  const label = value === "base" ? base : quote;
  return (
    <button
      onClick={() => onChange(value === "base" ? "quote" : "base")}
      aria-label={`Sizes in ${label}. Switch to ${value === "base" ? quote : base}`}
      /* No inline `minHeight`. `nx-inline-control` raises this to 36 under a coarse
         pointer, and an inline value would beat the rule — which is exactly how this
         control shipped at 24px and failed the floor. Third time on this project. */
      className="nx-inline-control nx-hover-border"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 8px",
        border: `1px solid ${L2}`,
        borderRadius: R_SM,
        background: "transparent",
        color: MUT,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.06em",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {label}
      <span aria-hidden="true" style={{ color: FAINT, fontSize: 8 }}>▾</span>
    </button>
  );
}

export type TabDef<T extends string> = { id: T; label: string; badge?: string | number };

/** Underlined tab strip. Used for chart views and the blotter. */
export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
  height = 38,
  gap = 18,
  size = 12.5,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onSelect: (id: T) => void;
  height?: number;
  gap?: number;
  size?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap, fontSize: size }}>
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            style={{
              height,
              /* A tab's width is its label plus its count, and the count is DATA — it
                 disappears while the response is in flight. `TWAP` alone measured
                 34.6px against a 36px floor, so the strip failed the moment the
                 loading state became reachable. The floor is a property of the
                 control, not of the widest thing it happens to contain. */
              minWidth: 36,
              justifyContent: "center",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: 0,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: on ? TXT : FAINT,
              borderBottom: `2px solid ${on ? GREEN : "transparent"}`,
              fontFamily: ARCHIVO,
              fontSize: size,
              /* The underline appeared and vanished instantly while the label faded.
                 Two properties on one control changing at different speeds is what
                 makes a tab strip feel unfinished. */
              transition: "color .12s, border-color .12s",
            }}
          >
            {t.label}
            {t.badge !== undefined && t.badge !== "" && (
              <span style={{ fontFamily: MONO, color: FAINT, fontSize: size - 1 }}>{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A tab strip that survives more tabs than fit.
 *
 * The reference does not: at 1440 its tenth blotter label is hard-truncated
 * mid-word with no affordance at all — captured as "Account Activ", then "Acc",
 * then "A" as the right-side filter grows. A label clipped to one letter is not a
 * degraded control, it is a hidden one, and the user has no way to know the tab
 * exists. Our blotter is heading from four tabs to eight in the same width, so the
 * strategy has to exist before the tabs do.
 *
 * What happens instead: tabs that do not fit move into a MORE menu, and the count
 * on that button says how many. Two rules make it usable rather than merely
 * non-broken —
 *
 *   1. The ACTIVE tab is never in the overflow. If it would be, it swaps with the
 *      last visible tab, so the thing you are looking at is always the thing you
 *      can see. Without this, selecting from the menu makes the tab you just chose
 *      disappear.
 *   2. Widths are measured ONCE while every tab is mounted, then cached. Measuring
 *      the visible subset would feed the next calculation a smaller total and
 *      oscillate.
 *
 * The first render — server and client — shows every tab, so hydration matches;
 * the reduction happens in a layout effect afterwards.
 *
 * `scroll` turns all of that off and lets the strip scroll horizontally instead.
 *
 * That is what the reference does ON A PHONE — and only on a phone; at 1440 it clips,
 * which is the bug this component exists to avoid. Two mechanisms for one control is a
 * cost, and it is the right cost here: a menu is better than a clipped label, and a
 * scroller is better than a menu when the strip is the widest thing on a 390px screen
 * and a thumb is already swiping. Each width gets the mechanism the evidence at that
 * width supports.
 */
export function OverflowTabs<T extends string>({
  tabs,
  active,
  onSelect,
  height = 36,
  gap = 20,
  size = 12,
  /** Space to leave for whatever shares the strip (filters, bulk actions, links). */
  reserve = 0,
  /** Scroll the full strip instead of overflowing into a menu. See the note above. */
  scroll = false,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onSelect: (id: T) => void;
  height?: number;
  gap?: number;
  size?: number;
  reserve?: number;
  scroll?: boolean;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const widths = useRef<number[]>([]);
  const [visible, setVisible] = useState(tabs.length);
  /*
   * The menu is positioned FIXED, from the More button's measured rect, rather than
   * absolutely inside the strip.
   *
   * The strip is `overflow: hidden` — it has to be, or the pre-measure render in
   * which every tab is mounted would flash a row wider than the panel. An absolutely
   * positioned child of that strip is clipped to a 36px band, so the menu rendered
   * completely outside its clipper and was invisible at every viewport. It had text,
   * it had a box, and `allInnerTexts()` read it back happily — which is exactly why
   * the original check passed. Fixed positioning escapes ancestor overflow, and
   * nothing above this has a transform to defeat it.
   */
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el || widths.current.length !== tabs.length) return;
    const avail = el.clientWidth - reserve;
    // The MORE button only costs width if it is going to be rendered at all.
    const MORE_W = 74;
    let used = 0;
    let n = 0;
    for (let i = 0; i < tabs.length; i++) {
      const next = used + widths.current[i] + (i > 0 ? gap : 0);
      const needsMore = i < tabs.length - 1;
      if (next + (needsMore ? gap + MORE_W : 0) > avail) break;
      used = next;
      n++;
    }
    setVisible(Math.max(1, n));
  }, [tabs.length, gap, reserve]);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    // Cache while everything is mounted — this runs before any reduction.
    if (widths.current.length !== tabs.length) {
      const kids = Array.from(el.querySelectorAll("[data-tab]")) as HTMLElement[];
      if (kids.length === tabs.length) widths.current = kids.map((k) => k.offsetWidth);
    }
    measure();
  }, [tabs.length, measure]);

  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  let shown = tabs.slice(0, visible);
  let hidden = tabs.slice(visible);
  // Rule 1: the active tab is never hidden.
  if (hidden.some((t) => t.id === active)) {
    const swapOut = shown[shown.length - 1];
    shown = [...shown.slice(0, -1), tabs.find((t) => t.id === active) as TabDef<T>];
    hidden = tabs.filter((t) => !shown.includes(t));
    void swapOut;
  }

  const tabButton = (t: TabDef<T>, inMenu: boolean) => {
    const on = t.id === active;
    return (
      <button
        key={t.id}
        data-tab={inMenu ? undefined : ""}
        /*
         * `menuitem` in the overflow, `tab` in the strip. Not cosmetic: a
         * `role="menu"` may only contain menuitems, and a `role="tablist"` may only
         * contain tabs — which is also why the More button itself had to move OUT of
         * the tablist below. axe caught that the moment eight tabs made the strip
         * overflow for the first time; before that the button never rendered.
         */
        role={inMenu ? "menuitem" : "tab"}
        aria-selected={inMenu ? undefined : on}
        aria-current={inMenu && on ? "true" : undefined}
        onClick={() => {
          onSelect(t.id);
          setMenu(null);
        }}
        className={inMenu ? "nx-row" : undefined}
        style={{
          height: inMenu ? 30 : height,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: inMenu ? "0 12px" : 0,
          width: inMenu ? "100%" : undefined,
          /* Same floor as `Tabs`: the count is data and vanishes while the response
             is in flight, and `TWAP` on its own measured 34.6 against 36. A control
             whose minimum size depends on whether its data arrived is not a control
             with a minimum size. */
          minWidth: inMenu ? undefined : 36,
          justifyContent: inMenu ? undefined : "center",
          border: "none",
          background: inMenu && on ? "rgba(14,203,129,0.08)" : "transparent",
          cursor: "pointer",
          color: on ? (inMenu ? GREEN : TXT) : FAINT,
          borderBottom: inMenu ? undefined : `2px solid ${on ? GREEN : "transparent"}`,
          fontFamily: ARCHIVO,
          fontSize: size,
          whiteSpace: "nowrap",
          transition: "color .12s, border-color .12s",
        }}
      >
        {t.label}
        {/* Parenthesised, as theirs: `Balances (1)`. A bare number beside a word reads
            as part of the label at a glance — "Positions 3" looks like the name of a
            thing — where the brackets say "count of". Noted from the connected pass
            over the reference venue and unfixed until now. */}
        {t.badge !== undefined && t.badge !== "" && (
          <span style={{ fontFamily: MONO, color: FAINT, fontSize: size - 1 }}>({t.badge})</span>
        )}
      </button>
    );
  };

  if (scroll) {
    return (
      <div
        /* Focusable and named: a horizontal scroller whose contents are all buttons is
           still a scroll region, and axe grades it. The tabs inside are reachable by
           Tab, so this is a named region rather than a keyboard trap. */
        role="tablist"
        aria-label="Blotter"
        style={{
          display: "flex",
          alignItems: "center",
          gap,
          minWidth: 0,
          flex: 1,
          overflowX: "auto",
          /* The cut-off tab at the right edge is the affordance, as it is on theirs.
             A scrollbar track under a 36px strip is more chrome than signal. */
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {tabs.map((t) => (
          <div key={t.id} style={{ flex: "0 0 auto" }}>
            {tabButton(t, false)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={stripRef}
      style={{ display: "flex", alignItems: "center", gap, minWidth: 0, flex: 1, overflow: "hidden" }}
    >
      <div role="tablist" style={{ display: "flex", alignItems: "center", gap, minWidth: 0 }}>
        {shown.map((t) => tabButton(t, false))}
      </div>
      {hidden.length > 0 && (
        <div style={{ position: "relative", flex: "0 0 auto" }}>
          <button
            ref={moreRef}
            onClick={() => {
              if (menu) return setMenu(null);
              const r = moreRef.current?.getBoundingClientRect();
              if (!r) return;
              // Flip upward when there is not room below — the mobile blotter sits at
              // the bottom of the viewport, where down is always the wrong way.
              const estimated = Math.min(hidden.length, 8) * 30 + 8;
              const up = r.bottom + estimated > window.innerHeight - 8;
              /*
               * Left-anchored and CLAMPED to the viewport. Anchoring the menu's right
               * edge to the button's put it 12px off the left of a 390px screen — the
               * More button sits near the left once only two tabs fit, so "align right
               * edges" walks the menu off the side of the phone.
               */
              const W = 172;
              setMenu({
                top: up ? Math.max(8, r.top - estimated - 4) : r.bottom + 4,
                left: Math.min(Math.max(8, r.left), window.innerWidth - W - 8),
              });
            }}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            style={{
              height,
              display: "flex",
              alignItems: "center",
              gap: 5,
              border: "none",
              background: "transparent",
              color: FAINT,
              fontFamily: ARCHIVO,
              fontSize: size,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            More
            <span style={{ fontFamily: MONO, fontSize: size - 1 }}>{hidden.length}</span>
            <span style={{ fontSize: 8 }}>▾</span>
          </button>
          {menu && (
            <>
              <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
              <div
                role="menu"
                style={{
                  position: "fixed",
                  top: menu.top,
                  left: menu.left,
                  minWidth: 172,
                  maxHeight: "60vh",
                  overflowY: "auto",
                  zIndex: 61,
                  background: "#0d0d0d",
                  border: `1px solid ${L3}`,
                  borderRadius: 7,
                  boxShadow: "0 18px 44px rgba(0,0,0,0.8)",
                  overflow: "hidden",
                  padding: "3px 0",
                }}
              >
                {hidden.map((t) => tabButton(t, true))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact segmented control — timeframes, book grouping, portfolio windows. */
export function Segmented<T extends string | number>({
  options,
  active,
  onSelect,
  format = String,
}: {
  options: readonly T[];
  active: T;
  onSelect: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, fontFamily: MONO, fontSize: 11 }}>
      {options.map((o) => {
        const on = o === active;
        return (
          <button
            key={String(o)}
            onClick={() => onSelect(o)}
            /* Height lives in the stylesheet, NOT inline.
               An inline `minHeight` beats any class rule — that is what defeated the
               first attempt at this fix, exactly as an inline `padding` shorthand once
               defeated a `padding-left` rule on the close glyph. `.nx-segmented` sets
               TAP_FLOOR at desktop and the segmented tier's 36px under a coarse
               pointer, which is what the season picker (S1…S7) and the chart
               timeframes failed on. */
            className="nx-segmented"
            style={{
              padding: "3px 9px",
              borderRadius: R_SM,
              border: "none",
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: 11,
              color: on ? "#000" : FAINT,
              background: on ? GREEN : "transparent",
              fontWeight: on ? 500 : 400,
              /* The timeframe and grouping controls snapped between transparent and
                 full green. At 11px that reads as a repaint rather than a selection. */
              transition: "background .14s ease-out, color .14s ease-out",
            }}
          >
            {format(o)}
          </button>
        );
      })}
    </div>
  );
}

/** Directional pill — 24h change, LONG/SHORT, maker/taker. */
export function Chip({
  children,
  tone = "neutral",
  size = 12,
}: {
  children: ReactNode;
  tone?: "up" | "down" | "neutral";
  size?: number;
}) {
  const c = tone === "up" ? GREEN : tone === "down" ? RED : MUT;
  const bg =
    tone === "up" ? "rgba(14,203,129,0.10)" : tone === "down" ? "rgba(246,70,93,0.10)" : "rgba(255,255,255,0.04)";
  const bd =
    tone === "up" ? "rgba(14,203,129,0.22)" : tone === "down" ? "rgba(246,70,93,0.22)" : L2;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: MONO,
        fontSize: size,
        color: c,
        background: bg,
        border: `1px solid ${bd}`,
        borderRadius: R_SM,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Label-over-value pair — the market header strip and mobile stat rows. */
export function StatCell({
  label,
  value,
  color = TXT,
  align = "left",
  labelSize = 9,
  valueSize = 13,
  icon,
  underline = false,
  tip,
  flash,
  surface = "market",
}: {
  label: string;
  value: ReactNode;
  color?: string;
  align?: "left" | "right";
  labelSize?: number;
  valueSize?: number;
  icon?: ReactNode;
  /** Dotted underline — marks a term with a definition behind it. */
  underline?: boolean;
  /** `nx-flash-up` / `nx-flash-down`, from useFlash. */
  flash?: string;
  /**
   * The definition itself. The dotted underline was promising one and delivering
   * nothing: `underline` set a `cursor: help` on four labels with no title behind
   * any of them, which is a tell drawn without a fact.
   */
  tip?: string;
  /** Which loading region this figure belongs to. See lib/dataphase. */
  surface?: Surface;
}) {
  /*
   * The region is the CALLER'S to name, and the default is market.
   *
   * The first version defaulted every stat cell to `account`, with a comment
   * rationalising it as "the safer default". Then `?load=public` was captured and the
   * rationalisation was visibly wrong: the market header's Mark, Oracle, 24h Change,
   * Funding, Volume and Open Interest all sat as loading bars while the book beside
   * them was live. They are market data. A default that is wrong on the surface it is
   * most used on is not a default, it is a bug with an excuse attached — and it took
   * one capture of a state that could not previously be reached to see it.
   *
   * Market is the default because that is what a bare `StatCell` renders in this app;
   * account cells say so.
   */
  const phase = useDataPhase(surface);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, whiteSpace: "nowrap", alignItems: align === "right" ? "flex-end" : "flex-start" }}>
      <span
        title={tip}
        style={{
          ...monoLabel(labelSize, "0.11em"),
          display: "flex",
          alignItems: "center",
          gap: 5,
          borderBottom: underline ? `1px dotted ${L2}` : undefined,
          cursor: underline || tip ? "help" : undefined,
        }}
      >
        {icon}
        {label}
      </span>
      {phase !== "ready" ? (
        /*
         * One place, every stat cell in the app.
         *
         * Wiring the phase into each caller would have meant threading it through the
         * market header, the account panel and Portfolio separately, and the third one
         * would have been forgotten. Here it is a property of the cell.
         *
         * Cold gets a bar measured in CHARACTERS, not a spinner: these figures are
         * mono, so a `ch`-width bar occupies exactly the space the number will and the
         * strip does not reflow when it lands. Error gets the absent glyph — a pulsing
         * bar forever would say "still coming", which after a 503 is a lie.
         */
        phase === "cold" ? (
          /* Height tracks the FONT SIZE, not something smaller that looks tidy: the
             market-stat strip is a focus stop graded at the 32px floor, and an 11px
             bar in place of a 13px figure took the whole region to 28. A skeleton
             that changes the layout is not a skeleton. */
          <span style={{ display: "flex", alignItems: "center", height: valueSize + 4 }}>
            <LoadingFigure chars={Math.min(10, Math.max(4, String(value ?? "").length || 6))} height={valueSize - 2} />
          </span>
        ) : (
          <span style={{ fontFamily: MONO, fontSize: valueSize, color: FAINT }}>{ABSENT_GLYPH}</span>
        )
      ) : (
        <span
          key={flash}
          className={flash}
          /* `key` on the flash class is what restarts the animation: React reuses the
             node otherwise and a class that is already applied does not re-run. */
          style={{ fontFamily: MONO, fontSize: valueSize, color, padding: flash ? "1px 4px" : undefined, margin: flash ? "-1px -4px" : undefined }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/** Big-number KPI tile with a ticked frame. */
export function StatTile({
  label,
  value,
  sub,
  subColor = GREEN,
  valueColor = "#f4f4f4",
  valueSize = 22,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  subColor?: string;
  valueColor?: string;
  valueSize?: number;
}) {
  return (
    <Panel ticked style={{ padding: "15px 16px" }}>
      <div style={monoLabel(9.5, "0.1em")}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: valueSize, color: valueColor, marginTop: 8, letterSpacing: "-0.01em" }}>
        {value}
      </div>
      {sub !== undefined && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: subColor, marginTop: 5 }}>{sub}</div>
      )}
    </Panel>
  );
}

/** Pulsing status dot. */
export function StatusDot({ color = GREEN, size = 6, pulse = true }: { color?: string; size?: number; pulse?: boolean }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 ${size + 1}px ${color}`,
        animation: pulse ? "nxpulse 2.4s infinite" : undefined,
        flex: "0 0 auto",
      }}
    />
  );
}

/**
 * Column-header row for a grid table.
 *
 * `role="row"` + `role="columnheader"` are load-bearing, not decoration: these are
 * CSS-grid divs, not a <table>, so without the roles a screen reader sees a list of
 * unrelated strings and cannot navigate the blotter by column. The audit's structural
 * extractor also reads columnheader — before these roles existed it reported zero
 * columns on our side and the whole column diff against the reference was empty.
 */
export type HeadCol = {
  label: string;
  align?: "left" | "right" | "center";
  /** Sortable columns carry a chevron and a button role; the rest are plain text. */
  sortable?: boolean;
  sortDir?: "asc" | "desc";
  onSort?: () => void;
};

export function HeadRow({
  cols,
  template,
  padding = "7px 16px",
  lead,
}: {
  cols: readonly (string | HeadCol)[];
  template: string;
  padding?: string;
  /** Rendered in a leading cell before the columns — the select-all checkbox. */
  lead?: ReactNode;
}) {
  return (
    <div
      role="row"
      style={{
        flex: "0 0 auto",
        display: "grid",
        gridTemplateColumns: template,
        // Without a gap, a right-aligned cell touches the left-aligned one next to
        // it and the two read as one string ("FILLEDFLAGS").
        columnGap: 10,
        padding,
        ...monoLabel(9, "0.08em"),
      }}
    >
      {lead !== undefined && <span role="columnheader">{lead}</span>}
      {cols.map((c, i) => {
        const label = typeof c === "string" ? c : c.label;
        const align = typeof c === "string" ? (i === 0 ? "left" : "right") : (c.align ?? "right");
        const sortable = typeof c === "string" ? false : !!c.sortable;
        const dir = typeof c === "string" ? undefined : c.sortDir;
        if (!sortable) {
          return (
            <span key={label + i} role="columnheader" style={{ textAlign: align }}>
              {label}
            </span>
          );
        }
        return (
          <span key={label + i} role="columnheader" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} style={{ textAlign: align }}>
            <button
              onClick={typeof c === "string" ? undefined : c.onSort}
              style={{
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                letterSpacing: "inherit",
                // Lit only while it is the active sort — a permanently bright header
                // reads as selected and every column would look active at once.
                color: dir ? TXT : "inherit",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                flexDirection: align === "right" ? "row-reverse" : "row",
              }}
            >
              {label}
              <span aria-hidden="true" style={{ fontSize: 7, opacity: dir ? 1 : 0.45 }}>
                {dir === "asc" ? "▲" : "▼"}
              </span>
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Body row for a grid table. Hairline bottom border, hover via .nx-row. */
export function Row({
  template,
  children,
  onClick,
  padding = "9px 16px",
  size = 12,
}: {
  template: string;
  children: ReactNode;
  onClick?: () => void;
  padding?: string;
  size?: number;
}) {
  return (
    <div
      role="row"
      className={onClick ? "nx-row" : undefined}
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        columnGap: 10,
        padding,
        borderBottom: `1px solid ${L0}`,
        fontFamily: MONO,
        fontSize: size,
        alignItems: "center",
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {/* A role="row" requires cell / columnheader / gridcell children — the cells
          are plain spans supplied by the caller, so the role is applied here rather
          than asking twenty call sites to remember it. */}
      {Children.map(children, (child) =>
        isValidElement(child) && !(child.props as { role?: string }).role
          ? cloneElement(child as React.ReactElement<{ role?: string }>, { role: "cell" })
          : child,
      )}
    </div>
  );
}

/** Right-aligned numeric cell. */
export function Num({ children, color = MUT, align = "right" }: { children: ReactNode; color?: string; align?: "left" | "right" }) {
  return <span style={{ textAlign: align, color }}>{children}</span>;
}

/** Asset glyph in a dark disc. */
export function Glyph({ glyph, size = 24 }: { glyph: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(135deg,#222,#0d0d0d)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: MONO,
        fontSize: size * 0.5,
        color: "#c2c2c2",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.06)",
        flex: "0 0 auto",
      }}
    >
      {glyph}
    </span>
  );
}

export { HI, DIM };
