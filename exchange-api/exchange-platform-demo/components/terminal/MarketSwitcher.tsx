"use client";

/*
 * The market selector in the header strip.
 *
 * In the earlier prototype the ▾ next to the symbol was decorative. Making it
 * real is what turns the mock from one hard-coded chart into a terminal: the
 * whole screen is keyed on the selected symbol, so switching markets re-derives
 * the book, tape, candles, funding, and ticket precision together.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MARKETS, ASSET_CLASSES, Market, getStats, fmtPrice, AssetClass } from "@/lib/markets";
import { pct, notional } from "@/lib/format";
import {
  R_XS,
  R_SM,
  R_MD,
  R_LG,
  R_XL,
  MONO,
  ARCHIVO,
  L1,
  L2,
  L3,
  TXT,
  MUT,
  DIM,
  FAINT,
  GREEN,
  RED,
  PANEL,
  SUNK,
  TERM,
  H_NAV_COMPACT,
  H_BOTTOM_NAV,
  M_FRAME_X,
  M_FRAME_TOP,
  M_FRAME_BOTTOM,
  TAP_CONTROL,
  monoLabel,
} from "@/lib/theme";
import { Glyph } from "./primitives";
import { Sparkline } from "../charts/Sparkline";

/** What the list is ordered by. Theirs sorts on Volume by default; so do we. */
type SortKey = "vol" | "chg" | "oi" | "price" | "funding";

/*
 * One template for the header and the rows, so a column cannot drift between them.
 * Four columns on a phone — identity, price, volume, funding — each stacking two
 * figures, which is theirs: six numbers per row in the width that held two.
 */
const COLS = (compact: boolean) =>
  compact ? "1.5fr 0.95fr 0.95fr 0.9fr" : "1.7fr 1fr 1fr 0.8fr 0.9fr";

/**
 * The chevron on the market trigger — drawn, not the `▾` character.
 *
 * The glyph was a filled triangle at the text's own size, which read as a stray tick
 * rather than a control. SVG because a font glyph cannot be sized past its line box
 * without moving the baseline, and cannot take a stroke weight at all.
 *
 * At phone width it is 22px and carries the affordance on its own, as theirs does. At
 * desktop it is 12 and rides inside the plate, where its job is only to confirm what
 * the plate already says.
 */
function Caret({ open, compact }: { open: boolean; compact: boolean }) {
  return (
    <svg
      width={compact ? 22 : 12}
      height={compact ? 22 : 12}
      viewBox="0 0 24 24"
      fill="none"
      stroke={compact ? MUT : DIM}
      strokeWidth={compact ? 2.1 : 2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="nx-market-caret"
      style={{
        flex: "0 0 auto",
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform .14s, stroke .14s",
      }}
    >
      <path d="M6 9.5 L12 15.5 L18 9.5" />
    </svg>
  );
}

/** A keycap. Small enough to read as chrome, boxed enough to read as a key. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: 16,
        textAlign: "center",
        padding: "1px 4px",
        marginRight: 5,
        border: `1px solid ${L2}`,
        borderRadius: R_XS,
        color: MUT,
        fontFamily: MONO,
      }}
    >
      {children}
    </span>
  );
}

/** A column header that is also the sort control for its column. */
function SortHead({
  label,
  sub,
  k,
  sort,
  dir,
  onSort,
}: {
  label: string;
  sub: string;
  k: SortKey;
  sort: SortKey;
  dir: -1 | 1;
  onSort: (k: SortKey) => void;
}) {
  const on = sort === k;
  return (
    <span style={{ textAlign: "right" }}>
      <button
        onClick={() => onSort(k)}
        aria-label={`Sort by ${label}`}
        className="nx-inline-control"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "transparent",
          border: "none",
          padding: 0,
          minWidth: 32,
          justifyContent: "flex-end",
          cursor: "pointer",
          color: on ? TXT : "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
        }}
      >
        {label}
        {/* The caret only on the active column. A chevron on every header claims all
            four are sorted, and the reader then has to work out which one is. */}
        {on && <span aria-hidden="true" style={{ fontSize: 8 }}>{dir === -1 ? "▼" : "▲"}</span>}
      </button>
      <br />
      <span style={{ color: FAINT }}>{sub}</span>
    </span>
  );
}

/**
 * The trigger. The panel is a separate, CONTROLLED component below.
 *
 * They were one component with its own `open` state, which is why the app ended up with
 * two different market surfaces: the pill could open its dropdown, and ⌘K opened a
 * completely separate palette that happened to also list markets. Two answers to "find
 * a market", each with its own layout, its own filters and its own idea of what a
 * market row looks like.
 *
 * The reference has one: ⌘K and the symbol pill open the same modal. Splitting the
 * trigger from the panel is what lets the shell own it, mount it once, and hand the
 * same thing to both entry points.
 */
export function MarketSwitcher({
  market,
  onSelect,
  compact = false,
  open,
  onOpenChange,
  headless = false,
}: {
  market: Market;
  onSelect: (sym: string) => void;
  compact?: boolean;
  /**
   * CONTROLLED by the shell, so ⌘K and the symbol pill open THE SAME panel.
   *
   * It used to own this state, which is how the app ended up with two different market
   * surfaces: the pill opened this dropdown, and ⌘K opened a separate palette that
   * happened to also list markets — two answers to "find a market", each with its own
   * layout, filters and row shape. The reference has one, reachable both ways.
   */
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /*
   * THE PANEL WITHOUT ITS TRIGGER.
   *
   * ⌘K and the `Search ⌘K` button in the top nav were dead on Portfolio and
   * Competitions. The shell owns `selectorOpen` and the hotkey is bound globally, so
   * the state flipped correctly on every screen — but the panel is mounted inside
   * `MarketHeader`, and `MarketHeader` only exists on the trade screen. Two of three
   * screens flipped a boolean that nothing was listening to.
   *
   * The file's own header says this component was split so "the shell can own it,
   * mount it once, and hand the same thing to both entry points". The split was made
   * and then only half used: the panel still lives inside the trigger's component. A
   * headless instance is the smallest honest fix — the shell mounts one on the screens
   * that have no market header, and there is exactly one panel on screen either way.
   */
  headless?: boolean;
}) {
  const setOpen = (v: boolean | ((p: boolean) => boolean)) =>
    onOpenChange(typeof v === "function" ? v(open) : v);
  /*
   * Two extra flags, because a sheet has to animate OUT as well as in and React
   * unmounts too fast to see.
   *
   * The slide itself is a CSS keyframe attached on mount (`.nx-sheet`), because the
   * state-flip version stalled: clicking renders a 32-row list first, and the frame
   * that was meant to flip the transform landed behind that work — measured at ~180ms
   * of the sheet sitting still before it moved. An animation starts when the element
   * first paints and needs no second render.
   *
   * `exiting` is the one flag React still needs: it keeps the panel mounted for the
   * length of the close so the reverse animation is visible at all. `open` remains the
   * logical state; this is presentation only.
   */
  const [exiting, setExiting] = useState(false);
  const [q, setQ] = useState("");
  /*
   * Keyboard navigation.
   *
   * The reference advertises `⇅ Navigate · ↵ Select` in its footer and honours it. Ours
   * had none — on the one surface in the product whose entire purpose is to be opened
   * by a keystroke, in a terminal for people who work from a keyboard. You could Tab
   * through 32 options one at a time; you could not move through them.
   *
   * `active` is an INDEX into the filtered rows, not a symbol, so it survives sorting
   * and filtering without having to be re-found. It resets whenever the list changes,
   * because "the third row" means something different after you type.
   */
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  /*
   * Portalled to document.body — and this is not tidiness, it is the only thing that
   * makes the z-index mean anything.
   *
   * The scrim was `position: fixed; inset: 0; zIndex: 46`, above the top nav's 40 and
   * the bottom nav's 45, and it covered NEITHER. It renders inside the market header,
   * which is `position: relative; zIndex: 20` — a stacking context — so every z-index
   * inside it is resolved *within* z=20 and the whole subtree paints under both bars.
   * 46 was being compared against its siblings, not against the page.
   *
   * The symptom was that tapping the dimmed area did nothing: the top bar was on top
   * of the scrim and swallowed the click. Found by `elementFromPoint` at the logo
   * while the sheet was open, which is the same instrument that found the clipped
   * overflow menu — a different containment rule, the same lesson about asking the
   * browser what is actually there.
   *
   * `mounted` gates the portal because document.body does not exist during SSR.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /*
   * FOCUS MOVES INTO THE PANEL ON OPEN, at compact width.
   *
   * At desktop the search input autofocuses and every key lands inside the panel. At
   * compact it deliberately does not — a soft keyboard over the results is worse than
   * scrolling 32 markets — and nothing else took focus either, so keydown went to the
   * body and `onKeyDown` never ran. Two visible consequences, both in the very first
   * capture of the panel from Portfolio:
   *
   *   · Enter did nothing. The footer advertises `↵ select`.
   *   · The focus ring was left wherever it happened to be — stranded on ARB, row
   *     eight — while `aria-activedescendant` said ETH. Two different answers to
   *     "which row is current", one for the eye and one for a screen reader.
   *
   * Focusing the panel rather than the input keeps the keyboard closed and puts the
   * keys where the handler is.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !compact) return;
    const id = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open, compact]);
  const [cls, setCls] = useState<"All" | AssetClass>("All");

  /*
   * Sort, defaulting to volume descending — which is theirs, and is the only default
   * that is not arbitrary. A market chooser is answering "where is there liquidity",
   * and the list ordered by registry insertion answers "what did we type first".
   */
  const [sort, setSort] = useState<SortKey>("vol");
  const [dir, setDir] = useState<-1 | 1>(-1);

  const rows = useMemo(() => {
    /*
     * Search the TICKER and the NAME, never the wire symbol.
     *
     * Matching `m.sym` meant matching `BTC-USDX-PERP`, and every symbol on this venue
     * ends in the same eleven characters — so typing "e" matched all 32 markets
     * (PERP), "s" matched all 32 (USDX), and the filter silently did nothing for a
     * third of the alphabet. Found by a differential check, not by looking: the list
     * still rendered, it just rendered everything.
     */
    const needle = q.trim().toLowerCase();
    const matched = MARKETS.filter((m) => {
      if (cls !== "All" && m.cls !== cls) return false;
      if (needle === "") return true;
      return m.base.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle);
    });
    const key = (m: Market) => {
      const st = getStats(m.sym);
      return sort === "vol"
        ? st.vol24
        : sort === "chg"
          ? m.chg24
          : sort === "oi"
            ? st.oi
            : sort === "funding"
              ? st.funding
              : m.ref;
    };
    return matched.slice().sort((a, b) => (key(a) - key(b)) * dir);
  }, [q, cls, sort, dir]);

  /*
   * Footer aggregates, over the FILTERED set.
   *
   * This is how a filter tells you it did something. Theirs goes
   * `474 markets · $3.98b (98.4% of total)` → `16 markets · $658.44m (16.3% of total)`
   * as you type; a count that never moves is a count nobody reads. The share is
   * against the whole venue, which is what makes it a share rather than a restatement
   * of the number beside it.
   */
  const totals = useMemo(() => {
    const all = MARKETS.reduce((a, m) => a + getStats(m.sym).vol24, 0);
    const vol = rows.reduce((a, m) => a + getStats(m.sym).vol24, 0);
    const oi = rows.reduce((a, m) => a + getStats(m.sym).oi, 0);
    return { vol, oi, share: all > 0 ? (vol / all) * 100 : 0 };
  }, [rows]);

  /* Same column twice flips direction; a new column starts descending, because every
     figure in this table is one where "most" is the interesting end. */
  const applySort = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === -1 ? 1 : -1));
    else {
      setSort(k);
      setDir(-1);
    }
  };

  /*
   * Duration in one place, and zero when the reader has asked for less motion.
   *
   * The audit harness runs with `reducedMotion: "reduce"` AND injects a stylesheet
   * that zeroes every transition, so a close that waited a fixed 240ms before
   * unmounting would leave an invisible panel on screen for a quarter of a second in
   * every capture. Reading the query here keeps the timer and the transition telling
   * the same story.
   */
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* Matches `.nx-sheet-exit` in globals.css — the timer and the keyframe have to agree
     or the panel is unmounted mid-slide. */
  const ms = reduced ? 0 : 200;

  const close = () => {
    if (!open) return;
    if (ms === 0) {
      setOpen(false);
      return;
    }
    setExiting(true);
    window.setTimeout(() => {
      setExiting(false);
      setOpen(false);
    }, ms);
  };

  /* Escape closes, which a sheet covering the whole screen needs and a dropdown
     hanging off a button can get away with not having. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /*
   * Arrow keys move, Enter selects, Home/End jump. Bound on the PANEL rather than on
   * the input, so it works whether focus is in the search field or on a row — the
   * field autofocuses at desktop, but a click on a chip moves focus out of it and the
   * arrows have to keep working.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    /*
     * TAB STAYS INSIDE. `aria-modal="true"` is a promise, and it was a lie.
     *
     * Tab from the open sheet walked straight out to the bottom nav underneath — the
     * capture that proved it shows the nav's own focus ring bleeding through the 4px
     * gutter beside the sheet. A modal a keyboard can walk out of is not modal; the
     * user is then operating controls they cannot see behind a scrim.
     *
     * Found sideways, by the visual floor flagging sixteen changed pixels I would
     * never have gone looking for.
     */
    if (e.key === "Tab") {
      const root = panelRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], select, textarea, [tabindex]',
      )].filter(
        /*
         * `tabIndex >= 0`, and it is load-bearing.
         *
         * The first version selected `button:not([disabled])` and trusted it. That
         * matches all 32 market rows even though they are `tabIndex={-1}`, so
         * Shift+Tab wrapped to the LAST row and `focus()` scrolled the list 700px to
         * reach it — 22% of the frame changed between two runs of an unchanged build.
         * A trap that computes its own boundary from a different rule than the browser
         * uses is not a trap, it is a second focus model.
         */
        (el) => el.tabIndex >= 0 && el.offsetParent !== null,
      );
      if (!focusable.length) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        // Wrap. A list you can walk off the end of makes you look at the scrollbar to
        // find out where you are.
        return (next + rows.length) % rows.length;
      });
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : rows.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const m = rows[active];
      if (m) pick(m.sym);
    }
  };

  /* Keep the highlighted row on screen. `nearest` rather than `center` so walking down
     a long list scrolls by a row at a time instead of jumping the viewport each press. */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /* A filtered or re-sorted list is a different list; index 5 is not the same row. */
  useEffect(() => {
    setActive(0);
  }, [q, cls, sort, dir]);

  const pick = (sym: string) => {
    onSelect(sym);
    close();
    setQ("");
  };

  /*
   * The panel is `position: fixed`, measured from the trigger — not `absolute`
   * under it.
   *
   * It was absolute, and on a phone the header strip that contains it clips its
   * overflow, so 461px of market list was painted into nothing: the filter input
   * showed, every market did not. The menu was in the DOM the whole time with a
   * real bounding box and working handlers, which is why it survived every check
   * that reads the DOM. `popups-visible` hit-tests what is painted, and failed it
   * on the first run.
   *
   * Fixed positioning takes the panel out of every ancestor's overflow. The cost
   * is that the anchor has to be computed rather than inherited, which is what
   * the layout effect below does — and it must be a LAYOUT effect, or the panel
   * paints once at 0,0 before jumping into place.
   */
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    // Only the sheet is measured from the trigger; the desktop modal is centred.
    if (!open || !compact) return;
    const place = () => {
      /* Headless deliberately ignores the ref even though the element exists: the
         wrapper is `display: none`, so its rect is all zeros and would place the sheet
         at the top of the screen. The portal itself is unaffected by that — portalled
         content renders into document.body and does not inherit an ancestor's
         display. */
      const el = headless ? null : anchorRef.current;
      if (!el && !headless) return;
      /* Headless: no trigger to measure, so the panel is placed against the chrome.
         The sheet starts under the top nav and the dropdown hangs from the same edge,
         which is where a ⌘K with no visible origin should come from. */
      const r = el
        ? el.getBoundingClientRect()
        : ({ left: 12, right: 12, bottom: H_NAV_COMPACT + 4, top: H_NAV_COMPACT } as DOMRect);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      if (compact) {
        /* The sheet only needs one number from the trigger: where to start, which is
           just under the market identity row. Everything else is the viewport. */
        setPos({ left: 0, top: Math.round(r.bottom + 7), width: vw, maxHeight: vh });
        return;
      }
      const width = Math.min(468, vw - 16);
      // Clamp to the viewport rather than letting the panel run off the right
      // edge on a narrow screen — off-viewport is the other half of what
      // `popups-visible` fails on, and it is the half that no screenshot shows.
      const left = Math.max(8, Math.min(r.left, vw - width - 8));
      const top = r.bottom + gap;
      setPos({ left, top, width, maxHeight: Math.max(180, vh - top - 12) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, compact, headless]);

  return (
    /* `width: 100%` when compact so the trigger fills the header row and its chevron
       lands at the RIGHT EDGE, which is where the reference puts it. Sized to content,
       the caret sat immediately after the leverage badge with 200px of empty row after
       it — a chevron floating in the middle of a row does not read as "this row
       opens". */
    <div
      ref={anchorRef}
      style={
        headless
          ? { display: "none" }
          : { position: "relative", display: "flex", width: compact ? "100%" : undefined }
      }
    >
      {!headless && (
      <button
        onClick={() => setOpen((o) => !o)}
        className="nx-market-trigger"
        style={{
          display: "flex",
          alignItems: "center",
          gap: compact ? 9 : 11,
          width: compact ? "100%" : undefined,
          padding: compact ? 0 : "0 14px",
          height: "100%",
          // `height: 100%` of a header row that is itself content-sized gave 31px
          // against the 32px default floor — one pixel short, on every compact
          // capture. State the floor rather than inheriting it.
          minHeight: 32,
          border: "none",
          /* The divider used to be L2 — a bright rule right where the eye lands, which
             read as a boundary between two panels rather than the edge of a control.
             Theirs has none at all here; L1 keeps the column structure without
             competing with the thing it sits beside. */
          borderRight: compact ? "none" : `1px solid ${L1}`,
          background: "transparent",
          cursor: "pointer",
          color: TXT,
        }}
      >
        {/*
         * THE STAR IS GONE.
         *
         * It was decorative — no favourites list existed to add to, no state to
         * toggle, nothing read it. It also sat first in the row, so the first thing
         * the eye met on the most important control on the screen was an inert
         * ornament. Theirs has no star here either.
         */}
        <Glyph glyph={market.glyph} size={compact ? 26 : 27} />
        {/*
         * The chip IS the affordance, and it is the one thing theirs does that we did
         * not.
         *
         * On their header the symbol and its leverage badge sit on a raised rounded
         * surface a shade lighter than the bar around it. No chevron, no border, no
         * label saying "change market" — just a plate under the name, which is enough,
         * because a raised surface in a flat bar reads as something you press. Ours had
         * bare text and a caret 200px away, and Daniel's note is the evidence: people
         * do not know the header opens.
         *
         * Hover lifts it further (`.nx-market-trigger:hover .nx-market-chip`) and open
         * holds it lifted, so the plate answers back.
         */}
        <span
          className="nx-market-chip"
          data-open={open ? "" : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: compact ? 9 : 10,
            minWidth: 0,
            padding: compact ? "0" : "6px 9px 6px 10px",
            borderRadius: R_MD,
            background: compact ? "transparent" : open ? "#1b1b1b" : "#131313",
            border: `1px solid ${compact ? "transparent" : open ? L3 : L2}`,
            transition: "background .14s, border-color .14s",
            flex: compact ? "1 1 auto" : undefined,
          }}
        >
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: MONO, fontSize: compact ? 15 : 16, fontWeight: 500, color: "#f4f4f4", letterSpacing: "-0.01em" }}>
              {market.sym}
            </span>
            {/* Max leverage as a badge on the symbol — it is a property of the
                instrument, so it belongs next to the instrument, not buried in a
                subtitle. */}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 9.5,
                color: GREEN,
                background: "rgba(14,203,129,0.10)",
                border: "1px solid rgba(14,203,129,0.22)",
                borderRadius: R_XS,
                padding: "1px 4px",
              }}
            >
              {market.maxLev}×
            </span>
          </span>
          {/* Full instrument name. Tickers alone assume the reader already knows
              the universe; a venue listing equities and commodities cannot. */}
          <span
            style={{
              fontFamily: ARCHIVO,
              fontSize: compact ? 9.5 : 10.5,
              color: DIM,
              maxWidth: compact ? 150 : 168,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {market.name}
          </span>
        </span>
        {/* At desktop the chevron rides INSIDE the plate, at its right edge — the
            plate and the caret are one control, and a caret outside it would read as
            a second, separate one. At phone width the plate is the whole row, so the
            caret goes to the far right where theirs puts it. */}
        {!compact && <span style={{ flex: "0 0 auto", width: 2 }} />}
        {!compact && <Caret open={open} compact={false} />}
        </span>
        {compact && <span style={{ flex: 1 }} />}
        {compact && <Caret open={open} compact />}
      </button>
      )}

      {(open || exiting) && mounted && createPortal(
        <>
          {/*
           * A real scrim on a phone, an invisible click-off shield at desktop.
           *
           * Theirs dims everything behind the sheet, and it is not decoration: a sheet
           * that covers the bottom nav has taken over the screen, and the dimming is
           * what says so — without it the nav looks present but is unreachable, which
           * is the worst of both. At desktop the panel is a dropdown hanging off a
           * control and dimming the terminal behind it would be theatre.
           */}
          <div
            onClick={close}
            aria-hidden="true"
            /* The scrim fades at every width now. It faded only on a phone, so at
               desktop a black sheet appeared over the whole terminal in one frame —
               the most abrupt thing in the app was also the largest. */
            className={reduced ? undefined : exiting ? "nx-scrim-exit" : "nx-scrim"}
            style={{
              position: "fixed",
              inset: 0,
              /*
               * ABOVE the top nav (40) and the bottom nav (45), not below them.
               *
               * At zIndex 30 the scrim painted under both bars: the top bar swallowed
               * every click aimed at the dimmed area, so tapping off the sheet did
               * nothing at all — the only ways out were choosing a market or Escape,
               * and a phone has no Escape. Caught by clicking where a user would and
               * watching the sheet stay open.
               */
              zIndex: compact ? 46 : 30,
              /* Dimmed at BOTH widths now. While this was a dropdown hanging off a
                 control, dimming the terminal behind it would have been theatre; a
                 centred modal that covers the middle of the screen has taken it over,
                 and saying so is the difference between a modal and a floating panel. */
              background: compact ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.5)",
            }}
          />
          <div
            /* dialog, not menu. A `menu` may only contain menuitems, and this panel
               holds a text field and a class filter before it holds anything
               selectable — which axe reports as aria-required-children. The list
               inside is the part that is a list, so that is where listbox/option go. */
            role="dialog"
            aria-modal={compact ? true : undefined}
            aria-label="Markets"
            ref={panelRef}
            /* Focusable so the panel itself can hold focus at compact width, where the
               search input deliberately does not take it. See the effect below. */
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={reduced ? undefined : compact ? (exiting ? "nx-sheet-exit" : "nx-sheet") : exiting ? undefined : "nx-dialog"}
            style={{
              /*
               * No focus ring on the PANEL itself.
               *
               * Focus is moved here programmatically so keys reach `onKeyDown`; the
               * user did not Tab to it and `tabIndex={-1}` means they cannot. The
               * visible cursor for this widget is the row's green left edge plus
               * `aria-activedescendant`, so a ring around the container would be a
               * second answer to "where am I".
               *
               * (I first wrote this comment claiming it fixed sixteen green pixels the
               * visual floor had found in the corner. It did not — those were the
               * BOTTOM NAV's focus ring, showing through the 4px gutter beside the
               * sheet because Tab was escaping the dialog entirely. See the focus trap
               * in `onKeyDown`. A comment that explains the wrong thing is worse than
               * no comment, so this one says what it actually does.)
               */
              outline: "none",
              position: "fixed",
              /*
               * A SHEET on a phone, an anchored dropdown at desktop.
               *
               * Measured against theirs at 390: their selector is a sheet from y=117
               * to the bottom edge, ~86% of the viewport, showing ten of 474 markets.
               * Ours was a 320×475 dropdown at (19,105) — 56% of the height, with the
               * list additionally capped at 340px, so SEVEN of thirty-two markets were
               * visible on a screen with room for twenty. A dropdown is the right shape
               * when it hangs off a control on a wide screen and the wrong one when it
               * is the only thing on the screen.
               *
               * Their own tablet capture keeps the full desktop table, so this is a
               * breakpoint on their side too, not a fallback — which is why desktop
               * below is untouched.
               *
               * It covers the market header, per Daniel. Theirs leaves the identity row
               * peeking above the sheet so you can still see what you are switching
               * FROM; ours covers it, consistent with every other mobile sheet in this
               * app, and the trigger is restored the moment it closes.
               */
              ...(compact
                ? {
                    /*
                     * A BOTTOM SHEET: anchored to the bottom edge, over the nav.
                     *
                     * It used to sit inside the frame, stopping above the bottom nav
                     * with all four corners rounded — which reads as a panel that was
                     * always there, not as something that arrived. Theirs runs to the
                     * bottom edge of the screen, covers the nav, rounds only the top
                     * two corners, and slides up from below. All three say the same
                     * thing: this came from somewhere and it will go back.
                     *
                     * `top` is measured from the trigger rather than fixed, so the
                     * market identity row stays visible above it — you can still see
                     * what you are switching FROM, which is theirs.
                     */
                    top: pos?.top ?? 0,
                    left: M_FRAME_X,
                    right: M_FRAME_X,
                    bottom: 0,
                    borderRadius: `${R_XL}px ${R_XL}px 0 0`,
                    borderBottom: "none",
                    visibility: pos ? ("visible" as const) : ("hidden" as const),
                    zIndex: 47,
                  }
                : {
                    /*
                     * CENTRED, not anchored to the trigger.
                     *
                     * Theirs is an ~810px modal in the middle of the screen; ours was a
                     * 468px dropdown hanging off the pill. The width is the point: at
                     * 468 the row has to stack volume under open interest and price
                     * under 24h change, which is a phone compromise applied at 1440.
                     * A centred modal also has one obvious origin for a surface that is
                     * opened by a keystroke as often as by a click — a dropdown that
                     * appears under a control you did not touch reads as a glitch.
                     */
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    width: 820,
                    maxWidth: "94vw",
                    maxHeight: "82vh",
                    borderRadius: R_LG,
                  }),
              display: "flex",
              flexDirection: "column",
              zIndex: compact ? 47 : 31,
              background: PANEL,
              border: `1px solid ${L3}`,
              boxShadow: "0 30px 80px rgba(0,0,0,0.86)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: compact ? "8px 12px 10px" : "10px 12px", borderBottom: `1px solid ${L1}` }}>
              {/* Drag handle. Not draggable — the sheet closes by tapping off it or by
                  choosing a market — but it is the universal "this is a sheet, it came
                  from below, it will go back" signal, and theirs has one. A handle that
                  lies about being draggable is still less confusing than a sheet with
                  no affordance at all. */}
              {compact && (
                <div
                  aria-hidden="true"
                  style={{ width: 36, height: 4, borderRadius: 2, background: L3, margin: "0 auto 10px" }}
                />
              )}
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <span
                  aria-hidden="true"
                  style={{ position: "absolute", left: 10, color: FAINT, fontSize: 12, lineHeight: 1, pointerEvents: "none" }}
                >
                  ⌕
                </span>
                <input
                  /*
                   * Autofocus at DESKTOP only.
                   *
                   * On a phone it raises the soft keyboard over the results the field
                   * exists to filter — you would be typing at a list you cannot see.
                   * Their sheet does take focus on open; this is a deliberate
                   * divergence, recorded, because their 474 markets make search the
                   * primary path and our 32 make scrolling it.
                   */
                  autoFocus={!compact}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search markets"
                  aria-label="Search markets"
                  style={{
                    width: "100%",
                    background: TERM,
                    border: `1px solid ${L2}`,
                    borderRadius: R_MD,
                    padding: compact ? "10px 30px 10px 26px" : "7px 26px 7px 26px",
                    color: TXT,
                    fontFamily: MONO,
                    fontSize: 12,
                  }}
                />
                {q !== "" && (
                  <button
                    onClick={() => setQ("")}
                    aria-label="Clear search"
                    className="nx-inline-control"
                    style={{
                      position: "absolute",
                      right: 4,
                      minWidth: TAP_CONTROL,
                      minHeight: TAP_CONTROL,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      color: MUT,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 9, flexWrap: "wrap" }}>
                {ASSET_CLASSES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCls(c)}
                    /* Five chips sharing a top edge is a segmented group, which is a
                       36px tier under a finger. These were 22px — and unlike the
                       ticket's controls, this panel is ours, so there is no parity
                       cost to sizing it for the pointer that is actually on it. */
                    className="nx-segmented"
                    /*
                     * The selected chip was a solid green fill — the loudest thing in a
                     * panel whose entire content is data, and it was spending that
                     * loudness on the filter you had just set rather than on the market
                     * you came to find. Tinted instead: the same treatment the leverage
                     * badge and the ticket's Cross/Iso already use here, so "selected"
                     * looks the same everywhere in the app.
                     */
                    style={{
                      padding: "3px 9px",
                      borderRadius: 5,
                      border: `1px solid ${cls === c ? "rgba(14,203,129,0.30)" : L2}`,
                      background: cls === c ? "rgba(14,203,129,0.10)" : "transparent",
                      color: cls === c ? GREEN : "#8a8a8a",
                      fontFamily: MONO,
                      fontSize: 10.5,
                      cursor: "pointer",
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/*
             * Column headers, and the sort lives on them.
             *
             * The list had none: four columns of bare numbers whose meaning you were
             * expected to infer from their shape, in the one surface whose entire job
             * is comparing markets against each other. Theirs labels all four and puts
             * the sort control on the header it sorts by, which is where a reader
             * looks for it.
             */}
            <div
              /*
               * NO `role="row"` / `role="columnheader"` here.
               *
               * The list below is a `listbox` of `option`s, and an option is not a
               * cell — so a row of columnheaders above it has nothing to head, which
               * axe reports as aria-required-parent (critical) the moment the panel is
               * captured. The labels are visual, the sort buttons are real buttons with
               * accessible names, and the listbox carries its own label. Declaring
               * table semantics over a listbox would be describing a structure that is
               * not there.
               */
              aria-hidden="true"
              style={{
                display: "grid",
                gridTemplateColumns: COLS(compact),
                gap: 8,
                padding: "7px 13px",
                borderBottom: `1px solid ${L1}`,
                background: SUNK,
                ...monoLabel(8.5, "0.08em"),
              }}
            >
              <span>{rows.length === 1 ? "1 Market" : `${rows.length} Markets`}</span>
              {/* Each header sorts by the figure it NAMES. `Price` sorted by 24h change
                  until a differential check pressed it and watched the order: the
                  control said Price, the list came back ordered by percentage, and
                  there was no way to sort by price at all. A header that sorts by its
                  neighbour is worse than one that does not sort. */}
              <SortHead label="Price" sub="24h %" k="price" sort={sort} dir={dir} onSort={applySort} />
              <SortHead label="24h Vol." sub="Open Int." k="vol" sort={sort} dir={dir} onSort={applySort} />
              {!compact && <span style={{ textAlign: "right" }}>7D</span>}
              <SortHead label="Funding" sub="Annualized" k="funding" sort={sort} dir={dir} onSort={applySort} />
            </div>

            <div
              ref={listRef}
              role="listbox"
              tabIndex={0}
              aria-label="Market list"
              /* The listbox owns the selection state for assistive tech; the DOM focus
                 stays in the search field. This is the standard combobox arrangement and
                 the reason `aria-activedescendant` exists. */
              aria-activedescendant={rows[active] ? `mkt-${rows[active].sym}` : undefined}
              /* No maxHeight. A fixed 340px cap was left over from the dropdown and it
                 was the second reason only seven markets were visible: the sheet had
                 room for twenty and the list refused to use it. */
              style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
            >
              {rows.length === 0 && (
                <div style={{ padding: "18px 14px", fontFamily: MONO, fontSize: 11.5, color: FAINT, textAlign: "center" }}>
                  No market matches “{q}”
                </div>
              )}
              {rows.map((m, i) => {
                const s = getStats(m.sym);
                const on = m.sym === market.sym;
                const cursor = i === active;
                return (
                  <button
                    key={m.sym}
                    id={`mkt-${m.sym}`}
                    data-idx={i}
                    role="option"
                    /* `aria-selected` is the CURRENT MARKET; the keyboard cursor is a
                       separate thing and is announced through aria-activedescendant.
                       Conflating them would tell a screen-reader user they had changed
                       market by pressing an arrow key. */
                    aria-selected={on}
                    /*
                     * NOT A TAB STOP. The rows are driven by `aria-activedescendant`
                     * on the listbox, which is the pattern precisely BECAUSE the
                     * container is the single tab stop and the options are not.
                     * Leaving them natively focusable gave two competing focus models
                     * on one widget, and both symptoms were visible in captures: a
                     * focus ring stranded on row eight while activedescendant said row
                     * zero, and — once Tab was trapped inside the dialog — a Tab press
                     * scrolling the list to a row 700px down, which moved 22% of the
                     * frame between two runs of an unchanged build.
                     *
                     * Arrow keys move the cursor. The footer has always said so.
                     */
                    tabIndex={-1}
                    onClick={() => pick(m.sym)}
                    onMouseEnter={() => setActive(i)}
                    className="nx-row"
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: COLS(compact),
                      alignItems: "center",
                      gap: 8,
                      padding: "9px 13px",
                      border: "none",
                      borderBottom: `1px solid #101010`,
                      /*
                       * Two states, two treatments, and they have to stay orthogonal:
                       * a row can be the current market AND under the keyboard cursor
                       * at once. The market keeps the green tint because green means
                       * something here; the cursor is a neutral hairline ring rather
                       * than the 2px green left rail it used to be — an accent stripe
                       * for a transient keyboard position was borrowing the loudest
                       * colour on screen for the least permanent state.
                       */
                      background: cursor ? "rgba(255,255,255,0.05)" : on ? "rgba(14,203,129,0.06)" : "transparent",
                      boxShadow: cursor ? "inset 0 0 0 1px rgba(255,255,255,0.16)" : undefined,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: MONO,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <Glyph glyph={m.glyph} size={20} />
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}>
                        <span style={{ color: on ? GREEN : "#e8e8e8", fontWeight: 500, whiteSpace: "nowrap" }}>
                          {m.sym.replace("-USDX-PERP", "")}
                        </span>
                        {/*
                         * LEVERAGE under the symbol, not asset class.
                         *
                         * Class was redundant with the filter row directly above it —
                         * it told you the answer to a question you had just asked — and
                         * theirs spends the slot on max leverage, which is a property
                         * you actually choose a market on. Same slot, strictly more
                         * information.
                         */}
                        <span
                          style={{
                            ...monoLabel(8.5, "0.06em"),
                            color: DIM,
                            border: `1px solid ${L2}`,
                            borderRadius: R_XS,
                            padding: "0 4px",
                            alignSelf: "flex-start",
                          }}
                        >
                          {m.maxLev}×
                        </span>
                      </span>
                    </span>

                    <span style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ color: "#cfcfcf" }}>{fmtPrice(m, m.ref)}</span>
                      <span style={{ color: m.chg24 >= 0 ? GREEN : RED, fontSize: 10.5 }}>{pct(m.chg24)}</span>
                    </span>

                    <span style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ color: MUT }}>{notional(s.vol24)}</span>
                      {/* DIM, not FAINT. FAINT is #7a7a7a and measures 4.3:1 against the
                          selected row's green wash — under AA, and only on the row the
                          reader is most likely to be looking at. */}
                      <span style={{ color: DIM, fontSize: 10.5 }}>{notional(s.oi)}</span>
                    </span>

                    {!compact && (
                      <span style={{ display: "flex", justifyContent: "flex-end" }}>
                        <Sparkline seed={s.spark} color={m.chg24 >= 0 ? GREEN : RED} w={60} h={18} />
                      </span>
                    )}

                    {/* Funding, and the annualised rate under it. The hourly number is
                        what settles; the annualised one is what tells you whether it
                        matters. Theirs shows both and it is the only pair here where
                        one figure is useless without the other. */}
                    <span style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ color: s.funding >= 0 ? GREEN : RED }}>{pct(s.funding, 4)}</span>
                      <span style={{ color: DIM, fontSize: 10.5 }}>{pct(s.funding * 24 * 365, 1)}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/*
             * Aggregates over the filtered set, which is how the filter reports back.
             *
             * The footer used to read `32 MARKETS` no matter what you typed, beside an
             * endpoint name. Theirs recomputes all three figures as you filter —
             * `474 markets · $3.98b (98.4% of total)` becomes
             * `16 markets · $658.44m (16.3% of total)` — and the share is what makes it
             * a measurement rather than a restatement of the count next to it.
             *
             * `GET /v1/markets` stays. It is this project's own signature: a mock whose
             * job is to specify names the endpoint each surface would call, and the
             * slot theirs spends on branding is the one we spend on that.
             */}
            <div
              style={{
                padding: compact ? "9px 13px" : "8px 13px",
                borderTop: `1px solid ${L1}`,
                background: SUNK,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                ...monoLabel(9.5, "0.08em"),
              }}
            >
              <span style={{ color: TXT }}>{rows.length === 1 ? "1 market" : `${rows.length} markets`}</span>
              <span style={{ display: "flex", gap: 12, minWidth: 0 }}>
                <span style={{ whiteSpace: "nowrap" }}>
                  <span style={{ color: FAINT }}>24h vol </span>
                  <span style={{ color: MUT }}>{notional(totals.vol)}</span>
                  <span style={{ color: FAINT }}> · {totals.share.toFixed(1)}%</span>
                </span>
                <span style={{ whiteSpace: "nowrap" }}>
                  <span style={{ color: FAINT }}>OI </span>
                  <span style={{ color: MUT }}>{notional(totals.oi)}</span>
                </span>
              </span>
            </div>
            {!compact && (
              <div
                style={{
                  padding: "6px 13px",
                  borderTop: `1px solid ${L1}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  ...monoLabel(9, "0.08em"),
                }}
              >
                {/* The keys, stated. Theirs advertises `⇅ Navigate · ↵ Select` in the
                    same place, and a keyboard affordance nobody can see is one nobody
                    uses — which is most of why ours had none for so long. */}
                <span style={{ display: "flex", gap: 14, color: FAINT }}>
                  <span>
                    <Key>↑↓</Key> navigate
                  </span>
                  <span>
                    <Key>↵</Key> select
                  </span>
                  <span>
                    <Key>esc</Key> close
                  </span>
                </span>
                <span>
                  <span style={{ color: MUT }}>GET</span> /v1/markets
                </span>
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
