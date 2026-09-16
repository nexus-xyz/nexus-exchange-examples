# exchange-platform-demo

A complete white-label perpetuals venue frontend built against the Nexus Exchange
API contract: a partner deploys a branded venue from one config file, and every
venue trades into the same central order book. A reader learns what a full
trading frontend on the Exchange looks like — landing page, terminal, and
operator console — and how the API's types, enums, and market registry shape
every screen.

## What it does

- Serves three surfaces as three routes: a landing page (`/`), a trader-facing
  terminal (`/trade`), and a venue operator's console (`/admin`).
- Runs entirely on **mock data shaped by the real API contract** — `lib/api/` is
  a hand-transcribed mirror of the published OpenAPI spec (pinned at 0.7.0) and
  the engine's own types, so swapping mock for live is a base-URL change plus
  deleting the generators, not a UI rewrite (see `lib/api/README.md`).
- Emulates venue config, exact decimal maths, the builder fee, and an
  attribution ledger in `venue-kit/` (source-only TypeScript, 58 tests).

## Prerequisites

- Node 22 or later
- **No credentials** — every screen runs on the mocked contract layer.

## Run it

```bash
npm install && npm run dev   # http://localhost:3000
```

## Pinned versions

This example talks to no SDK; it mirrors the **Exchange API OpenAPI 0.7.0**
contract directly (`lib/api/README.md` records the pin and what re-verifying
against a newer spec would take).

---

Three surfaces ship from this one directory, and they are three routes rather than
three projects:

| Route | What it is |
|---|---|
| `/` | the landing page that sells the offering |
| `/trade` | the trader-facing terminal a venue deploys under its own brand |
| `/admin` | the venue operator's console — **bundled here for the demo only.** In the design it is a separate Nexus-hosted application. |

Beside them:

| Directory | What it holds |
|---|---|
| `venue-kit/` | tenant config, exact decimal maths, the builder fee, and an attribution ledger emulated on the published API. Source-only TypeScript, no runtime dependencies, 58 tests. The design direction dissolves it into the platform proper: the config schema moves to the admin API, the maths folds into the template. |

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

## What it consists of

Three screens behind one top nav — **Trade · Portfolio · Competitions** — over a single
1.1s clock. Portfolio sits second because it is the destination a trader returns to.

### Trade

A fixed four-region shell that never scrolls as a whole:

- **Market header** — switcher, mark, oracle price and basis, funding rate with the
  countdown to the next payment, 24h cells. Spans the chart only, not the book.
- **Chart pane** — candles with volume (TradingView Lightweight Charts, Apache-2.0),
  plus funding history and cumulative depth as our own SVG charts. Timeframes 1s → 1h,
  where the candle distribution actually scales with the timeframe.
- **Liquidity column** — order book and trades tape behind one tab strip, full height.
- **Blotter** — eight tabs (Balances, Positions, Open Orders, TWAP, Trade History,
  Funding History, Order History, Account Activity), sortable, filterable, with URL
  state and per-surface empty copy. Tabs that do not fit go to an overflow menu at
  desktop and scroll at phone width — two mechanisms, because the reference clips
  labels to single letters at 1440 and scrolls on a phone, and only one of those is
  worth copying.
- **Right rail** — the order ticket above the account summary.

A status bar spans the bottom at desktop, and a clickable market ticker scrolls in the
top bar.

### Portfolio

The blotter again — the same component, not a second implementation of it — under a
header of three cards: 14-day volume, taker/maker fees, and an accounts × period equity
block with a metric-selectable chart. Plus **API Keys** — credentials that can trade and
read and explicitly cannot withdraw, each with its scopes, last use, expiry and a revoke
— and **Subaccounts**, isolated margin buckets under one login.

Two modals reachable from the header: **Your Volume History** (14 daily rows against
exchange-wide volume) and **Fee Schedule** (a seven-tier ladder rendered from the
ticket's own rate constants, so the schedule and the order preview cannot disagree).

### Competitions

The Seasons incentive programme, as two sub-tabs:

- **Overview** — the live season card, the unlock matrix (seasons down, months after
  settlement across, so ladders of different lengths can be compared), the settlement
  record, and per-account analytics.
- **Leaderboard** — pseudonymous, per season.

Two honesty rules are enforced in the components rather than left to copy: an open
season's figure is an estimate and is labelled as one everywhere, and any USD figure is
derived from a mock NEX mark and says so.

### Mobile

Not a reflow of the desktop layout — a separate branch, matching the reference's
information architecture. The bottom bar reads
**Markets · Trade · Account · Portfolio · More**, where Markets opens the chart screen,
Trade opens the order ticket *over* it, and Account opens the account card over the same
blotter: on a phone "watch the market", "place an order" and "check what you hold" are
three destinations, not three parts of one screen. `Account` is mobile-only, which is
also theirs — at desktop width it lives in the right rail. `More` is a menu rather than a
fixed slot, so a sixth product costs a row in an array instead of a redesign of the bar.

The chart screen carries no order buttons and no status strip, which is also theirs:
the ticket is the `Trade` destination and nothing else, because the whole argument for a
phone layout is one thing at a time.

## What's interactive

The mock is a *working* interface. Real behaviour, not painted state:

- **Market switcher** — the whole screen is keyed on the symbol. Switching re-derives
  candles, book, tape, funding and every stat at the new market's tick precision, swaps
  the grouping ticks, clamps leverage to the new cap, and re-prices the order draft at
  the same dollar notional.
- **Order ticket** — side, type (Market / Limit plus a Pro group: Scale, TWAP, Stop
  Limit, Stop Market), price with MID, size with MAX and a base⇄quote swap,
  %-of-buying-power, leverage, margin mode (which moves the liquidation estimate), TIF,
  reduce-only, and a TP/SL bracket whose price and PnL fields drive each other. Order
  value, margin, liquidation and fee re-derive as you change it.
- **Order book** — click any level to price the ticket. Per-market grouping.
- **Blotter** — sort, filter, bulk actions, row → market navigation.
- **⌘K market panel** — the same panel the symbol pill opens, not a second surface.
  Search, class filter, sortable columns, arrow-key cursor. Reachable from every screen;
  it was Trade-only until `bd1e8f0`, because the panel was mounted inside the market
  header and two of three screens had none.

## Layout

```text
app/
  layout.tsx            fonts (Archivo + Geist Mono), metadata
  page.tsx              renders <Terminal/>
  competitions/         a direct route into the Competitions screen
  globals.css           reset, keyframes, :hover/:focus, touch rules, tap-target tiers

lib/
  api/                  the real Nexus API contract — types, enums, registry, adapter
  theme.ts              design tokens + style helpers — the only place colours live
  format.ts             seeded PRNG (mulberry32) + number formatting
  markets.ts            the market universe, built from the real 32-market registry
  feed.ts               (market, tick, grouping, timeframe) → candles, book, tape, funding
  account.ts            positions, orders, fills, API keys, fee tier, derived PnL
  orders.ts             the order lifecycle — a draft becomes a working order becomes a fill
  seasons.ts            the Competitions snapshot

hooks/
  useTick.ts            the terminal's single clock; ?tick=N freezes it
  useMediaQuery.ts      the layout switch
  useHotkey.ts          ⌘K and Escape
  useUrlState.ts        15 query params: screen, market, view, tab, blotter, sub, tf,
                        pane, sheet, stats, units, session, load, order, tick
  useFlash.ts           the up/down tick flash

components/
  Terminal.tsx          shell — owns all state, derives the feed once per tick
  charts/               Sparkline, CandleChart, TvCandleChart, DepthChart,
                        FundingChart, EquityCurve, Heartbeat, SeasonAnalytics
  terminal/             primitives.tsx (Panel, Tabs, Segmented, Table, RowGroup …)
                        plus TopNav, BottomNav, MarketTicker, StatusBar,
                        MarketSwitcher, NavDrawer, MarketHeader, LiquidityPanel,
                        OrderBook, TradesTape, OrderTicket, AccountPanel, Blotter,
                        BlotterTable, ChartPanel, FeeModals, DepositModal,
                        SeasonLeaderboard, states.tsx
  screens/              TradeScreen, PortfolioScreen, CompetitionsScreen
```

## Conventions

- **Tokens, not literals.** Every colour, font, radius and fixed chrome height comes from
  `lib/theme.ts`. A hex code inside a component is a bug, and the harness counts them.
- **States are URLs.** Screen, market, chart view, panel tab, blotter tab, sub-view,
  pane, sheet and clock are all query parameters. This is not only for deep links: it is
  what lets the harness navigate instead of click-script, and *addressable state is
  gradeable state* — three ARIA bugs surfaced the moment their state got an address.
- **Deterministic data.** `rng(seed)` and `seedOf(symbol)` only — never `Math.random()`
  or `Date.now()`. Server render and first client render must match.
- **Fixed history, breathing tail.** History is seeded off the symbol alone so it never
  rewrites itself; only the last candle, book and tape move with the tick.
- **Panels agree with each other.** Derived figures come from the same source the
  neighbouring panel plots. A header that contradicts the chart beside it reads as fake.
- **Panels are presentational.** They take data and callbacks. No panel holds a timer or
  derives its own feed, so every number on screen belongs to the same instant.
- **Two layouts, not one reflow.** Desktop is a fixed non-scrolling instrument panel;
  mobile is a scrolling stack in reading order. Separate branches, each argued.
- **The vertical model is rigid.** Panels keep their heights as the window shortens and
  the shell scrolls, rather than collapsing regions out from under you.
- **Heights that a media query must raise live in CSS, never inline.** An inline
  `minHeight` beats every stylesheet rule. (An inline `height` is fine — `min-height`
  clamps it.)
- **Text stays in the DOM.** Chart geometry is non-uniformly scaled SVG so it fills any
  panel; axis labels are HTML overlays positioned in percentages, because `<text>` inside
  a stretched SVG distorts with the plot.

## The API contract

`lib/api/` mirrors the published Exchange API OpenAPI spec: real `-USDX-PERP`
symbols, the real 32-market registry transcribed from the exchange's own
server-side market config, decimal values as branded strings, and precision
derived from each market's `tick_size` / `lot_size`.

`lib/api/README.md` records every divergence from the spec and what a future engineer
changes to point this at the live API. Capabilities the UI shows that the API does not
expose — margin mode and settable leverage among them — are flagged there rather than
quietly mocked.

## Status

Desktop, tablet and mobile were verified in a real browser at five viewports by a
deterministic capture-and-grade harness on the source branch (see Provenance); the
hard floor — renders, no console errors, no hydration mismatch, no overflow, axe
serious/critical, contrast AA, keyboard reachability — was clean at port time.

## Provenance

Ported from a concept built by Daniel Marin (August 2026) as a detailed, runnable
example of a frontend on the Exchange API — not the source of the production
nexus.xyz frontend, which is a separate codebase. The capture-and-grade audit
harness, the terminal-era research archive, and the planning documents stayed on
the source branch; this directory is the app alone.

## Positioning note

Copy here uses current framing: the Exchange and the Exchange blockchain. Internal
component names (NexusCore, NexusEVM, NexusBFT, Prover Network) are architectural
terms used in developer and internal docs; they deliberately do not appear in
this example's copy, which follows the same external-positioning language as the
rest of the public-facing product. Fee numbers are illustrative for the mock,
not the company's actual published fee schedule.
