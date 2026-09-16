"use client";

/*
 * The Trade screen.
 *
 * Desktop is a fixed four-band layout that never scrolls as a whole: market
 * header / three columns (chart · book · tape+ticket) / blotter. Each column
 * manages its own overflow, which is what makes it read as an instrument panel
 * rather than a web page.
 *
 * Mobile is a different layout, not a reflow of the same one — a single scrolling
 * stack in reading order: what is it, what's it doing, what's on offer, how do I
 * act, what do I hold.
 */

import { type Session } from "@/lib/session";
import { useState } from "react";
import { Market, getMarket, fmtPrice } from "@/lib/markets";
import type { Feed } from "@/lib/feed";
import { ACCOUNT, positionPnl, type Position } from "@/lib/account";
import { pct, usd } from "@/lib/format";
import { useLayoutMode, type LayoutMode } from "@/hooks/useMediaQuery";
import {
  R_XS,
  MONO,
  GREEN,
  RED,
  L1,
  L2,
  SEL,
  BG,
  PANEL,
  SUNK,
  TXT,
  MUT,
  DIM,
  FAINT,
  R_MD,
  R_SM,
  R_LG,
  W_BOOK,
  W_RAIL,
  H_BLOTTER,
  H_CHART_BAND,
  H_MOBILE_BLOTTER,
  H_MOBILE_PANE,
  H_TAB_STRIP,
  H_NAV_COMPACT,
  M_FRAME_TOP,
  M_FRAME_BOTTOM,
  M_FRAME_X,
  H_BOTTOM_NAV,
  H_ACTION_BAR,
  H_VIEW_TOGGLE,
  TAP_PRIMARY,
  TAP_CONTROL,
  monoLabel,
  sign,
} from "@/lib/theme";
import { MarketHeader, MarketHeaderCompact } from "../terminal/MarketHeader";
import { ChartPanel, ChartView, Timeframe } from "../terminal/ChartPanel";
import { OrderBookCompact, OrderBook } from "../terminal/OrderBook";
import { TradesTape } from "../terminal/TradesTape";
import { LiquidityPanel, LiquidityTab } from "../terminal/LiquidityPanel";
import { OrderTicket, Draft, isResting } from "../terminal/OrderTicket";
import type { OrderPlan } from "@/lib/orders";
import type { UiOrder } from "@/lib/api/adapter";
import { AccountPanel } from "../terminal/AccountPanel";
import type { LedgerFill, TwapView } from "@/lib/lifecycle";
import { Blotter, BlotterTab } from "../terminal/Blotter";
import { UnitToggle, Segmented } from "../terminal/primitives";
import type { Screen } from "../terminal/TopNav";

/** Which single view the one flexible row is spending its height on. */
export type MobilePane = "chart" | "book" | "trades";

/** Destinations that cover the trade screen rather than stacking under it. */
/*
 * `account`, not `positions`.
 *
 * The old `positions` sheet was a RISK destination that re-implemented Positions and
 * Working Orders as bespoke cards — the same rows the inline blotter renders directly
 * above it, with fewer columns, no sorting and no filters. A position appeared twice on
 * one screen in two layouts.
 *
 * The reference's third nav slot is `Account`, and it holds the account card and the
 * SAME blotter as every other screen. That is what this is now: reuse rather than a
 * second implementation, the same resolution our own review of the reference reached,
 * and the screen gets smaller rather than larger.
 */
export type MobileSheet = null | "ticket" | "account";

export type TradeState = {
  view: ChartView;
  tf: Timeframe;
  grouping: number;
  liquidity: LiquidityTab;
  blotter: BlotterTab;
  /**
   * Which order row is being amended inline, by id, or null.
   *
   * Here rather than inside Blotter because Terminal owns all state — and because an
   * order can vanish underneath the editor (a fill, a cancel-all), so the id has to
   * live where the ledger that invalidates it lives.
   */
  editingId: string | null;
  /** The blotter sub-view, when the active tab has one. See UrlState.sub. */
  sub: string;
  /** Mobile: which pane the viewport is spending itself on. See UrlState.pane. */
  pane: MobilePane;
  /** Mobile: the destination over the trade screen, or null. */
  sheet: MobileSheet;
  /**
   * Whether sizes read in the base instrument or in the quote.
   *
   * One setting for both liquidity panes, because the reference shows the same control
   * on each — `USDC` on the book, `SPCX` on the tape — and two independent copies of
   * one preference is a disagreement waiting to happen.
   */
  units: "base" | "quote";
  /**
   * Mobile/tablet: the market header's density.
   *
   * `""` means untouched, and the layout picks — tablet has room for four stat
   * columns and starts expanded, a phone does not. `"full"` and `"brief"` are the
   * reader's own choice and outrank the default.
   */
  stats: string;
  draft: Draft;
};

export function TradeScreen({
  market,
  feed,
  tick,
  mobile,
  state,
  onState,
  onDraft,
  onMarket,
  onScreen,
  plan,
  onSubmit,
  submitNote,
  orders,
  onCancelOrder,
  onCancelAll,
  positions,
  onClosePosition,
  onFlattenAll,
  onAmendOrder,
  fills,
  history,
  twaps,
  onCancelTwap,
  onDeposit,
  marks,
  selectorOpen,
  onSelectorOpen,
  session,
}: {
  market: Market;
  feed: Feed;
  tick: number;
  mobile: boolean;
  state: TradeState;
  onState: (patch: Partial<TradeState>) => void;
  onDraft: (patch: Partial<Draft>) => void;
  onMarket: (sym: string) => void;
  onScreen: (s: Screen) => void;
  plan: OrderPlan;
  onSubmit: () => void;
  submitNote?: { ok: boolean; text: string } | null;
  orders: UiOrder[];
  onCancelOrder: (id: string) => void;
  onCancelAll: () => void;
  positions: Position[];
  onClosePosition: (sym: string, fraction?: number) => void;
  onFlattenAll: () => void;
  onAmendOrder: (id: string, patch: { price?: number; size?: number }) => void;
  fills: LedgerFill[];
  history: UiOrder[];
  twaps: TwapView[];
  onCancelTwap: (id: string) => void;
  onDeposit: () => void;
  marks: Map<string, Feed>;
  /** The one market modal — ⌘K and the symbol pill open the same panel. */
  selectorOpen: boolean;
  onSelectorOpen: (v: boolean) => void;
  /** Drives every wallet-gated control on this screen. See lib/session. */
  session: Session;
}) {
  // Clicking a book level prices the ticket — and switches it off "market", since
  // a price you chose only means something for a resting order.
  const pickPrice = (px: number) =>
    onDraft({ price: px, type: isResting(state.draft.type) ? state.draft.type : "limit" });

  // Signed position in the market on screen, for the ticket's readout.
  const held = positions.find((p) => p.sym === market.sym);
  const heldSize = held ? held.size * (held.side === "LONG" ? 1 : -1) : 0;

  /*
   * Mobile / tablet state. Declared unconditionally, above the layout branch,
   * because hooks are not allowed to be conditional — the desktop shell simply
   * never reads them.
   *
   *   pane   · which ONE of chart / book / trades the single viewport is spending
   *            its space on. Co-visibility is a choice, and at 390px it is the
   *            wrong one.
   *   sheet  · the order ticket and the positions list, as destinations over the
   *            trade screen rather than panels stacked under it.
   */
  const layout = useLayoutMode();
  /*
   * Vertical policy at desktop.
   *
   * Measured against theirs: their blotter's top edge never moves off y=703 at any
   * viewport height. The chart never shrinks, and below ~680 the blotter simply
   * falls past the fold and is clipped — reachable by nothing. Ours did the
   * opposite: the blotter held its 168px and the chart absorbed every pixel lost,
   * down to a 158px canvas whose price labels collide with each other.
   *
   * Both are wrong in opposite directions — one makes the blotter unreachable, the
   * other makes the primary object unreadable. So: below 780px the blotter collapses
   * to its tab strip, which keeps the tabs reachable AND keeps the chart honest, and
   * one click on a tab (or the chevron) brings the table back at the cost of chart
   * height the user has now chosen to spend.
   */
  /*
   * The blotter collapse is now a CHOICE, not a response to the viewport.
   *
   * The auto-collapse below 780px is gone with the fluid layout it belonged to.
   * Under the rigid model the chart cannot be squeezed in the first place, so there
   * is nothing for an automatic collapse to rescue — but the chevron stays, because
   * "give the chart the whole band" is a thing a trader may want at any height.
   */
  const [blotterOpen, setBlotterOpen] = useState(true);
  const blotterCollapsed = !blotterOpen && !mobile;
  /* Both now come from the URL, so a mobile state is a link and the harness can
     grade it. Component state could not be reached by a capture, which is how a
     missing mobile blotter went unnoticed through four audits. */
  const pane: MobilePane = PANES.some((p) => p.id === state.pane) ? (state.pane as MobilePane) : "chart";
  const setPane = (p: MobilePane) => onState({ pane: p });
  const sheet: MobileSheet = state.sheet === "ticket" || state.sheet === "account" ? state.sheet : null;
  const setSheet = (v: MobileSheet) => onState({ sheet: v });

  if (mobile) {
    /*
     * The mobile information architecture.
     *
     * What this replaces: `MarketHeaderCompact → ChartPanel(240) → OrderBookCompact
     * → OrderTicket → AccountPanel → BlotterCompact` in a plain column with no
     * height constraint. Measured at 390×844 (UX-PATHS.md "Mobile path integrity"):
     * 1674px of content in an 844px viewport, submit 427px below the fold,
     * `Available to Trade` the last visible line, `Total Equity` at y=1358, and
     * 207px of horizontal scroll on the root. Eight of ten task paths could not be
     * completed. The reference's mobile trade screen instead measures
     * `scrollHeight === clientHeight === 844` (§1) — not because it has less in it,
     * but because it makes three decisions we had not made:
     *
     *   1. one view at a time, behind a `Chart | Order Book | Trades` toggle;
     *   2. the ticket is a destination, not the third of six panels;
     *   3. navigation is a persistent bottom bar, so a destination is cheap.
     *
     * So this branch is a fixed-height flex column, exactly one viewport minus the
     * shell chrome, with `overflow: hidden` and one flexible child. Nothing in it
     * can push anything else below the fold, and nothing can overflow sideways.
     *
     * One thing of theirs is deliberately NOT copied (§7): their ticket destination
     * shows no price at all, where ours carries a live identity + mark header.
     *
     * The other divergence recorded here — submit below the derived block rather
     * than above it — has since been resolved in their favour. With a summary whose
     * length varies by order type, putting it under the button is what keeps the
     * primary action at a fixed height.
     */
    const tablet = layout === "tablet";
    /* No H_STATUS_BAR: the status strip is desktop-only now. Leaving it in this sum
       would reserve 24px for a bar that is not rendered and leave a dead band above
       the nav. */

    /*
     * On a phone a sheet is a DESTINATION, so the screen behind it is not rendered.
     *
     * The sheet is `position: fixed` from top 0 and 100% wide, so at phone width it
     * covers the column completely — but covered is not the same as absent. Mounting
     * the Account destination put the real Blotter inside the sheet while the chart
     * screen's own Blotter stayed mounted underneath, which is TWO `role="table"`
     * elements with the identical label "Open positions" in one accessibility tree.
     * A screen reader would find both; a sighted user can only see one. That is the
     * same duplication this whole change set out to remove, one layer up.
     *
     * Tablet keeps it: there the sheet is a 400px side panel over a backdrop, and the
     * screen behind it is genuinely visible, so it has to be genuinely there.
     */
    const sheetIsDestination = Boolean(sheet) && !tablet;

    return (
      <div
        style={{
          position: "relative",
          /*
           * 100% of the slot the shell gives it, not a dvh calculation.
           *
           * This used to compute `100dvh − chrome` and re-derive the chrome from six
           * tokens, which meant two files had to agree on a sum — and one of them had
           * already been wrong once, reserving a status bar that no longer rendered.
           * The shell now bounds every screen the same way, so the arithmetic has
           * exactly one home and this just fills what it is handed.
           */
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {!sheetIsDestination && (
          <>
        <MarketHeaderCompact
          market={market}
          feed={feed}
          onMarket={onMarket}
          selectorOpen={selectorOpen}
          onSelectorOpen={onSelectorOpen}
          layout={layout}
          /* Tablet has room for four columns and so starts expanded; the URL wins
             over that default once the reader has touched the control. */
          dense={state.stats === "" || state.stats === undefined ? tablet : state.stats === "full"}
          onDense={(v) => onState({ stats: v ? "full" : "brief" })}
        />

        {/* The substitution. One row buys back four scroll-position problems. */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: H_VIEW_TOGGLE,
            padding: "0 12px",
            borderBottom: `1px solid ${L2}`,
            background: SUNK,
          }}
        >
          <div style={{ display: "flex", flex: "1 1 auto", minWidth: 0, gap: 4 }}>
            {PANES.map((p) => {
              const on = p.id === pane;
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setPane(p.id);
                    // Keep the URL-addressable book/trades tab in step, so a
                    // deep link still lands where the toggle points.
                    if (p.id === "book" || p.id === "trades") onState({ liquidity: p.id });
                  }}
                  aria-pressed={on}
                  style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    // Segmented-control tier: 36–40, the band both we and the
                    // reference already sit in (theirs measures 127×39).
                    height: TAP_CONTROL,
                    border: "none",
                    borderRadius: R_SM,
                    background: on ? SEL : "transparent",
                    color: on ? TXT : FAINT,
                    fontFamily: MONO,
                    fontSize: 10.5,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/*
         * The pane's own controls, on their own strip.
         *
         * They used to share the tab row, and at 390px there is not room: `ORDER BOOK`
         * rendered as `ORDER BOO` and the `LIVE` chip was cut in half. That is exactly
         * the failure `OverflowTabs` exists to prevent — a label truncated to something
         * that is not a word — in a strip that does not use it, and it was visible in
         * every mobile capture we have taken.
         *
         * Theirs puts grouping on a strip below the tabs, which is why theirs fits.
         * The strip only renders for the panes that have controls, so the chart pane
         * does not pay 34px for an empty row.
         */}
        {(pane === "book" || pane === "trades") && (
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              height: 34,
              padding: "0 12px",
              borderBottom: `1px solid ${L1}`,
              background: SUNK,
            }}
          >
            {pane === "book" ? (
              <>
                <Segmented
                  options={market.groupings}
                  active={state.grouping}
                  onSelect={(grouping) => onState({ grouping })}
                  format={String}
                />
                <UnitToggle
                  base={market.base}
                  quote={market.quote}
                  value={state.units}
                  onChange={(units: "base" | "quote") => onState({ units })}
                />
              </>
            ) : (
              <>
                <span style={{ ...monoLabel(9.5), color: MUT }}>LIVE</span>
                <UnitToggle
                  base={market.base}
                  quote={market.quote}
                  value={state.units}
                  onChange={(units: "base" | "quote") => onState({ units })}
                />
              </>
            )}
          </div>
        )}

        {/*
         * ONE SCROLLER for the pane and the blotter together.
         *
         * They used to be two fixed bands, each scrolling inside itself. Measured, the
         * blotter's window came out 87px tall with 141px of overflow — a two-row
         * peephole at the very bottom edge of the screen, which is also the worst place
         * on a phone to put a nested scroller: the gesture either moves two rows or
         * does nothing at all depending on where the thumb lands.
         *
         * The rigidity was buying nothing here. The chart band is 284px and the blotter
         * 150px against a ~720px body, so there was slack either way — and a pinned
         * chart is worth less than a usable list when the chart is one tap away on its
         * own tab.
         *
         * The chart keeps a definite height because a plot needs one. Everything else
         * is natural height and travels with it.
         */}
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* The chart alone gets a definite height — a plot cannot size to its own
              content. The other two panes are natural height and scroll with the page. */}
          <div
            /* `key` is the whole mechanism: React tears the subtree down and builds
               it again, so the mount animation runs. Re-applying a class to a live
               element does not restart it — same reason the book flash keys on seq. */
            key={pane}
            className="nx-swap"
            style={
              pane === "chart"
                ? { flex: "0 0 auto", height: H_MOBILE_PANE, display: "flex", flexDirection: "column" }
                : { flex: "0 0 auto", display: "flex", flexDirection: "column" }
            }
          >
          {pane === "chart" && (
            <ChartPanel
              market={market}
              feed={feed}
              view={state.view}
              onView={(view) => onState({ view })}
              tf={state.tf}
              onTf={(tf) => onState({ tf })}
              grouping={state.grouping}
              compact
            />
          )}
          {pane === "book" && (
            /* The two-sided book, not the desktop ladder narrowed. See
               OrderBookCompact — 22 levels against the stacked layout's 18, and the
               spread readable from the two adjacent price columns. */
            <OrderBookCompact
              market={market}
              feed={feed}
              units={state.units}
              onPickPrice={(px) => {
                pickPrice(px);
                // Picking a level is the start of an order, so take the trader to
                // the ticket with the price already in it.
                setSheet("ticket");
              }}
            />
          )}
          {pane === "trades" && <TradesTape feed={feed} market={market} units={state.units} />}
          </div>

        {/*
         * The blotter, INLINE — which is what the reference does on a phone and what
         * ours did not do at all.
         *
         * Theirs puts its full tab strip and table under the chart at 390px:
         * Balances / Positions / Outcomes / Open Orders / TWAP…, with the same empty
         * state as desktop. Ours had no blotter on this screen — positions were a
         * destination behind a RISK button and open orders were unreachable without
         * leaving the trade screen entirely. That is a whole surface missing, not a
         * density difference.
         *
         * It is NO LONGER a fixed band. It and the pane above it are one scrolling
         * region now — see the scroller above — because a 150px band on a phone is a
         * two-row peephole and a nested scroller at the bottom edge of the screen is
         * the worst place to put one.
         */}
        <div
          style={{
            /* Natural height now, not a 150px band. It is inside the one scroller, so
               the table shows every row it has and the reader scrolls the screen rather
               than a window inside it. */
            flex: "0 0 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderTop: `1px solid ${L2}`,
            background: SUNK,
          }}
        >
          <Blotter
            tab={state.blotter}
            onTab={(blotter) => onState({ blotter, sub: "" })}
            tick={tick}
            onSelectMarket={onMarket}
            onApiKeys={() => onScreen("portfolio")}
            orders={orders}
            onCancelOrder={onCancelOrder}
            onCancelAll={onCancelAll}
            positions={positions}
            onClosePosition={onClosePosition}
            onFlattenAll={onFlattenAll}
            onAmendOrder={onAmendOrder}
            fills={fills}
            history={history}
            twaps={twaps}
            onCancelTwap={onCancelTwap}
            marketSym={market.sym}
            sub={state.sub}
            onSub={(sub) => onState({ sub })}
            onDeposit={onDeposit}
            editingId={state.editingId}
            onEdit={(editingId) => onState({ editingId })}
            /* Three tiers: the phone gets priority-1 columns only. One tier for 390
               and 834 was tuned for the tablet and left every tab overflowing at
               phone width — Positions by 226px. */
            density={tablet ? "narrow" : "phone"}
            marks={marks}
          />
        </div>
        </div>
        </div>

        {/*
         * The BUY / SELL bar is gone from this screen.
         *
         * It was the last thing on the chart screen that theirs does not have, and it
         * was there for a reason that stopped being true: it predated `Trade` being a
         * destination. Their phone layout puts the order ticket behind the second nav
         * slot and nothing else, because the whole argument for a mobile IA is one
         * thing at a time — a screen that is the market AND the order entry is the
         * desktop layout with the middle removed.
         *
         * What it cost, stated plainly: buying is now two taps from the chart (Trade,
         * then Buy) where it was one. What it buys is 56px of chart on a 390px screen
         * and one unambiguous answer to "where do I place an order".
         */}
          </>
        )}

        {sheet === "ticket" && (
          <MobileSheetShell
            title="Order"
            market={market}
            feed={feed}
            layout={layout}
            onClose={() => setSheet(null)}
          >
            <OrderTicket
              market={market}
              last={feed.last}
              draft={state.draft}
              onDraft={onDraft}
              buyingPower={ACCOUNT.buyingPower}
              currentPosition={heldSize}
              plan={plan}
              onSubmit={onSubmit}
              submitNote={submitNote}
            />
          </MobileSheetShell>
        )}

        {sheet === "account" && (
          /* No market, no feed — see MobileSheetShell. */
          <MobileSheetShell title="Account" layout={layout} onClose={() => setSheet(null)}>
            {/* Theirs, exactly: the account card, then the blotter. Nothing bespoke —
                this is the same component with the same props that the chart screen
                mounts above the action bar and that Portfolio mounts under its header.
                Three surfaces, one implementation. */}
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <div style={{ flex: "0 0 auto", padding: "12px 12px 4px" }}>
                <AccountPanel tick={tick} defaultOpen onDeposit={onDeposit} session={session} />
              </div>
              <div
                style={{
                  flex: "1 1 auto",
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  borderTop: `1px solid ${L2}`,
                  background: SUNK,
                }}
              >
                <Blotter
                  tab={state.blotter}
                  onTab={(blotter) => onState({ blotter, sub: "" })}
                  tick={tick}
                  onSelectMarket={(sym) => {
                    onMarket(sym);
                    setSheet(null);
                  }}
                  onApiKeys={() => onScreen("portfolio")}
                  orders={orders}
                  onCancelOrder={onCancelOrder}
                  onCancelAll={onCancelAll}
                  positions={positions}
                  onClosePosition={onClosePosition}
                  onFlattenAll={onFlattenAll}
                  onAmendOrder={onAmendOrder}
                  fills={fills}
                  history={history}
                  twaps={twaps}
                  onCancelTwap={onCancelTwap}
                  marketSym={market.sym}
                  sub={state.sub}
                  onSub={(sub) => onState({ sub })}
                  onDeposit={onDeposit}
                  editingId={state.editingId}
                  onEdit={(editingId) => onState({ editingId })}
                  density={tablet ? "narrow" : "phone"}
                  marks={marks}
                />
              </div>
            </div>
          </MobileSheetShell>
        )}
      </div>
    );
  }

  /*
   * Desktop shell. The right rail spans the full height and the blotter spans only
   * the chart and book — not the rail. That ordering matters: with the blotter
   * full-width underneath, it steals the ticket's vertical space, which is what
   * forced the book and tape to share a column in the first place. Giving the
   * ticket its own uninterrupted column means it can grow (margin mode, brackets,
   * the request preview) without squeezing anything else.
   *
   *   ┌──────────────────────┬────────┬────────┐
   *   │ market header        │        │        │
   *   ├──────────────────────┤  book  │ ticket │
   *   │ chart                │        │        │
   *   ├──────────────────────┴────────┤        │
   *   │ blotter                       │ account│
   *   └───────────────────────────────┴────────┘
   *
   * THE HEADER SPANS THE CHART COLUMN ONLY, and the book runs full height beside it.
   *
   * This was briefly changed to span both, on the strength of a reference capture at
   * 1440 — which turned out to be the wrong side of a breakpoint theirs has between
   * 1440 and 1512. Measured on their live site: at 1280 and 1440 the header runs over
   * the book and the book starts beneath it; at 1512, 1680, 1920 and 2560 the header's
   * right edge and the book's left edge are the same pixel and the book runs full
   * height. 1512 is a 15-inch MacBook, which is where this gets looked at.
   *
   * The lesson is about the build-time verification, not the layout: `desktop` in
   * our own config is pinned at 1440, so every reference capture we hold shows the
   * narrow branch of a layout that has two.
   */
  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* Everything except the rail. `overflow: hidden` is what makes the rigid model
          rigid: on a viewport shorter than the stack the blotter is clipped here
          rather than compressing the chart above it. */}
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* RIGID. `0 0 H_CHART_BAND`, not `1 1 auto`: the chart holds its height and
            the stack neither grows into a tall viewport nor collapses into a short
            one. On a short viewport the blotter below is clipped by this column's
            own overflow, which is exactly what the reference does. */}
        <div style={{ flex: `0 0 ${H_CHART_BAND}px`, minHeight: 0, display: "flex" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${L2}` }}>
            <MarketHeader
              market={market}
              feed={feed}
              onMarket={onMarket}
              selectorOpen={selectorOpen}
              onSelectorOpen={onSelectorOpen}
            />
            <ChartPanel
              market={market}
              feed={feed}
              view={state.view}
              onView={(view) => onState({ view })}
              tf={state.tf}
              onTf={(tf) => onState({ tf })}
              grouping={state.grouping}
            />
          </div>

          {/* Level with the nav rather than below the header — which is what theirs
              does at 1512 and up. */}
          <div style={{ flex: `0 0 ${W_BOOK}px`, display: "flex", flexDirection: "column" }}>
            <LiquidityPanel
              market={market}
              feed={feed}
              tab={state.liquidity}
              onTab={(liquidity) => onState({ liquidity })}
              grouping={state.grouping}
              onGrouping={(grouping) => onState({ grouping })}
              onPickPrice={pickPrice}
            />
          </div>
        </div>

        <div
          style={{
            flex: "0 0 auto",
            height: blotterCollapsed ? H_TAB_STRIP : H_BLOTTER,
            borderTop: `1px solid ${L2}`,
            display: "flex",
            flexDirection: "column",
            background: SUNK,
          }}
        >
          <Blotter
            tab={state.blotter}
            /* Changing tab clears the sub-view: carrying `sub=fills` from TWAP into Account
               Activity leaves a key in the URL that means nothing on the tab it lands on.
               Each view already falls back to its own default, so this is about the URL
               being readable rather than about correctness. */
            onTab={(blotter) => onState({ blotter, sub: "" })}
            tick={tick}
            onSelectMarket={onMarket}
            onApiKeys={() => onScreen("portfolio")}
            orders={orders}
            onCancelOrder={onCancelOrder}
            onCancelAll={onCancelAll}
            positions={positions}
            onClosePosition={onClosePosition}
            onFlattenAll={onFlattenAll}
            onAmendOrder={onAmendOrder}
            fills={fills}
            history={history}
            twaps={twaps}
            onCancelTwap={onCancelTwap}
            marketSym={market.sym}
            collapsed={blotterCollapsed}
            /* Invert the EFFECTIVE state, not the stored one. Inverting the stored
               null against the viewport made the first click a no-op: from null on a
               short viewport it wrote `false`, which is the state it was already in,
               so the blotter only opened on the second press. */
            onToggleCollapsed={() => setBlotterOpen((v) => !v)}
            sub={state.sub}
            onSub={(sub) => onState({ sub })}
            onDeposit={onDeposit}
            editingId={state.editingId}
            onEdit={(id) => onState({ editingId: id })}
            density={mobile ? "narrow" : "wide"}
            marks={marks}
          />
        </div>
      </div>

      {/* Full-height right rail: ticket, then account, in ONE scroller.
       *
       * The account card used to be pinned to the bottom with the ticket taking the
       * slack above it. That read as deliberate while the ticket was tall enough to
       * fill the rail; once the request preview came out of the ticket it left a
       * ~250px hole between the attestation line and Total Equity. The reference
       * stacks the two cards and lets them scroll together, which is also the only
       * arrangement that stays right as the ticket's height changes with order type
       * — TWAP is five summary rows taller than a stop. */}
      <div
        tabIndex={0}
        aria-label="Order ticket and account"
        style={{
          flex: `0 0 ${W_RAIL}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: `1px solid ${L2}`,
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
        }}
      >
        <OrderTicket
          market={market}
          last={feed.last}
          draft={state.draft}
          onDraft={onDraft}
          buyingPower={ACCOUNT.buyingPower}
          currentPosition={heldSize}
          plan={plan}
          onSubmit={onSubmit}
          submitNote={submitNote}
        />
        {/* Open by default now. It was collapsed to keep the submit button above
            the fold at 800px, which the shorter ticket no longer needs — and the
            reference shows the breakdown without asking. */}
        <AccountPanel tick={tick} defaultOpen onDeposit={onDeposit} session={session} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Mobile / tablet information architecture
 *
 * Everything below belongs to the `if (mobile)` branch above and to nothing else.
 * It lives here rather than in the branch so the branch stays readable as a
 * layout, and it is deliberately local: none of it is a general primitive yet.
 * ------------------------------------------------------------------------- */


const PANES: { id: MobilePane; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "book", label: "Order Book" },
  { id: "trades", label: "Trades" },
];

/**
 * A destination over the trade screen.
 *
 * The header is the point. The reference's ticket destination shows **no price at
 * all** — no symbol, no mark, no last, only a truncated ticker chip — so you place
 * a market order with the instrument's price nowhere on screen. Any sheet of ours
 * carries the live identity and mark it is about, which is cheap here because the
 * feed is already in scope.
 *
 * At tablet it is a side sheet rather than a full cover, so the chart and the book
 * stay visible beside it — same reasoning, one step further.
 */
function MobileSheetShell({
  title,
  market,
  feed,
  layout,
  onClose,
  children,
}: {
  title: string;
  /*
   * The market context is OPT-IN, and both are omitted together.
   *
   * This shell always drew the symbol and the live mark, which is right for the ticket
   * — you are placing an order in a specific market at a specific price, and the
   * reference's own ticket destination showing no price at all is a divergence we
   * argued for and kept.
   *
   * It is wrong for Account. Balances, positions and equity span every market you
   * hold; the symbol you happened to be charting when you tapped the tab has nothing
   * to do with any of it, and a live price ticking away above a balance sheet implies
   * a relationship that is not there. Theirs has no market context on Account either —
   * its Account destination goes straight from the top bar into the equity card.
   */
  market?: Market;
  feed?: Feed;
  layout: LayoutMode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const tablet = layout === "tablet";
  const c = feed?.candles[feed.candles.length - 1];
  const up = c ? c.c >= c.o : true;

  return (
    /*
     * Viewport-anchored, not container-anchored, and it stops exactly at the top
     * of the bottom nav.
     *
     * This is worth being precise about, because it is the difference between the
     * submit button being reachable and not. Inside the trade screen's own box the
     * sheet body measured 650px against a 715px ticket, so `Buy 0.05 BTC` sat 65px
     * past the scroll edge — better than the 427px it used to sit below the fold,
     * but still a scroll to reach the primary action. Anchoring to the viewport and
     * reclaiming the top bar and the status bar gives the body
     * `844 − 62 (nav) − 52 (head) = 730`, which is more than the ticket needs, so
     * the whole ticket including its derived block and its button is on screen at
     * once.
     *
     * The nav is deliberately NOT covered. A modal that hides the primary
     * navigation is how the reference loses the way back out of a route
     * — the sheet stops above it instead, so both the
     * × and the tab bar are always live.
     */
    <div
      style={{
        position: "fixed",
        /*
         * BELOW the top bar, not over it.
         *
         * The sheet used to start at 0 with zIndex 44 against the nav's 40, so on the
         * two destinations that are sheets — Trade and Account, two of five slots —
         * the wordmark, the ticker and the account control were painted over. Verified
         * by hit-testing the logo at its own centre: reachable on the chart screen,
         * covered on both sheets.
         *
         * Theirs keeps its top bar on every mobile destination, including Account,
         * and puts the panel underneath it. That is what a persistent bar is FOR: a
         * fixed reference point that survives navigation. One that vanishes on two of
         * five destinations is not persistent, it is intermittent.
         */
        top: H_NAV_COMPACT + M_FRAME_TOP,
        left: M_FRAME_X,
        right: M_FRAME_X,
        bottom: H_BOTTOM_NAV + M_FRAME_BOTTOM,
        display: "flex",
        justifyContent: "flex-end",
        // Over the top nav (40) and the market header (20), under the bottom nav (45).
        // Inside the frame, so the sheet does not square off the card it covers.
        borderRadius: R_LG,
        overflow: "hidden",
        zIndex: 44,
      }}
    >
      {tablet && (
        <div
          onClick={onClose}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)" }}
        />
      )}
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: "relative",
          width: tablet ? 400 : "100%",
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: BG,
          borderLeft: tablet ? `1px solid ${L2}` : undefined,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: market ? 52 : 42,
            padding: "0 6px 0 14px",
            borderBottom: `1px solid ${L2}`,
            background: PANEL,
          }}
        >
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={monoLabel(9)}>{title}</span>
            {market && (
              <span style={{ fontFamily: MONO, fontSize: 12, color: TXT, whiteSpace: "nowrap" }}>{market.sym}</span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {market && feed && (
            <div style={{ textAlign: "right", lineHeight: 1.2 }}>
              <div style={{ fontFamily: MONO, fontSize: 15, color: up ? GREEN : RED }}>{fmtPrice(market, feed.last)}</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: market.chg24 >= 0 ? GREEN : RED }}>
                {pct(market.chg24)}
              </div>
            </div>
          )}
          <button
            onClick={onClose}
            aria-label={`Close ${title}`}
            style={{
              flex: "0 0 auto",
              width: TAP_PRIMARY,
              height: TAP_PRIMARY,
              border: "none",
              background: "transparent",
              color: MUT,
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            ×
          </button>
        </div>

        {/* The only scroller in the mobile IA, and it is a destination, so a scroll
            position here costs nothing on the screen behind it. */}
        <div
              tabIndex={0}
              aria-label="Order ticket"
              style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
            >
          {children}
        </div>
      </div>
    </div>
  );
}
