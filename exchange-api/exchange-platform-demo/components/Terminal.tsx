"use client";

/*
 * Nexus Exchange — terminal shell.
 *
 * Owns all cross-panel state and derives the feed once per tick, then hands both
 * down. Panels are presentational: they take data and callbacks, never their own
 * timers or fetches. That's what keeps every figure on screen belonging to the
 * same instant.
 *
 * State that lives here:
 *   screen     · which of the three screens is showing
 *   symbol     · the selected market — every derived figure keys off this
 *   trade      · chart view, timeframe, book grouping, blotter tab, order draft
 *   palette    · ⌘K open/closed
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { getMarket, DEFAULT_MARKET, type Market } from "@/lib/markets";
import { buildFeed } from "@/lib/feed";
import { planOrder, submitPlan } from "@/lib/orders";
import {
  amend as amendInLedger,
  cancel as cancelInLedger,
  cancelAll as cancelAllInLedger,
  closePosition as closeInLedger,
  flattenAll as flattenInLedger,
  exposedSymbols,
  placeAndSettle,
  seedLedger,
  startTwap,
  twapViews,
  cancelTwap as cancelTwapInLedger,
  settle,
  workingOrders,
  type Ledger,
} from "@/lib/lifecycle";
import type { MarketId } from "@/lib/api/types";
import { TICK_MS } from "@/lib/feed";
import { TIMEFRAMES } from "./terminal/ChartPanel";
import { TWAP_FREQUENCY_S, twapSchedule } from "./terminal/OrderTicket";
import { Blotter, isBlotterTab } from "./terminal/Blotter";
import { BG, TXT, ARCHIVO, L2, PANEL, R_LG, M_FRAME_X, M_FRAME_TOP, M_FRAME_BOTTOM } from "@/lib/theme";
import { isSession, type Session } from "@/lib/session";
import { LoginModal } from "./terminal/LoginModal";
import { NavDrawer } from "./terminal/NavDrawer";
import { useTick } from "@/hooks/useTick";
import { useMarks } from "@/hooks/useMarks";
import { useIsMobile, useLayoutMode } from "@/hooks/useMediaQuery";
import { useHotkey } from "@/hooks/useHotkey";
import { useUrlState, type UrlState } from "@/hooks/useUrlState";
import { TopNav, Screen, SCREENS } from "./terminal/TopNav";
import { DepositModal } from "./terminal/DepositModal";
import { MarketSwitcher } from "./terminal/MarketSwitcher";
import { DataPhaseProvider, encodeLoad, parseLoad, type PhaseMap } from "@/lib/dataphase";
import { decodeDraft, encodeDraft } from "@/lib/draftUrl";
import { MarketTicker } from "./terminal/MarketTicker";
import { StatusBar } from "./terminal/StatusBar";
import { BottomNav } from "./terminal/BottomNav";
import { CompetitionsScreen } from "./screens/CompetitionsScreen";
import { TradeScreen, TradeState } from "./screens/TradeScreen";
import { PortfolioScreen } from "./screens/PortfolioScreen";
import { Draft, initialDraft, notionalToSize } from "./terminal/OrderTicket";

/**
 * What has to change when the market changes.
 *
 * Extracted because there are two ways in — the switcher and a URL restore — and
 * when only the switcher did this, deep-linking to a market left the draft holding
 * the previous market's size. At JPY's zero size-decimals, BTC's 0.05 rendered as
 * `0` and the submit button read "Buy 0 JPY".
 *
 * Intent is preserved, scale is not: price clears back to "follow the mid", size is
 * re-derived at the same dollar notional (0.05 BTC and 0.05 JPY are not comparable
 * intents), leverage is clamped to the new cap, and grouping resets to the new
 * market's finest tick since the old one may not exist here.
 */
function rebaseToMarket(s: TradeState, prev: Market, next: Market): Partial<TradeState> {
  return {
    grouping: next.groupings[0],
    draft: {
      ...s.draft,
      price: null,
      trigger: null,
      size: notionalToSize(next, s.draft.size * prev.ref),
      lev: Math.min(s.draft.lev, next.maxLev),
    },
  };
}

export function Terminal({
  embedded = false,
  initialScreen = "trade",
}: {
  embedded?: boolean;
  /** Lets a route (e.g. /competitions) deep-link straight to a screen. */
  initialScreen?: Screen;
}) {
  const tick = useTick();
  const mobile = useIsMobile() && !embedded;
  /* `mobile` is everything under 1024, which is two very different widths. The blotter
     needs to tell them apart — see the `density` prop passed to Portfolio below. */
  const layout = useLayoutMode();

  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  /*
   * ONE market modal, owned here.
   *
   * ⌘K and the symbol pill open the same panel. They used to open two different
   * surfaces — a dropdown hanging off the pill, and a separate command palette that
   * also happened to list markets — which meant two layouts, two filter models and two
   * ideas of what a market row shows, for one question. The reference has one.
   */
  const [selectorOpen, setSelectorOpen] = useState(false);
  /* The mobile navigation drawer, behind the wordmark. See NavDrawer. */
  const [drawer, setDrawer] = useState(false);

  /*
   * The session, in the URL. `out` is the default and is therefore absent from it.
   *
   * The shell owns it because five surfaces read it: the nav pill, the account panel's
   * money controls, the order ticket's submit, the blotter's empty copy and the deposit
   * modal. Threading a boolean through five components is how a "logged out" state ends
   * up meaning something slightly different on each of them.
   */
  const [session, setSession] = useState<Session>("out");
  /*
   * The data phase, PER SURFACE. See lib/dataphase: five independent loading regions
   * rather than one global flag, because one flag blanking twelve panels is the exact
   * failure model AGENTS.md rule 9 forbids. `?load=public` is the one that matters —
   * market data up, account pending.
   */
  const [phase, setPhase] = useState<PhaseMap>({});
  /* One deposit modal for the whole terminal: the account card and the Balances tab
     both open it, and two owners is how two dialogs end up stacked. */
  const [deposit, setDeposit] = useState(false);

  const market = getMarket(symbol);

  const [trade, setTrade] = useState<TradeState>(() => ({
    view: "price",
    tf: "1m",
    grouping: getMarket(DEFAULT_MARKET).groupings[0],
    liquidity: "book",
    blotter: "positions",
    sub: "",
    pane: "chart",
    sheet: null,
    stats: "",
    units: "base",
    editingId: null,
    draft: initialDraft(getMarket(DEFAULT_MARKET)),
  }));

  /* `trade.tf` is a dependency as well as an argument. It was neither, which is why
     the timeframe control was inert. */
  const feed = useMemo(
    () => buildFeed(market, tick, trade.grouping, trade.tf),
    [market, tick, trade.grouping, trade.tf],
  );

  /*
   * The order ledger — working orders, order history, fills and positions in one
   * object. See lib/lifecycle.ts for why it is one and not four: a fill has to debit
   * an order and credit a position atomically, and as separate pieces of state those
   * two updates cannot be composed, so they would sit out of step for a commit.
   */
  const [ledger, setLedger] = useState<Ledger>(seedLedger);
  const [submitNote, setSubmitNote] = useState<{ ok: boolean; text: string } | null>(null);

  /* Derived for the panels, which still take a plain order array and a position array. */
  const orders = useMemo(() => workingOrders(ledger), [ledger]);
  const positions = ledger.positions;

  /*
   * One feed per market the account has exposure to, built here so every panel marks
   * against the same prices — and so settlement matches against the same ladder the
   * OrderBook is rendering.
   */
  const exposed = useMemo(() => exposedSymbols(ledger), [ledger]);
  const marks = useMarks(tick, exposed);

  /*
   * The clock advancing the ledger. The only place that happens.
   *
   * `settle` is idempotent per tick and returns the identical object when there is
   * nothing to do, so React bails out rather than re-rendering. That guard is what
   * makes this safe under StrictMode's deliberate double-invoke — see lib/lifecycle.ts.
   */
  useEffect(() => {
    setLedger((l) => settle(l, tick, marks));
  }, [tick, marks]);

  const plan = useMemo(() => planOrder(trade.draft, market, feed.last), [trade.draft, market, feed.last]);

  /* Runs, with progress derived from the same fills the blotter renders. */
  const twaps = useMemo(() => twapViews(ledger, tick), [ledger, tick]);

  const cancelTwap = useCallback(
    (id: string) => {
      setLedger((l) => cancelTwapInLedger(l, id, tick));
      setSubmitNote({ ok: true, text: `TWAP ${id} stopped — released slices are unaffected` });
    },
    [tick],
  );

  const submit = useCallback(() => {
    const out = submitPlan(plan, market);
    if (!out.ok) {
      setSubmitNote({ ok: false, text: out.problems[0] });
      return;
    }
    /*
     * A TWAP is not placed, it is STARTED. The plan carries every slice — a 24-hour
     * run is 2,881 of them — and submitting all of them at once is the exact thing a
     * TWAP exists not to do. The plan is still what validates the draft and counts the
     * slices; the orders come from the scheduler in `lib/lifecycle.ts`, one per
     * interval. The blotter then lands on the TWAP tab, because that is where the
     * thing you just started can be watched — which is the surface this order type
     * shipped without.
     */
    const d = trade.draft;
    if (d.type === "twap") {
      const { orders, sizePer } = twapSchedule(d, market.minOrderSize);
      setLedger((l) =>
        startTwap(
          l,
          {
            sym: market.sym as MarketId,
            side: d.side === "buy" ? "BUY" : "SELL",
            size: d.size,
            sizePer,
            slices: orders,
            frequencyTicks: Math.max(1, Math.round((TWAP_FREQUENCY_S * 1000) / TICK_MS)),
          },
          tick,
          marks,
        ),
      );
      setSubmitNote({ ok: true, text: `TWAP started — ${orders} slices, 1 released` });
      setTrade((t) => ({ ...t, blotter: "twap", sub: "", editingId: null }));
      return;
    }
    setLedger((l) => placeAndSettle(l, plan.requests, tick, marks));
    setSubmitNote({ ok: true, text: out.note });
    // Show the consequence, not just a toast: jump the blotter to the orders tab.
    setTrade((t) => ({ ...t, blotter: "orders", sub: "", editingId: null }));
  }, [plan, market, tick, marks, trade.draft]);

  const cancelOrder = useCallback(
    (id: string) => {
      setLedger((l) => cancelInLedger(l, id, tick));
      // The editor cannot outlive its row.
      setTrade((t) => (t.editingId === id ? { ...t, editingId: null } : t));
      setSubmitNote({ ok: true, text: `cancelled ${id} · DELETE /v1/orders/${id}` });
    },
    [tick],
  );

  /**
   * Close a position at the mark. Real venues do this as a reduce-only market order
   * on the opposite side, so that is what the note reports — the position vanishing
   * is the local consequence of a fill we have no engine to receive.
   */
  const closePosition = useCallback((sym: string, fraction = 1) => {
    setLedger((l) => closeInLedger(l, sym, fraction));
    const pct = Math.round(fraction * 100);
    setSubmitNote({
      ok: true,
      text: `${pct === 100 ? "closed" : `reduced ${pct}% of`} ${sym} · POST /v1/orders reduce_only`,
    });
  }, []);

  /*
   * The note is built from the count BEFORE the update, read outside the updater.
   *
   * It used to be set inside `setPositions`/`setOrders`, which is a side effect inside
   * a reducer — the exact shape of the bug documented further down this file, where a
   * double-invoked updater turned a 0.05 BTC order into a $32tn one. React may call an
   * updater more than once; it may not call it at all if the result is identity.
   */
  const flattenAll = useCallback(() => {
    const n = ledger.positions.length;
    setLedger(flattenInLedger);
    setSubmitNote({ ok: true, text: `flattened ${n} positions · reduce-only market orders` });
  }, [ledger.positions.length]);

  /** Re-price or resize a working order. PATCH /orders/{id} — `size`, not `quantity`. */
  const amendOrder = useCallback(
    (id: string, patch: { price?: number; size?: number }) => {
      /*
       * Computed OUTSIDE the updater, from the current ledger. The obvious shape —
       * assigning `body` from inside `setLedger` — is a side effect inside a reducer,
       * which is the bug class documented at the foot of this file. It reads as
       * harmless here because the value would be identical on a double-invoke, but the
       * pattern is the one that cost a $32tn order, so it does not get a second outing.
       */
      const out = amendInLedger(ledger, id, patch, tick);
      setLedger(out.ledger);
      const body = out.body;
      const what = [
        body.price !== undefined ? `price ${body.price}` : null,
        body.size !== undefined ? `size ${body.size}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setSubmitNote(
        what
          ? { ok: true, text: `amended ${id} — ${what} · PATCH /v1/orders/${id}` }
          : { ok: false, text: `amend ${id} changed nothing · InvalidAmend` },
      );
    },
    [ledger, tick],
  );

  const cancelAll = useCallback(() => {
    const n = ledger.working.length;
    setLedger((l) => cancelAllInLedger(l, tick));
    setTrade((t) => ({ ...t, editingId: null }));
    setSubmitNote({ ok: true, text: `cancelled ${n} orders · DELETE /v1/orders` });
  }, [ledger.working.length, tick]);

  // Round-trip latency for the status bar. Derived from the tick so it drifts
  // plausibly without a timer of its own.
  const latencyMs = 18 + Math.round(Math.abs(Math.sin(tick * 0.23)) * 14);

  const patchTrade = useCallback((patch: Partial<TradeState>) => setTrade((s) => ({ ...s, ...patch })), []);
  const patchDraft = useCallback(
    (patch: Partial<Draft>) => setTrade((s) => ({ ...s, draft: { ...s.draft, ...patch } })),
    [],
  );

  /**
   * Switching market keeps the trader's intent and re-scales what is market-
   * specific: price clears back to "follow the mid", size is re-derived at the
   * same dollar notional (0.05 BTC and 0.05 EUR are not comparable intents), and
   * leverage is clamped to the new market's cap. Grouping resets to the new
   * market's finest tick, since the previous one may not exist here.
   */
  const selectMarket = useCallback(
    (sym: string) => {
      if (sym === symbol) return;
      const prev = getMarket(symbol);
      const next = getMarket(sym);
      setSymbol(sym);
      setTrade((s) => ({ ...s, ...rebaseToMarket(s, prev, next) }));
    },
    [symbol],
  );

  /*
   * URL <-> state. Restore on mount and on back/forward; write on change.
   * This is what makes every state in audit/manifest.json actually reachable —
   * see hooks/useUrlState.ts for why it is a mount effect and not a render read.
   */
  const writeUrl = useUrlState((u: UrlState) => {
    /* Session restores like every other piece of state, so `?session=in` is a
       shareable — and gradeable — screenshot of the connected app. */
    if (isSession(u.session)) setSession(u.session);
    if (u.load !== undefined) setPhase(parseLoad(u.load));
    /* Absent means closed rather than "leave alone", so back out of a deep link
       into the deposit modal actually closes it. */
    setDeposit(u.deposit === "1");
    setSelectorOpen(u.markets === "1");
    if (u.screen && (SCREENS as readonly string[]).includes(u.screen)) setScreen(u.screen as Screen);
    if (u.market) {
      const next = getMarket(u.market);
      // getMarket falls back to the default on an unknown symbol; only adopt it
      // if the URL named something real, or a typo would silently show BTC.
      if (next.sym === u.market) {
        setSymbol(next.sym);
        /*
         * A deep link INITIALISES the draft for the named market — it does not
         * rebase from whatever was there. There is no prior trader intent to
         * preserve when you arrive from a URL, and rebasing needs a `from` market
         * that a restore does not meaningfully have.
         *
         * The first attempt did rebase, by calling setTrade from inside a
         * setSymbol updater. That is a side effect inside a reducer: StrictMode
         * double-invokes updaters, so the rebase applied twice and compounded —
         * 0.05 BTC became 510,000 JPY became 5.2e12 JPY, a $32tn order. Updaters
         * must be pure; this one now is.
         */
        setTrade((s) => ({
          ...s,
          grouping: next.groupings[0],
          /* The draft is initialised for the named market and then the `order` segment
             is applied over it. Order matters: `?market=ETH…&order=sell:20x` must size
             and clamp against ETH, not against whatever was on screen before. */
          draft: decodeDraft(u.order, initialDraft(next), next),
        }));
      }
    }
    /* `order` with no `market` — a deep link into the ticket on the current market.
       Applied here rather than in the market branch so it works either way. */
    if (u.order && !u.market) {
      const m = getMarket(symbol);
      setTrade((s) => ({ ...s, draft: decodeDraft(u.order, initialDraft(m), m) }));
    }
    setTrade((s) => ({
      ...s,
      view: u.view === "funding" || u.view === "depth" || u.view === "price" ? u.view : s.view,
      liquidity: u.tab === "book" || u.tab === "trades" ? u.tab : s.liquidity,
      blotter: isBlotterTab(u.blotter) ? u.blotter : s.blotter,
      tf: (TIMEFRAMES as readonly string[]).includes(u.tf ?? "") ? (u.tf as TradeState["tf"]) : s.tf,
      sub: typeof u.sub === "string" ? u.sub : s.sub,
      pane: u.pane === "book" || u.pane === "trades" || u.pane === "chart" ? u.pane : s.pane,
      sheet: u.sheet === "ticket" || u.sheet === "account" ? u.sheet : s.sheet,
      stats: u.stats === "full" || u.stats === "brief" ? u.stats : s.stats,
      units: u.units === "quote" || u.units === "base" ? u.units : s.units,
    }));
  });

  useEffect(() => {
    writeUrl({
      screen,
      market: symbol,
      view: trade.view,
      tab: trade.liquidity,
      blotter: trade.blotter,
      tf: trade.tf,
      /*
       * Empty string, NOT undefined.
       *
       * `writeUrl` reads undefined as "leave this key alone" and empty as "remove it".
       * Passing undefined meant a key could be written but never cleared: closing the
       * ticket left `sheet=ticket` in the URL, switching back to the chart left
       * `pane=book`, and a tab with no second level kept the previous tab's `sub`.
       * Every one of them then restored the stale value on reload.
       */
      sub: trade.sub || "",
      pane: trade.pane === "chart" ? "" : trade.pane,
      sheet: trade.sheet ?? "",
      // "" removes the key; the layout default takes over again, which is what
      // "I have not touched this" should mean on reload.
      stats: trade.stats || "",
      // `out` is the default and stays out of the URL.
      session: session === "out" ? "" : session,
      // All-ready is the default and stays out of the URL. `encodeLoad` collapses back
      // to a preset name when the map is one, so `?load=public` survives a round trip.
      load: encodeLoad(phase),
      /* Only the difference from the market's opening draft. A URL that restates every
         default is a URL nobody reads, and it hides the one thing a reviewer comparing
         two links is actually looking at. */
      order: encodeDraft(trade.draft, initialDraft(market)),
      // "base" is the default, so it does not need to be in the URL.
      units: trade.units === "quote" ? "quote" : "",
      // Closed is the default; "" removes the key rather than writing deposit=0.
      deposit: deposit ? "1" : "",
      markets: selectorOpen ? "1" : "",
    });
    /* `trade.sub` belongs in these deps like every other key written above. Without
       it the URL updated only when something ELSE changed, so a sub-tab click was
       addressable on reload and invisible in the address bar until then. */
  }, [writeUrl, screen, symbol, session, phase, deposit, selectorOpen, trade.draft, trade.view, trade.liquidity, trade.blotter, trade.sub, trade.tf, trade.pane, trade.sheet]);

  /* ⌘K opens the market modal — the same one the symbol pill opens. Theirs binds the
     chord to exactly this, and having it open a second, different surface was the whole
     problem. */
  useHotkey("k", () => setSelectorOpen((v) => !v), { meta: true });

  return (
    /* Every panel reads the phase from here, so "the venue is not answering" is one
       fact with one owner rather than a boolean threaded through eleven components —
       which is how a logged-out state ended up meaning something slightly different
       on each of five. */
    <DataPhaseProvider value={phase}>
    <div
      style={{
        position: embedded ? "relative" : "fixed",
        inset: embedded ? undefined : 0,
        width: embedded ? "100%" : undefined,
        height: embedded ? "100%" : undefined,
        display: "flex",
        flexDirection: "column",
        background: BG,
        color: TXT,
        fontFamily: ARCHIVO,
        /*
         * The shell never scrolls, at ANY width.
         *
         * It used to scroll on mobile, and that gave the app two different scroll
         * models. The trade screen sized itself to exactly one viewport minus the
         * chrome and scrolled its panes internally; Portfolio and Competitions grew to
         * their content and let this element scroll the whole page underneath a sticky
         * top bar and a fixed nav.
         *
         * The second model has a defect you can measure: the scrolling region is the
         * full 844px viewport, so its content passes UNDER the 62px nav. Scrolled to
         * the very end, the last content sat at y=831 against a nav starting at 782 —
         * 49px of the page permanently unreachable, on both screens.
         *
         * One model now: the bars are fixed, the region between them is bounded, and
         * every screen fills it and scrolls inside it.
         */
        overflow: "hidden",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <TopNav
        screen={screen}
        onScreen={setScreen}
        onOpenPalette={() => setSelectorOpen(true)}
        session={session}
        onAccount={() => setSession((v) => (v === "in" ? "out" : "pending"))}
        onOpenDrawer={() => setDrawer(true)}
        compact={mobile}
        ticker={<MarketTicker onSelect={selectMarket} active={symbol} />}
      />

      {/*
       * The mobile frame: screen content as an inset, rounded card.
       *
       * Theirs is not edge-to-edge — the top bar and the bottom nav sit on the page's
       * black and the screen lives in a card between them. Measured off their 390
       * capture: 4px at the sides, 8px under the bar, 4px above the nav. The edge is
       * what tells you where the scrollable region stops, which on a phone is the
       * difference between a screen that reads as one thing and one that reads as a
       * stack of things running under each other.
       */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          position: "relative",
          ...(mobile
            ? {
                margin: `${M_FRAME_TOP}px ${M_FRAME_X}px ${M_FRAME_BOTTOM}px`,
                borderRadius: R_LG,
                border: `1px solid ${L2}`,
                overflow: "hidden",
                background: PANEL,
              }
            : null),
        }}
      >
        {screen === "trade" && (
          <TradeScreen
            market={market}
            feed={feed}
            tick={tick}
            mobile={mobile}
            state={trade}
            onState={patchTrade}
            onDraft={patchDraft}
            onMarket={selectMarket}
            onScreen={setScreen}
            plan={plan}
            onSubmit={submit}
            submitNote={submitNote}
            orders={orders}
            onCancelOrder={cancelOrder}
            onCancelAll={cancelAll}
            positions={positions}
            onClosePosition={closePosition}
            onFlattenAll={flattenAll}
            onAmendOrder={amendOrder}
            fills={ledger.fills}
            history={ledger.history}
            twaps={twaps}
            onCancelTwap={cancelTwap}
            onDeposit={() => setDeposit(true)}
            marks={marks}
            selectorOpen={selectorOpen}
            onSelectorOpen={setSelectorOpen}
            session={session}
          />
        )}
        {screen === "competitions" && <CompetitionsScreen mobile={mobile} />}
        {screen === "portfolio" && (
          <PortfolioScreen
            mobile={mobile}
            tick={tick}
            onSelect={(sym) => {
              selectMarket(sym);
              setScreen("trade");
            }}
            /* One Blotter, two screens. Terminal owns the ledger, so it builds the
               element and both screens render it — which is why Portfolio could drop
               its bespoke positions and fills tables rather than keep them in sync. */
            blotter={
              <Blotter
                tab={trade.blotter}
                onTab={(blotter) => setTrade((t) => ({ ...t, blotter, sub: "" }))}
                tick={tick}
                onSelectMarket={(sym) => {
                  selectMarket(sym);
                  setScreen("trade");
                }}
                onApiKeys={() => setScreen("portfolio")}
                orders={orders}
                onCancelOrder={cancelOrder}
                onCancelAll={cancelAll}
                positions={positions}
                onClosePosition={closePosition}
                onFlattenAll={flattenAll}
                onAmendOrder={amendOrder}
                fills={ledger.fills}
                history={ledger.history}
                twaps={twaps}
                onCancelTwap={cancelTwap}
                marketSym={market.sym}
                sub={trade.sub}
                onSub={(sub) => setTrade((t) => ({ ...t, sub }))}
                onDeposit={() => setDeposit(true)}
                editingId={trade.editingId}
                onEdit={(editingId) => setTrade((t) => ({ ...t, editingId }))}
                /*
                 * `phone` at 390, not `narrow`.
                 *
                 * Portfolio was passing `narrow` for everything under 1024, so at
                 * phone width its blotter rendered six to ten columns and scrolled
                 * sideways — 408px of table inside 346px of card. That is exactly the
                 * defect the `phone` tier was added for, and the note on `Density` in
                 * BlotterTable measured it: at 390 the narrow tier overflows Balances
                 * by 44px, Working orders by 52, Trade history by 83 and Positions by
                 * 226. The trade screen has been picking correctly between the two
                 * since that tier existed; this call site never got the memo.
                 */
                density={layout === "mobile" ? "phone" : layout === "tablet" ? "narrow" : "wide"}
                marks={marks}
              />
            }
          />
        )}
      </div>

      {/*
       * Desktop only.
       *
       * The strip says TESTNET and WEBSOCKET, which is honest about what this mock is
       * and useful on a trading desk. On a phone it is 24px of permanent chrome
       * between the content and the nav bar saying something that does not change,
       * competing for the scarcest space in the product — and the reference has no
       * status bar at any width. Kept where it costs little and reads as instrument
       * detailing; dropped where it costs the most and reads as a footer.
       */}
      {!mobile && <StatusBar fillsPerSec={feed.fillsPerSec} latencyMs={latencyMs} compact={mobile} />}

      {/* The mobile IA's primary navigation. Sticky, so it survives a long route —
          the reference loses its nav entirely on one page. */}
      {mobile && (
        <BottomNav
          screen={screen}
          onScreen={setScreen}
          /* `Trade` is a destination on a phone, not a panel: it opens the ticket over
             the trade screen. Terminal owns that state because it is in the URL. */
          ticketOpen={screen === "trade" && trade.sheet === "ticket"}
          accountOpen={screen === "trade" && trade.sheet === "account"}
          onOpenTicket={() => setTrade((t) => ({ ...t, sheet: "ticket" }))}
          onOpenAccount={() => setTrade((t) => ({ ...t, sheet: "account" }))}
          onCloseSheet={() => setTrade((t) => ({ ...t, sheet: null }))}
        />
      )}

      {/*
       * The market panel on the screens that have no market header.
       *
       * ⌘K is bound here, globally, and the top nav's `Search ⌘K` button is on every
       * screen — but the panel is mounted inside `MarketHeader`, which only the trade
       * screen renders. On Portfolio and Competitions both entry points flipped
       * `selectorOpen` and nothing was listening. Two dead affordances on two of three
       * screens, and `no-dead-affordance` is a convention this project has never
       * mechanised.
       *
       * Conditional so there is exactly ONE panel mounted at a time — the trade screen
       * keeps the one in its header, which is anchored to the market row it belongs to.
       */}
      {screen !== "trade" && (
        <MarketSwitcher
          headless
          market={market}
          onSelect={(sym) => {
            selectMarket(sym);
            /* Choosing a market from Portfolio or Competitions means going to it.
               Opening the chooser and landing back where you started, with the change
               invisible, would be the affordance lying a second time. */
            setScreen("trade");
          }}
          compact={mobile}
          open={selectorOpen}
          onOpenChange={setSelectorOpen}
        />
      )}
      <DepositModal open={deposit} onClose={() => setDeposit(false)} compact={mobile} />

      {mobile && (
        <NavDrawer
          open={drawer}
          onClose={() => setDrawer(false)}
          screen={screen}
          onScreen={setScreen}
          session={session}
        />
      )}

      <LoginModal
        open={session === "pending"}
        onClose={() => setSession("out")}
        onConnect={() => setSession("in")}
        compact={mobile}
      />

      {/*
       * CommandPalette is gone.
       *
       * It was the second market surface: ⌘K opened a list of markets, screens and
       * commands, while the symbol pill opened a different panel listing the same
       * markets with different columns and different filters. Two answers to one
       * question, drifting apart every time either was touched — the selector gained
       * sorting, volume, open interest and funding; the palette did not.
       *
       * ⌘K now opens the market modal. What the palette uniquely held — jump to a
       * screen, Cancel All, Close All — has not been rebuilt here yet, and that is a
       * real subtraction rather than a tidy-up: it is recorded in
       * audit/reference/decisions.json so it is a decision and not an accident.
       */}
    </div>
    </DataPhaseProvider>
  );
}
