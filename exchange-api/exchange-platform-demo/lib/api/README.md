# The API contract layer

This directory is the terminal's mirror of the **real Nexus Exchange API**. Its
whole purpose is that swapping this mock for the live venue is a base-URL change
plus deleting the PRNG generators — not a rewrite of the UI.

Ground truth, in priority order:

| Source | What it settles |
| --- | --- |
| `eng/apps/exchange/backend/common/exchange-types/src/lib.rs` | the engine's enums and structs — what actually rejects your order |
| `eng/apps/exchange/api/openapi.json` (`info.version` **0.7.0**) | the documented HTTP surface, vendored and byte-pinned |

> **Two spec versions appear in this repo and neither is wrong.** This mirror was
> hand-transcribed against **0.7.0** and byte-pinned to it, so that is the version
> it can honestly claim. The live spec is now **0.8.1**, and the newer surfaces —
> the venue console's API reference, `venue-kit`, the platform landing page — cite
> that. Re-verifying this mirror against 0.8.1 is real work and has not been done;
> until it is, changing the number here would be a claim rather than a fact.
| `eng/apps/exchange/backend/services/exchange.toml` | the 32-market registry: ticks, lots, margin rates, fees |

Where the engine and the spec disagree, **the engine wins** and the disagreement
is recorded below.

## Files

| File | Role |
| --- | --- |
| `types.ts` | wire types, one per spec schema. Nothing formatted, nothing converted. |
| `enums.ts` | the real enum values as `const` tuples + unions, type guards, casing conversions. |
| `markets.ts` | the 32-market registry transcribed from `exchange.toml`, plus tick/lot precision derivation. |
| `adapter.ts` | the only boundary. Wire → UI model (tolerant parsers) and UI → wire (validated serializers). |

Consumers: `lib/markets.ts` (universe + presentation), `lib/feed.ts` (mock market
data, emitted as wire payloads), `lib/account.ts` (mock account, authored as wire
fixtures).

## The contract in one page

**Symbols.** `{BASE}-USDX-PERP`, e.g. `BTC-USDX-PERP`. Everything is a perpetual
future; USDX is the quote *and* the collateral asset on every market.

**Two number conventions.** This is the highest-risk part of the contract.

- **Native endpoints** (`/markets`, `/orders`, `/positions`, `/fills`,
  `/account`, `/funding`, `/orders/history`, `/positions/closed`,
  `/orders/preview`, `/markets/{id}/mark-price`) serialize every monetary and
  quantity value as a **decimal string**. The spec's own words: *"Parse with a
  decimal type, never a float."*
- **CCXT-shaped endpoints** (`/tickers`, `/markets/{id}/ticker`,
  `/markets/{id}/orderbook`, `/markets/{id}/trades`, `/markets/{id}/candles`)
  use **JSON numbers**, because CCXT clients expect floats. Candles are bare
  tuples: `[ts_ms, open, high, low, close, volume]`.

`Decimal` in `types.ts` is a **branded string**, so a bare literal will not
typecheck into a price field. Construct with `dec()` (literals) or
`decFromNumber()` / `priceDecimal()` / `sizeDecimal()` (computed).

**Enums (verified, not guessed).**

| Enum | Values |
| --- | --- |
| `OrderType` (8) | `Limit` `Market` `StopLimit` `StopMarket` `TakeProfitLimit` `TakeProfitMarket` `TrailingStop` `TrailingLimit` |
| `TimeInForce` (4) | `GTC` `IOC` `FOK` `PostOnly` — **there is no `ALO`** |
| `OrderStatus` (7, engine) | `Open` `PartiallyFilled` `Filled` `Cancelled` `Rejected` `Expired` `Triggered` |
| `Side` | `Buy`/`Sell` on placement and `Order`; `buy`/`sell` on fills, public trades, order history |
| `PositionSide` | `Long`/`Short` |
| Candle timeframes | `1s` `1m` `5m` `1h` — and nothing else |

**Per-market parameters** (`GET /markets`): `tick_size`, `lot_size`,
`min_order_size`, `max_order_size`, `initial_margin_rate`,
`maintenance_margin_rate` as decimal strings, plus `max_leverage` as the one
integer. The engine asserts `max_leverage == floor(1 / initial_margin_rate)`.

**Precision is derived, never guessed.** Price decimals come from `tick_size`,
size decimals from `lot_size`. The real spread across the registry is six orders
of magnitude — `JPY-USDX-PERP` ticks at `0.000001`, `MKR-USDX-PERP` at `1` — so
any rule based on price magnitude is wrong at both ends. `stepDecimals()` in
`markets.ts` is the single implementation.

**PostOnly is a time-in-force, not a flag.** `OrderRequest` has no `post_only`
field. A post-only limit is `time_in_force: "PostOnly"`.

**Order-type field requirements** (enforced by `serializeOrderRequest`):

- limit-family (`Limit`, `StopLimit`, `TakeProfitLimit`) → `price` required
- triggerable non-trailing (`Stop*`, `TakeProfit*`) → `trigger_price` required
- `TrailingStop` → `trailing_offset_bps`; market-only, no `price`/`trigger_price`
- `TrailingLimit` → `trailing_offset_bps` **and** `limit_offset_bps` (0..9999)

---

## Divergences

### A. Spec ↔ engine ↔ reality

Real drift in the API itself. Each one is handled in code and commented at the
handling site.

1. **`price` vs `limit_price`.** The spec names the resting limit price `price`;
   the engine struct calls it `limit_price` and engine-proxied payloads can emit
   that name. → `WireOrder` declares both as optional; `parseOrder` reads
   `price ?? limit_price` and only complains when a limit-family order has
   neither.
2. **`Triggered` is missing from the spec.** `Order.status` in openapi.json lists
   six variants; the engine's `OrderStatus` has seven — a conditional order that
   has fired is `Triggered`. → `ORDER_STATUSES_WIRE` carries all seven;
   `ORDER_STATUSES_SPEC` records the narrower set so the gap is expressible in
   code. `Triggered` counts as an open status.
3. **Three casings for "side".** `Buy`/`Sell` on placement and `Order`,
   `buy`/`sell` on `Fill` / public `Trade` / `OrderHistoryEntry`, `Long`/`Short`
   on `Position`. → `sideToUi` / `sideToWire` / `sideToLower` /
   `positionSideToUi`, all tolerant, plus `directionOf()` returning ±1 for math.
   Nothing above the adapter compares raw wire strings.
4. **`order_type` casing flips on `/orders/history`.** PascalCase everywhere else,
   snake_case (`stop_limit`, `trailing_stop`) there. →
   `ORDER_TYPE_FROM_SNAKE`, applied by `parseOrderHistoryEntry`.
5. **`size` vs `quantity` for the same concept.** `OrderRequest`/`Order` use
   `quantity`; `Fill`, `OrderHistoryEntry` and `AmendOrderRequest` use `size`. →
   the UI model uses `quantity` for orders and `size` for fills/positions; the
   serializers emit whichever name each endpoint wants.
6. **`liquidation_price` is hardcoded `"0"`** on the live `/positions` path. →
   `parsePosition` maps `0` to `null` (`liq: null`), because rendering "liquidates
   at $0" is worse than rendering nothing. The mock fixtures supply real values
   and flag them `liqIsSynthetic: true`.
7. **`stop_price` is deprecated** in favour of `trigger_price`; when both are sent
   `trigger_price` wins. → parsers read `trigger_price ?? stop_price`; serializers
   emit **only** `trigger_price`, never both.
8. **`GET /markets/{id}/mark-price` has no schema**, only an `example`. →
   `WireMarkPrice` is transcribed from that example (`{ market_id, mark_price }`,
   decimal string). If the real response differs, this is the type to fix.
9. **`EquityPoint.equity` is a JSON number** on an otherwise-native endpoint —
   the one place money is not a decimal string. → typed as `number`; not
   "corrected" client-side.
10. **The engine's `Fill` has no `fee` field**; the REST `Fill` does (fees are a
    settlement-layer derivation). A WebSocket fill event may therefore arrive
    without one. → `parseFill` falls back to `0` and records `fee_error`.
11. **Engine-only order fields are not settable over HTTP.** The engine's `Order`
    carries `client_id`, `stp` (self-trade prevention) and `max_slippage_bps`, but
    `OrderRequest` has no such fields. → declared optional and read-only on
    `WireOrder`; **do not** build UI that sets them.
12. **Margin mode is invisible.** The engine has `MarginMode::{Cross, Isolated}`,
    `Position.margin_mode` and `Position.allocated_margin`; the API's `Position`
    exposes none of them. `POST /account/margin` exists to add/remove isolated
    margin, yet no response field reports which mode a position is in. → there is
    nothing for a cross/isolated toggle to bind to. Not modelled.
13. **Leverage is not settable.** No `leverage` field on any request. Margin
    follows `initial_margin_rate`; `max_leverage` is its reciprocal. → a leverage
    control can only *display* `1 / imr`. `Position.lev` in `lib/account.ts` is
    explicitly mock.
14. **`exchange.toml` is richer than `GET /markets`.** Fees
    (`maker_rebate_bps` / `taker_fee_bps`), `price_band_bps`,
    `funding_interval_s`, `funding_rate_cap`, `max_open_interest`,
    `liquidation_penalty_bps` and `isolated_margin_floor_ratio` are all server
    config with **no API surface**. → carried on `RegistryMarket.extra` and
    labelled fixture-only. A live client cannot learn its own fee rate from the
    documented API.
15. **No fee-schedule, volume-tier, or open-interest endpoint** exists at all.
16. **No bracket / OCO placement.** The engine has bracket concepts
    (`CancellationReason::BracketClosed`, `BracketFlipped`) but `POST /orders`
    cannot compose a parent with children. Conditional orders are placed
    individually.
17. **Only four candle timeframes.** A "4H" or "1D" chart button must be
    assembled client-side from `1h` candles.
18. **Every route exists twice** — unversioned (`/orders`) and `/api/v1/orders`.
    They are the same handlers. Pick one prefix and put it in the base URL.
19. **`ALO` is not a time-in-force.** **Half resolved (`3ca5f1917`).** The ticket
    now declares `type Tif = "GTC" | "IOC" | "FOK" | "PostOnly"`
    (`components/terminal/OrderTicket.tsx:60`) and offers exactly those four
    (`:640`), so the enum half of this item is closed. `coerceTimeInForce()`
    keeps mapping `ALO` → `PostOnly` — it now guards a URL or a fixture rather
    than our own ticket, and is worth keeping for that.
    **Still live:** `Draft.postOnly` survives as a *separate boolean*
    (`OrderTicket.tsx:87`, defaulted `true` at `:105`, rendered as its own `Flag`
    toggle at `:665-668`) alongside the TIF. Post-only **is** a time-in-force on
    this API, so the ticket can now represent `{ tif: "IOC", postOnly: true }` —
    two controls that contradict each other, with no wire field for the second to
    serialize into. `serializeOrderRequest` never reads it, so the flag is
    already inert on the request path; deleting it is the fix, and
    `deriveOrder`'s maker/taker choice (`:132`) is its only remaining reader.
20. **`POST /orders/preview` has no caller.** `parsePreview` (`adapter.ts:621`)
    and `WirePreviewResponse` exist and nothing invokes them. The ticket instead
    derives Value / Margin / Liq. / Fee locally in `deriveOrder`
    (`OrderTicket.tsx:121`), which is a second implementation of numbers the
    venue will compute authoritatively. Not a spec divergence — a fidelity gap,
    recorded here because it is the same class of defect as A.19: a correct
    adapter function with no consumer.
21. **Fee rates are hardcoded in the ticket, not read from the registry.**
    `deriveOrder` uses `value * 0.0002` for taker and `value * -0.00005` for
    maker (`OrderTicket.tsx:130-131`). The real per-market rates are on the
    registry as `taker_fee_bps` / `maker_rebate_bps` (`RegistryMarket.extra`,
    A.14) and `feeFor()` (`adapter.ts:782`) already applies them. Two constants
    for 32 markets is wrong wherever the market disagrees, and it is wrong
    silently. Same fix as A.20: call the function that exists.

### B. Where this mock knowingly differs from a live client

Everything here is invented, and every item is commented as `MOCK` at its
definition.

**Presentation, not API.** `name`, `glyph`, `cls` (Crypto/Index/FX/Commodity),
`tier`, `ref` and `chg24` in `lib/markets.ts`. The API has no display name, no
asset class, and no icon. `cls` and `tier` are ours; `ref`/`chg24` seed the PRNG.

**Retired symbols.** The old mock listed `HYPE`, `TAO`, `XAG` and `DJI`, none of
which this venue trades. Three others were re-spelled by the registry
(`XAU`→`GOLD`, `NDX`→`NDQ`, `WTI`→`OIL`). `LEGACY_SYMBOLS` maps all of them —
renames to their real market, retired ones to the nearest listed market — so old
deep links still land somewhere sensible. The universe is now the real 32, with
the recognisable fourteen ordered first and also exported as `FEATURED`.

**Derived, because the API has no field:**

- `remaining = quantity - filled_qty` (no endpoint sends it; rounded at 12 dp to
  kill float artefacts before it seeds a close order)
- aggregate `maintMargin` — summed as `maintenance_margin_rate × notional` per
  position, using the registry's real rates. There is no aggregate maintenance
  margin anywhere in the API.
- `WorkingOrder.type` — a composed label ("Limit · post-only") squashing
  `order_type` + `time_in_force` + `reduce_only`, which are three separate fields
  on the wire
- `WorkingOrder.price` — non-null for a single-column blotter, falling back
  limit → trigger → 0, with `priceIsTrigger` flagging which it is
- `Position.fundingRate` — joined from `GET /funding` fixtures by market;
  `Position` itself carries no funding field
- the book grouping ladder (tick × 1/2/10/20) — the API defines the tick, not the
  UI's aggregation choices

**Pure fiction (no API surface):** `FEE_TIER`, `API_KEYS` (the `/keys` routes
exist but their bodies are not schematized in 0.7.0), `ACCOUNT.fees30d` /
`pnl30d` / `pnl30dPct` / `curveSeed`, and `MarketStats` (`vol24`, `oi`,
`fills24`, `high24`, `low24`, `spark`) — the closest real sources are
`/markets/summary`, `/markets/{id}/ticker` and `/account/equity-history`, and
open interest has no endpoint at all. Also `Feed.fillsPerSec`, `heartbeat()`, and
the oracle/mark basis wobble.

**Determinism over realism.** Timestamps are `EPOCH_MS + tick × 1100ms`, anchored
at `1776033900000` (the spec's own candle example). Trade ids are
`{base}-{tick}-{i}`. No `Date.now()`, no `Math.random()` — a given `(symbol,
tick)` renders exactly one frame, so the server and first client renders agree and
screenshots are reproducible. A live client gets real uuids and real clocks.

**Faithful-but-odd:** `stepDecimals` treats trailing zeros as significant, so
`tick_size = "0.10"` (ETH, GOLD) yields **2** display decimals even though the
last digit is always 0. That is what the config says the venue quotes.

---

## Wiring this to the live API

Nothing in `app/`, `components/` or `hooks/` should need to change. The work is
confined to four files.

1. **Base URL + prefix.** Add `NEXT_PUBLIC_NEXUS_API_URL` and pick a prefix
   (`/api/v1` is the versioned family; the unversioned routes are the same
   handlers). Every path in `types.ts` is documented on its type.

2. **Auth.** Public market data needs none (`security: []`). Account and trading
   routes need HMAC (`hmacAuth`) — obtained via `POST /auth/login` (EVM wallet
   signature) → `POST /keys`. WebSocket needs a token from `POST /ws/token`.
   Handle `429` from every route: rate limits are per-account, and
   `GET /account/rate-limit` reports headroom.

3. **Replace the registry fixture with a fetch.**
   `lib/api/markets.ts` → `REGISTRY` becomes `await fetch(BASE + "/markets")`.
   The parsed result is already `WireMarket[]`, so `priceDecimalsOf`,
   `sizeDecimalsOf`, `groupingsFor`, `snapToTick`, `snapToLot` keep working
   untouched. `RegistryExtra` has no source — fees and price bands must either be
   hardcoded, added to the API, or dropped from the UI.

4. **Replace the mock generators with requests.** In `lib/feed.ts`, the six
   `wire*()` functions each correspond to exactly one endpoint (listed in the file
   header). Delete them and fetch instead; keep `buildFeed`'s second half — the
   `parse*` calls — verbatim, because that is the same code path a live response
   already takes today.

5. **Replace the account fixtures with requests.** In `lib/account.ts`,
   `WIRE_POSITIONS` / `WIRE_OPEN_ORDERS` / `WIRE_FILLS` /
   `WIRE_FUNDING_PAYMENTS` / `WIRE_PORTFOLIO` become `GET /positions`,
   `GET /orders`, `GET /fills`, `GET /funding`, `GET /account/summary`. The
   `.map(parseX)` lines below them do not change. The module-level constants must
   become hook state (SWR or equivalent) — that is the one structural change, and
   it is a change to *when* data arrives, not to its shape.

6. **Order submission.** `serializeOrderRequest(draft, market)` already returns a
   spec-valid body plus a `problems[]` array; POST the body when `problems` is
   empty and show them otherwise. Handle `400` (margin, tick size), `401`, `429`.

7. **Live updates.** `GET /ws` (per-account) and `GET /stream` (public) replace
   tick-driven regeneration. Use `OrderBook.nonce` for gap detection. Fill events
   may lack `fee` (divergence A.10).

### Checklist before calling it wired

- [ ] no `Number(...)` on a decimal field outside `adapter.ts`
- [ ] no price or size posted without `snapToTick` / `snapToLot`
- [ ] no TIF value outside the four in `TIME_IN_FORCE_WIRE`
- [ ] `Triggered` orders render (they are open, not terminal)
- [ ] `liquidation_price === "0"` renders as unknown, not as `$0`
- [ ] a parse failure on one row degrades that row (`errors`), not the panel
- [ ] `429` handled on every request path

---

## Representing absence

`adapter.ts` is tolerant: a bad field degrades to a fallback and records
`errors["<wire_field>_error"]`. For a number that fallback is **`0`**, which is
the correct transport behaviour and the wrong rendering behaviour. Three concrete
lies it produces:

| Wire | Naïve render | What it tells a trader |
| --- | --- | --- |
| `liquidation_price: "0"` (A.6) | `$0.00` | this position liquidates at zero, i.e. is perfectly safe — the exact inverse of "unknown" |
| `fee` absent on a WS fill (A.10) | `$0.00` | the venue trades free |
| `equity` unparseable | `0` | margin ratio `0 / maint`, painting a liquidation that is not happening |

So absence is modelled as data.

**`absence.ts`** — the model, and the field-by-field inventory.

- `Absent = { absent: true; reason; code; field? }`, `Maybe<T> = T | Absent`,
  guards `isAbsent` / `isPresent`. `absent: true` is a plain literal discriminant,
  not a Symbol or class, so absence survives `JSON.stringify` — it has to travel
  through a server-component boundary and an SWR cache.
- `AbsenceCode` is a closed 11-value union: `missing`, `unparseable`,
  `not_computed`, `not_mirrored`, `incomplete`, `no_api_surface`,
  `not_on_endpoint`, `no_data_yet`, `upstream_error`, `unauthenticated`,
  `rate_limited`. Coarse on purpose — the code drives styling, the `reason` string
  drives the tooltip.
- Lifts from the real failure shapes: `fromParsed(entry, key, wireField)` reads
  the adapter's `*_error` bag; `fromErrorSibling(value, errorString, field)` reads
  the live API's own `*_error` sibling convention; `fromNullable`,
  `finiteOrAbsent`.
- One named helper per divergence, so the reason text is written once:
  `liquidationPrice` (A.6, `"0"` → `not_computed`), `positionLeverage`
  (A.13, `leverage: null` + `leverage_error: "margin_state_not_mirrored"`),
  `maxLeverageFromImr` (the cap, explicitly not the position's own figure),
  `marginMode` (A.12, always absent), `totalPnl` / `feePnl`
  (`total_pnl_complete: false` + `fee_pnl: null` → the *sum* is absent while its
  parts are present), `lastTradePrice` (`null` → `no_data_yet`, never `$0.00`),
  `fillFee` (A.10), `spread` (empty book side), `noApiSurface` (A.14/A.15).
- Combinators: `mapMaybe`, `firstPresent` (the `mark ?? last` chain, with reasons
  preserved), `allPresent` (a derived figure is absent if any input is), and
  `unwrapOr` — which is for sums and sort keys only. Unwrapping to display a
  fallback is the bug this module exists to stop.
- **Staleness is not absence.** `is_stale` means the value is present but not
  fresh, and the last known price beats `—`, so it is a sidecar: `Freshness`,
  `FRESH`, `freshness({ isStale, asOfMs, nowMs, staleAfterMs })`. Both inputs
  matter — the venue's flag is authoritative when present, an age threshold catches
  the case where our own socket died and nothing is updating the flag either.
  `nowMs` is always a parameter; nothing in `lib/` reads the clock.
- **The formatter contract**:
  `render(maybe, format) → { text, title, isAbsent, code }`. The formatter is only
  ever called on a present value, so a `number` formatter can never be handed an
  `Absent` and can never emit `NaN`. `ABSENT_GLYPH` is one em dash — not `0`, not
  `N/A`, not `-`.

The head of `absence.ts` carries **the absence inventory**: every field in the
divergence list above that can arrive absent, grouped by endpoint, each mapped to
its code, plus the ones that are *legitimately* null (an unfired `trigger_price`,
an uncancelled order's `cancellation_reason`, `early_access_allowed`) and must
**not** be badged. That list is the checklist for "can this panel represent
no-data".

**`components/terminal/states.tsx`** — the presentational half. `EmptyState`
(header row stays the caller's; this is one centred 13px line, no icon, no card,
no skeleton rows — geometry from `audit/reference/findings.blotter.md` §3, copy
ours from `EMPTY_COPY` since our empty means "you have none", not "connect a
wallet"), `LoadingState` / `LoadingFigure` (no spinners; the figure placeholder
is sized in `ch` so nothing shifts when the value lands), `ErrorState`
(message + `GET /positions · 503` + retry), `StaleBadge` / `StaleBanner` (amber,
the theme's degraded semantic — never red), `AbsentValue` (renders a `Maybe<T>`),
`CaveatValue` (a true figure with a caveat, e.g. a leverage that is the market cap
rather than the position's), `BadRow` (one unparseable row degrades itself), and
`TableState` (fixes the precedence: error → loading → empty, so a 503 never renders
as "No open positions").
