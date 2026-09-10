# liquidation-watch

Distance-to-liquidation and margin health for one Nexus Exchange account, next
to the venue's own auto-deleveraging record — how far each mark can move before
maintenance margin breaks, ranked by fragility, and what the engine actually did
the last time the insurance fund ran out in those markets.

```text
liquidation-watch — https://api.testnet.nexus.xyz/indexer (play funds)
credentials  key set (32 characters, hex), secret set (64 characters, hex)
read-only: this app issues GETs only

account   equity 12400  ·  maintenance margin 2670
          headroom 9730

positions, most fragile first

  BTC-USDX-PERP  Long 1.5  ·  notional 117000  ·  maintenance 1170
    estimate: liquidates if the mark falls 6552.18855218 to 71447.81144782 — 8.40% from 78000
    risk params: maintenance 0.01 · initial 0.02 · max leverage 50x
    market: active  ·  lifetime ADL events 2
    current mark 78012.5 (a later read — context only, not an input above)
    ADL record (this market): 2 event(s), 3 counterparty position(s) closed, 1201.00 absorbed by the insurance fund first
      most recent: seq 9002 at 1789000000000 ms, bankruptcy price 61234.5, 0.5 size closed

  SOL-USDX-PERP  Short 400  ·  notional 60000  ·  maintenance 1500
    estimate: liquidates if the mark rises 23.73170731 to 173.73170731 — 15.82% from 150
    risk params: maintenance 0.025 · initial 0.05 · max leverage 20x
    market: active  ·  lifetime ADL events 0
    current mark 149.94 (a later read — context only, not an input above)
    ADL record (this market): no events on this page. Not observed to reach the tail, which is not the same as safe.
```

> The block above is **illustrative**, not a transcript. The signed reads need
> credentials this repo does not hold — see [Notes](#notes) for exactly what was
> and was not exercised live.

This is the Rust companion to [`risk-guard`](../risk-guard), and the contrast is
the point. `risk-guard` checks an account against limits *you* set. This asks the
venue's question instead: **how close am I to being closed by the engine, and
what does that engine's tail behaviour look like in this market?**

## What it does, and what you learn from it

Four decisions in here are worth copying.

### 1. One coherent read, because these numbers get subtracted from each other

The snapshot comes from `GET /api/v1/account/state`, which returns the portfolio
summary **and** every open position from a single server-side read.

The obvious alternative — `GET /account/summary` and `GET /positions`, fired
together — is two independent requests. A fill landing between them returns an
aggregate that disagrees with the position list: an equity that has moved against
a maintenance total that has not. Every figure in this report is a subtraction
between those two halves (`headroom = equity − maintenance margin`), so a tear
does not add noise, it **invents headroom that never existed**. The single read
is the reason these numbers are allowed to be subtracted at all.

The one deliberate exception is the *current* mark price, read per market after
the snapshot. It is printed for context — how far the market has moved since —
and pointedly **not** fed into the arithmetic, for exactly the same reason.

### 2. The maths, and why a short is always closer than a long

An account is liquidatable once equity falls below maintenance margin. Shock one
market's mark by `d`, hold the rest still, and both sides move:

```text
E(d)  = E  + s·d              equity moves with the position (s is signed size)
MM(d) = MM + |s|·r·d          the notional it is charged on moves too
H(d)  = H  + d·(s − |s|·r)    H = E − MM, liquidatable at H ≤ 0

long  (s = +q):  the price must FALL by  H / (q · (1 − r))
short (s = −q):  the price must RISE by  H / (q · (1 + r))
```

The `(1 − r)` versus `(1 + r)` is not a sign slip. A falling price on a long
destroys equity *and* releases maintenance margin, so the two partly offset. A
rising price on a short destroys equity *and* demands more maintenance margin, so
they compound. A short is always nearer liquidation than the naive `H / q`
suggests, and a long always further. Get this wrong and every short in the report
reads safer than it is.

### 3. Three outcomes, and `Unknown` never means safe

Same discipline as the other `risk-*` examples, and it matters more here because
the inputs are nullable by design. The exchange reports a position's risk fields
as nullable, each paired with a machine-readable reason
(`notional_value` / `notional_value_error`). A tool that reads a missing notional
as zero concludes "maintenance margin is small, you have plenty of room" at the
exact moment it has no idea.

So every row is `Fragile` (a number), `Breached`, or `Unknown` — and `Unknown` is
never rendered, sorted or counted as safe.

`Unknown` is not a licence to stop reasoning, though, and that is the half people
get wrong. Every maintenance term is `notional × rate` with both factors
non-negative, so a missing term can only make the requirement **larger**. The
terms that do report give a lower bound on the requirement and hence an **upper
bound on headroom**:

- If even that upper bound is `≤ 0`, the account is provably liquidatable and no
  missing mark price can rescue it. A provable breach stays provable, and is
  reported ahead of everything else.
- If the bound is positive but incomplete, the true headroom lies somewhere below
  it, so every distance derived from it would overstate safety. Those rows go
  `Unknown` and name the markets that did not report.

Flat positions are the one exception in the other direction: at `size == 0` the
maintenance term is provably zero whatever the mark is, so a dust position in an
unmirrored market is skipped rather than allowed to poison the account's headroom
on every run.

### 4. The ADL record is history, not a forecast

`GET /markets/{id}/adl-events` returns settled facts: a bankrupt account, the
price its position was settled at, the bad debt the insurance fund absorbed before
it gave out, and the opposite-side positions the engine closed to absorb the rest.

It sits next to the distance estimate because the estimate answers "how close am I
to being closed by the engine?" and this answers "and what does being closed by
this engine, in this market, look like?". A market with a live ADL record has
reached the tail at least once. A market with none has not been *observed* to,
which is not the same as safe — and the report says so rather than printing a
reassuring zero.

Two counts appear, and they measure different things. `GET
/api/v1/markets/{id}/status` reports a lifetime `adl_event_count` and needs no
credentials; the event list is a bounded, most-recent-first page behind HMAC. They
disagree whenever the history is longer than the page, so both are printed rather
than reconciled into one number that would be wrong in one of the two senses.

## The gap this report cannot close

**It assumes cross margin, and it cannot check.** The wire carries `margin_mode`
on every position — measured, `"margin_mode":"cross"` on the public demo mirror —
but the SDK's `Position` type has no such field, so serde drops it silently. No
other read on the SDK's surface reports it.

That matters because the venue has a **live defect in the isolated admission
path**, and it points the wrong way. On the isolated path the pre-trade margin
*check* charges the raw order notional, while the *reservation* a few lines later
charges only the netted added exposure. So an isolated account near full
utilisation is refused the plain reducing order that would relieve it. A
`reduce_only` order short-circuits the check and still gets through; the ordinary
one does not. It is live for any market whose risk class forces isolated margin.

The consequence for this report is concrete: it can say *"8.40% from liquidation,
you have room to trim"* about an account the venue would in fact **refuse the trim
on**. This app does not try to detect that — it cannot — so it prints the caveat
on every run and points at the read that *can* answer it:
`POST /api/v1/orders/preview` returns the venue's own `accepted` / `reject_reason`
for an order it does not submit. This app is read-only and deliberately does not
call it. **If you are about to act on a distance printed here, preview the
reducing order first.**

Two smaller gaps, printed with the same honesty:

- **Single-market shock.** Each row moves one mark and holds the rest still. A
  real liquidation usually moves several at once, which is nearer than any row
  here.
- **No fees, funding or liquidation penalty.** All three move the true trigger
  closer than the number shown, never further.

And the reason the estimate exists at all: `Position::liquidation_price` comes
back `null`, paired with `liquidation_price_error: margin_state_not_mirrored`.
There is no server-side number to compare against.

## Prerequisites

- Rust 1.86+ (stable). Built and tested on 1.91.
  > `nexus-exchange` 0.11.0 declares `rust-version = "1.86"`, and the committed
  > `Cargo.lock` is lockfile v4, so anything older fails `cargo build --locked`
  > outright rather than degrading.
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).
  Two of the reads are HMAC-gated server-side, so there is no useful
  credential-free mode.

## Pinned versions

This example pins **`nexus-exchange` 0.11.0** (the Rust SDK), with `rust_decimal`
1.42.1 and `tokio` 1.53.1. Exact `=` pins, and `Cargo.lock` is committed, so a
reader a year from now gets the behaviour this README describes rather than a
silently-upgraded SDK.

## Setup

```bash
cp .env.example .env   # then add your testnet API key and secret
set -a; . ./.env; set +a
```

## Run

```bash
cargo run
```

`--help` prints the usage. There are no other options; anything else is
**refused** rather than ignored, because an argument this app silently drops is
a belief about behaviour that does not exist.

## Configuration

Everything is read from the environment; nothing is read from a committed file.
See [`.env.example`](./.env.example). Credentials are echoed back only as a shape
— `set (64 characters, hex)` — never as a value, and never as a prefix.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret |
| `NEXUS_EXCHANGE_API_URL` | no | Override the REST base. Validated at startup; must **not** end in `/api/v1` |
| `NEXUS_ACCOUNT_ADDRESS` | no | Your `0x` address. Unlocks the account-scoped ADL history |
| `NEXUS_ADL_LIMIT` | no | ADL events per read, 1–1000, default 20 |

`NEXUS_ACCOUNT_ADDRESS` has to be supplied because
`GET /account/{address}/adl-history` is keyed by address and **the API surface the
SDK wraps has no "who am I" read** — nothing on `/account`, `/account/summary` or
`/account/state` carries it. The app skips that section rather than guessing.

## Which deployment it talks to

**Testnet — play funds.** The base URL is spelled out in `src/config.rs` as
`https://api.testnet.nexus.xyz/indexer` rather than left to the SDK's
`Network::Testnet`, and that is not a style choice. In SDK 0.11.0,
`Network::Testnet.base_url()` is still `https://exchange.nexus.xyz/api/exchange`,
which is decommissioned and answers `500` on every route. Left to the default,
this example would not run.

Two things about the durable base, measured 2026-09-09:

```text
https://api.testnet.nexus.xyz/indexer/api/v1/markets/summary  → 200, JSON
https://api.testnet.nexus.xyz/api/v1/markets/summary          → 404, fault filter abort
https://exchange.nexus.xyz/api/exchange/api/v1/markets/summary → 500, HTML
```

The `/indexer` prefix is load-bearing: the whole API is mounted under it and the
bare host 404s. The deployment strips the prefix before the request reaches the
service that verifies signatures, and the SDK signs the path it *appends* to the
base — `/api/v1/account/state`, not `/indexer/api/v1/account/state` — so signing
lines up without any special handling. That is why the app passes the base to
`CustomNetwork` and does nothing else about it.

One diagnostic worth knowing before you conclude your base is wrong: a `503 no
healthy upstream` on an `/indexer` path is the **upstream** being down, and it
still proves your routing is right. Only a `404` means a wrong prefix.

Passing `NEXUS_EXCHANGE_API_URL` builds a `Network::Custom` with `Funds::Unknown`,
because a bare URL cannot declare what the target moves. The banner then prints
"funds not declared" rather than claiming play funds. The default base is the one
target this app is willing to call `Funds::Play`.

## Notes

- It is an example, not production-hardened code. It runs once and exits, keeps
  no state, and has no alerting beyond stdout.
- **Read-only by construction.** Every call is a `GET`: `/api/v1/account/state`,
  `/markets/{id}/risk-params`, `/api/v1/markets/{id}/status`,
  `/api/v1/markets/{id}/mark-price`, `/markets/{id}/adl-events` and
  `/account/{address}/adl-history`. Nothing is placed, cancelled or moved. That
  is also why there is no shutdown choreography: with no in-flight write, a
  Ctrl-C cannot abort anything that matters — the `tokio::select!` hazard
  `risk-guard` documents at length simply does not arise here.
- **Money is never a float, and this is the example where that bites.** Every
  monetary field arrives as a decimal string and stays in `rust_decimal::Decimal`
  end to end. A distance-to-liquidation is a subtraction followed by a division
  followed by a comparison against a price — three places binary floating point
  would quietly decide the wrong way. `src/margin.rs` pins a verbatim wire
  capture and asserts that the same field sent as a JSON *number* fails the
  decode rather than being rounded into one.
- **Rounding always goes towards liquidation.** Display precision is 8 decimal
  places, and every rounded value moves the answer nearer the trigger: the
  printed distance is never larger than the exact one, the printed liquidation
  price never further from the mark. Display precision can make the report read
  more urgent, never less. All the comparisons happen on unrounded values.
- **A failed read degrades one line, not the report** — except the account
  snapshot, which is not optional. Reporting "no open positions" because a
  request failed is the one lie a margin tool must not tell, so that read is the
  only hard failure, and it exits with the SDK's `sysexits.h` code (`77` for
  credentials, `65` otherwise). Every other read is soft: a market whose
  risk-params call fails costs that market an `Unknown`, not the other markets'
  answers.
- **What was exercised live, and what was not.** The unauthenticated reads were
  run against `https://api.testnet.nexus.xyz/indexer` on 2026-09-09: `/markets`,
  `/markets/{id}/risk-params`, `/api/v1/markets/{id}/mark-price` and
  `/api/v1/markets/{id}/status` all answer `200` with money as decimal strings.
  The signed reads — `/api/v1/account/state`, `/markets/{id}/adl-events`,
  `/account/{address}/adl-history` — were **not** exercised: this repo holds no
  testnet credentials, and all three answer `401 UNAUTHORIZED` unsigned, which is
  the gate confirmed rather than the path. The decode and the arithmetic are
  covered by `cargo test` against a verbatim capture of the public demo mirror's
  own position (`/indexer/demo/positions`), which is the same `Position` shape
  `/account/state` returns.
- **The wire agrees with the spec here, unlike elsewhere.** ENG-8439 records the
  indexer emitting `PortfolioPoint`'s money fields as JSON numbers where the spec
  declares lossless decimal strings. Every field this example consumes was
  checked against the live wire rather than trusted from the schema, and they are
  strings as specified: `size`, `entry_price`, `notional_value`, `margin_used`,
  `unrealized_pnl`, `realized_pnl`, `roe`, `mark_price`,
  `maintenance_margin_rate`, `initial_margin_rate`. The number-typed fields
  nearby — `MarketSummary::last_trade_price` and `volume_24h`,
  `Position::leverage` — are not read by this app.
- **Not implemented, and out of scope:** previewing a reducing order (a `POST`,
  and this app does not write), per-position isolated margin (the client cannot
  see the mode), multi-market correlated shocks, and streaming — testnet serves a
  WebSocket origin, but `Network::Testnet.ws_base()` is `None` in SDK 0.11.0
  (ENG-3398) and a one-shot report has nothing to stream anyway.
