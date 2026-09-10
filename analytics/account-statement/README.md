# account-statement

A period **P&L, fee and funding statement** for one account, built directly on
the Exchange API — raw REST, no SDK. It adds up what you actually traded, what
it cost you in fees, what funding moved in each direction, and then
**reconciles that against the venue's own equity curve and reports the residual
instead of hiding it**.

It exists because nothing else in this catalog looks at your own history.
`analytics/market-report` covers venue-wide public data; this answers *"what
did I make, and where did it go"* — and it is where pagination, the weight-5
endpoints, and the difference between "zero" and "the venue didn't say" all
start to bite at once.

**It is read-only.** There is no order path, no cancel path, and no `--submit`
to forget. Every request it makes is a `GET`.

## What it does

```
02:41:07  Nexus Exchange account statement — https://api.testnet.nexus.xyz/indexer (play funds)
02:41:07  read budget 20/s, using 16.0/s (status), tier pro
02:41:07  reading portfolio-history (window day, weight 5)
02:41:08  reading fills (weight 5 per page)
02:41:09  reading funding (weight 1)
02:41:09  reading positions/closed (weight 1 per page)
02:41:10  reading account/fees (weight 1)
02:41:10  reading orders/history (weight 5 per page)

Account statement — https://api.testnet.nexus.xyz/indexer (play funds)
period: 2026-09-09 02:45:00Z → 2026-09-10 02:40:00Z  (window "day", nominally
24 hours, taken from the series the venue returned)

P&L by market
market                    realized            fees     funding net          volume   fills
BTC-USDX-PERP               412.66           -1.84           -3.20       128940.11      24
ETH-USDX-PERP               -88.12            2.07            0.95        41022.50      11
  ------------------------------------------------------------------------
TOTAL                       324.54            0.23           -2.25       169962.61      35

Fees
  charged over the period: 0.23 USDX across 35 fill(s) — 22 maker, 13 taker
  2 fill(s) stated NO fee at all, and are not in that total.
  An absent `fee` is not a fee of zero: `"0"` means the venue charged nothing
  (a liquidation fill is exempt), while an absent key means it said nothing.
  Those fills' fees are unknown, so the total above is a floor.
  schedule: maker -2 bps, taker 5 bps (tier "base", scope "standard")
  the maker rate is negative — that is a rebate, by design.
  rolling 30d volume: 1290440.02
  This is the forward-looking SCHEDULE rate, not a realized average. The
  realized number is the fee column above, which comes from the fills.

Funding
  paid           -5.40   (negative — the account paid this out)
  received        3.15   (positive — the account was credited this)
  net            -2.25
  Sign convention: `/funding` publishes `amount` SIGNED — negative when the
    account paid, positive when it received — and `direction` states the same
    fact in words. This statement sums the signed `amount` and checks each
    row's `direction` against its sign.
  depth: this answer reaches back to 2026-09-09 04:00:00Z and no further.
    Older funding exists durably and was not returned.
  truncated by `limit`: no (which is not a claim that this is the whole history)

Reconciliation against the venue's own curve
  derived from rows            322.29   (Σ realized on close + Σ funding, signed)
  venue's pnl delta            338.71   (PortfolioPoint.pnl, last − first)
  RESIDUAL                      16.42   (venue − derived; reported, not absorbed)

  The residual is made of:
    - Change in **unrealized** P&L across the window. …
    - **Whether `ClosedPosition.realized_pnl` is gross or net of fees.** …
    - **Edge effects at the two ends of the window.** …
    - **Float rounding at the server.** `PortfolioPoint.equity`, … arrived as
      JSON number(s) where the spec types them as lossless decimal strings …
```

The output above is illustrative — see [Notes](#notes) for exactly which parts
of this were exercised against a live account and which were not.

## Prerequisites

- **Node 22.4 or later.** It uses `process.loadEnvFile` (Node 22), and there is
  nothing to install at runtime: **zero runtime dependencies**, just `fetch`
  from the Node standard library. Developed on Node 26.3; CI builds on 22.
- **A Nexus Exchange testnet API key.** Not optional here, unlike most examples
  in this catalog: every endpoint this reads is your own account's history and
  all of them are authenticated. Create one in the
  [Exchange app](https://exchange.nexus.xyz).

## Pinned versions

There is no SDK to pin, so what this example pins is **the API contract
itself: spec `v0.8.1`**, from
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api/releases/tag/v0.8.1),
sent on every request as `X-Nexus-Api-Version: v0.8.1`. It targets **testnet** —
play funds, credited by the faucet, with no real-world value. It will not run
against mainnet: the mainnet host is refused by name in `config.ts`.

The toolchain is pinned exactly (no `^`): `typescript` `7.0.2`, `tsx` `4.23.8`,
`@types/node` `26.1.2`. `package-lock.json` is committed and CI installs from
it with `npm ci`.

## Setup

```bash
npm install
cp .env.example .env   # then add your API key and secret
```

## Run

```bash
npm start
```

Add `--window week|month|all` for a longer period, `--market BTC-USDX-PERP` to
narrow it to one market, and `--exact` to print the unrounded decimal string
behind every figure.

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | **yes** | API key id. Every endpoint here is authenticated. |
| `NEXUS_EXCHANGE_API_SECRET` | **yes** | API secret (hex) paired with the key. |
| `NEXUS_EXCHANGE_API_URL` | no | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Must **not** include `/api/v1` — see below. |
| `NEXUS_EXCHANGE_FUNDS` | no | `play` \| `real` \| `unknown`. Reported in the header; gates nothing, because nothing here writes. |
| `NEXUS_STATEMENT_WINDOW` | no | `day` \| `week` \| `month` \| `all`. Defaults to `day`. Same as `--window`. |
| `NEXUS_MARKET` | no | Restrict to one market. Same as `--market`. |
| `NEXUS_MAX_ROWS` | no | Row cap per paginated surface. Defaults to `1000`. |
| `NEXUS_BUDGET_UTILISATION` | no | Fraction of the read budget to spend. Defaults to `0.8`. |

Setting one credential without the other is refused — half a pair is always a
mistake, and the failure it produces otherwise is an opaque `401`.

## Money is the whole point

A statement that silently loses precision is worse than no statement, so this
is the part to read.

**Every monetary value is a lossless decimal string, end to end.** The spec's
`Decimal` type is `{"type": "string"}` and its description is not subtle:
*"Arbitrary-precision decimal serialized as a string (lossless). Parse with a
decimal type, never a float."* Nothing here parses money with `Number()`, and
no money value is ever held in a JS `number`. `src/decimal.ts` is exact
arithmetic on `BigInt`, and the sums the statement prints were computed on
integers.

That is not theoretical on this API. Live testnet, measured:

```
GET /api/v1/demo/account/summary
  "total_equity": "5.732096339790068249192319744"      ← 27 fraction digits
GET /api/v1/demo/positions
  "roe":          "0.0052172958268259022023669768"     ← 28
  "funding_paid": "-0"                                  ← negative zero
```

A `double` holds about 15–17 significant decimal digits. Reading
`total_equity` with `Number()` throws away the last twelve of them, and does
it silently. `"-0"` is a second, smaller trap: `Number("-0")` is negative zero,
which compares equal to zero and then formats as `-0` in some places and `0` in
others. This parser drops the sign on zero, because a zero has no sign.

Rounding happens **only** in the renderer, on the way to a column, and never
on the way into a sum — `--exact` prints the unrounded strings so the two can
be compared.

### Two fields whose wire type disagrees with the spec

**Checked on every run, not asserted once here.** `src/statement.ts` records
how each monetary field *actually* arrived and prints any that disagreed, so
this section cannot go quietly stale.

1. **`PortfolioPoint.equity`, `.pnl` and `.volume` arrive as JSON numbers.**
   The spec types all three as `$ref: Decimal` — strings — and the schema
   description even contrasts itself with `EquityPoint` on exactly this point.
   The indexer declares `PortfolioPoint { equity: f64, pnl: f64, volume: f64 }`
   under a plain `#[derive(Serialize)]`, which emits numbers. This is
   **ENG-8439**: it broke the generated Rust SDK outright, was fixed SDK-side
   in `nexus-exchange-rs#152` by accepting both shapes, and the server half is
   still open and belongs to the indexer pod. This app takes the same position
   — accept both — and additionally *reports* it: a value that arrived as a
   number is parsed from the double's shortest round-tripping text, tagged, and
   every total it feeds is called approximate rather than exact. It is not
   silently promoted to "lossless", because the low digits are gone before they
   reached us and nothing on this side can recover them.

2. **`EquityPoint.equity` is a JSON number, and that one is correct.** The spec
   says so explicitly. It is listed here only so a reader does not "fix" it:
   this is the documented shape, unlike (1).

Everything else this app reads — `Fill.price/size/fee`,
`AccountFunding.amount/funding_rate/position_size`,
`ClosedPosition.realized_pnl/size/entry_price/exit_price`,
`AccountFees.volume_30d` — is a decimal string on the wire, as specified. The
per-run report will say so by staying silent.

### Funding: which sign means what

**`/funding` publishes `amount` signed: negative when the account paid,
positive when it received.** `direction` (`"paid"` / `"received"`) states the
same fact in words. This app sums the **signed `amount`** — so the net figure
is a plain sum — and reports paid and received separately by sign class.

It also **cross-checks every row**: if a row's `direction` contradicts the sign
of its `amount`, that row is counted and the disagreement is printed rather
than being averaged away. The two are redundant statements of one fact, and a
statement that reads only one of them cannot tell you when they part company.

The trap this is guarding against is the obvious one: summing `amount` with no
regard for its sign — or, worse, summing `Math.abs(amount)` and using
`direction` only as a label — reports payments and receipts as the same
quantity, and produces a funding bill that is monotonically negative-looking
and wrong.

## The reconciliation is the point

The fills-derived number and the venue's own equity curve **will not match**,
and a tool that made them match would be lying to you. The spec defines the
published series precisely enough to say what the gap is *made of*, which is
far more useful than a gap of zero:

```
PortfolioPoint.pnl  =  Σ realized PnL on close (incl. liquidation, ADL)
                    +  Σ funding (signed)
                    +  current unrealized PnL
```

so over a window,

```
residual  =  Δpnl  −  (Σ realized in window  +  Σ funding in window)
```

which the identity says *should* be the change in unrealized P&L — a quantity
no history endpoint publishes as a series, so it is inferred, not checked. The
statement prints the residual and then enumerates, **for that particular run**,
everything that can be inside it:

- the change in unrealized P&L (the expected term);
- **whether `ClosedPosition.realized_pnl` is gross or net of fees — the spec
  does not say.** So this statement does *not* subtract fees from realized
  P&L: if they are already net, subtracting again double-counts. The fee total
  is printed as the size of the error that ambiguity can account for. Flagged
  rather than guessed;
- edge effects at the two ends, because the published series is downsampled and
  its endpoints are instants;
- a truncated walk, if a row cap was hit;
- funding rows the endpoint could not reach (see below);
- rows whose `direction` and sign disagreed;
- float rounding at the server, for the fields in (1) above.

The equity curve is reconciled against a *different* identity, because `pnl` is
deposit-neutral by construction and `equity` is not:

```
Δequity − Δpnl  =  net wallet flow  ±  definitional differences
```

A large number there is usually a deposit, not a bug, and it is labelled as
such rather than folded into performance.

When `/account/portfolio-history` returns fewer than two points, **no
reconciliation is attempted at all**. A delta needs two samples, and inventing
a baseline from one point — or from zero — manufactures exactly the agreement
this whole section exists to avoid.

## Traps this example is built around

**`window` clamps the point count server-side.** `window` selects the
downsample cadence *and* the capacity: `day` 5 min/288, `week` 1 h/168, `month`
6 h/120, `all` 1 d/366. Asking `limit: 366` on a `day` window quietly returns
at most 288 — "a larger value is clamped, not rejected". So this app asks for
the capacity the table gives and then **believes the response, not the
request**: the statement's period is taken from the first and last timestamps
of the series that came back, and everything else is filtered to that range.
A report that assumed it got what it asked for mis-ranges its own axis and
silently shortens its period.

**A cursor walk ends on the absence of `X-Next-Cursor`, never on a short
page.** The header's own documentation is explicit that these are different
questions: *"a page can be shorter than `limit` and still carry a cursor, and a
page that exactly fills `limit` with nothing beyond it carries none."* Stopping
on a short page truncates a statement, and does it worst on the accounts with
the most history — which is to say, the ones a statement is for.

**Four surfaces cost 5 weight each.** `limit` is weight per second, not
requests per second. `/fills`, `/orders/history`, `/account/portfolio-history`
and `/account/summary` are all weight 5 (`x-nexus-rate-limit-weight: 5` in the
spec); `/funding`, `/positions/closed` and `/account/fees` are 1. A `Pro` key
at `limit: 20` gets four `/fills` pages a second, not twenty. This app paces on
**weight**, and it reads its ceiling from `GET /account/rate-limit` — the one
call that consumes no tokens — rather than hardcoding a number from the tier
table, which the spec says is per-deployment configuration.

> Measured while writing this: **the `x-ratelimit-*` headers ride a `401` as
> well as a `2xx`.** An unsigned `GET /api/v1/account/rate-limit` on the
> testnet base answers `401 UNAUTHORIZED` and still carries
> `x-ratelimit-limit: 50` / `x-ratelimit-remaining: 49`. So a caller with bad
> credentials still learns the ceiling it is being metered at, and this app
> keeps that rather than falling back to its slow assumed rate. What it does
> *not* do is call that discovery: the tier name is unknown in that case and is
> printed as such.

**An absent `fee` is not a fee of zero.** `"0"` means the venue charged nothing
— a liquidation fill is exempt on both legs — while an absent key means it said
nothing at all: a fill predating per-fill fee emission, or a leg the engine did
not stamp. Those fills are counted separately and the fee total is called a
floor. Summing an absent fee as zero puts a number the venue never asserted
into a total presented as complete.

**A negative fee is a rebate, not a parse error.** Both in `Fill.fee` and in
`AccountFees.maker_fee_bps`.

**`/funding` is a bounded window, not the account's whole history.** It is
served from an in-memory tier that never queries the durable store, so rows
older than that tier's floor exist and are not returned. Two headers say how
far it reached — `x-nexus-funding-oldest-ms` and `x-nexus-funding-truncated` —
and both are **additive and newer than the `v0.8.1` tag this example pins**, so
a deployment serving that contract sends neither. Absence means *unknown*: not
`false`, and never `0`, which would claim funding history back to the epoch.
When the app cannot establish the depth it says so in the notes rather than
presenting a short answer as a complete one.

**`/account/fees` is a schedule, not a realized average.** It reports the
forward-looking rate the venue will charge; the realized number is the fee
column, which comes from the fills. `volume_30d_estimated: true` means the
30-day volume may undercount because the fill buffer was at capacity, and that
flag is surfaced rather than dropped.

## About the host

**The base is `https://api.testnet.nexus.xyz/indexer`, and the `/indexer` is
part of it.** It is a route prefix the deployment mounts the service under, not
part of the API contract, and the bare host answers `404` on every path. Copy
the base whole rather than trimming it to the hostname.

**Not `https://exchange.nexus.xyz/api/exchange`.** That gateway is what every
Nexus SDK shipped as its default until September 2026, and it now proxies to a
decommissioned indexer: every route answers `500` (ENG-14039). If you are
reading an older example, a pinned older SDK, or a cached copy of the docs,
that is the base you will find, and it does not work.

**Mainnet is not a target.** `api.nexus.xyz` is refused by name, before any
request is made — deliberately by name rather than by reachability, since the
host has no DNS record today and an unnamed refusal would look like a network
fault rather than a decision.

**You sign the path the *indexer* sees, not the path in your URL.** The
deployment strips its own `/indexer` prefix before the request reaches the
service that verifies your signature, so a request sent to
`…/indexer/api/v1/fills` is verified as `/api/v1/fills`. Sign the URL's full
path instead and you get a `401` that looks exactly like a bad secret. Same
lesson [`trading-terminal`](../../exchange-api/trading-terminal) carries,
against the same prefix.

**A `503` is not a wrong base URL.** The host answered `503 no healthy
upstream` for a stretch while this was being written. That proves routing works
and the upstream is down; a wrong prefix answers `404`. The client retries a
`503` and says which of the two it saw.

## How it works

Eleven small files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`decimal.ts`](./src/decimal.ts) | Exact money arithmetic on `BigInt`, and `fromWire` — the string-or-number parser and its fidelity tag. |
| [`wire.ts`](./src/wire.ts) | What the venue actually sends: every parser, and every decision about a field that is missing, negative, or the wrong JSON type. |
| [`statement.ts`](./src/statement.ts) | Reading the five surfaces, deciding the period, and folding the rows into one line per market. |
| [`reconcile.ts`](./src/reconcile.ts) | The identity, the residual, and the list of what the residual is made of. |
| [`budget.ts`](./src/budget.ts) | Weight-based pacing, and reading the ceiling from the venue instead of a table. |
| [`rest.ts`](./src/rest.ts) | One hardened signed `GET`, and the cursor walk. |
| [`signing.ts`](./src/signing.ts) | The HMAC-SHA256 canonical string, and the three traps that each produce an identical `401`. |
| [`config.ts`](./src/config.ts) | Environment parsing, host guards, and the window capacity table. |
| [`render.ts`](./src/render.ts) | Columns, and never letting a rounded figure be the only figure. |
| [`async.ts`](./src/async.ts) | `sleep`, abort plumbing, one-line error text. |
| [`index.ts`](./src/index.ts) | Wiring and lifecycle. |

`decimal.ts`, `signing.ts` and `async.ts` are **copied** from the sibling
examples rather than imported, per
[CONTRIBUTING.md § 1](../../CONTRIBUTING.md): a reader should be able to
download this one directory and have it work. `decimal.ts` differs from
`order-loader`'s copy in two ways, both deliberate and both explained in its
header — it does not cap fraction digits at 12 (the venue emits 28), and it
accepts a JSON number where the spec promised a string.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **The authenticated path was never exercised against a live account**,
  because the author had no testnet credentials to hand. Being precise about
  what that does and does not leave verified:
  - Against the live `api.testnet.nexus.xyz` deployment: the base-URL and
    mainnet guards, the window validation, the no-credentials refusal, budget
    discovery via `GET /api/v1/account/rate-limit` (including the
    `401`-carries-headers finding above), the signed-request path as far as
    the venue's `401`, and the wire shapes quoted in "Money is the whole
    point", which came from the unauthenticated `/demo/*` mirror.
  - Against a **loopback venue** that verifies the HMAC and replays
    spec-shaped bodies: the whole app, end to end — signing, the cursor walk
    across multiple pages, every parser, the funding sign cross-check, the
    absent-`fee` path, the `PortfolioPoint`-as-JSON-numbers path, the
    reconciliation arithmetic, and the no-reconciliation-from-one-point
    refusal. That mock is a development tool and is not committed; it proves
    the code is self-consistent against the contract, not that the contract
    matches the venue.
  - Not verified at all: that a real account's `/fills`, `/funding`,
    `/positions/closed` and `/account/portfolio-history` reconcile to a
    residual of the size this README describes. That needs credentials.
- The `/demo/*` mirror **cannot** stand in for that. On the deployment measured,
  `/demo/account/portfolio-history`, `/demo/fills`, `/demo/positions/closed`
  and `/demo/account/equity-history` all return empty, while `/demo/account`
  and `/demo/account/summary` serve live data — so the demo account's
  time-series buffers are simply not being filled. That is also why the
  `PortfolioPoint` type divergence went unnoticed outside the API Quality lane.
- The sample output above is illustrative, not a transcript.
- Not implemented, and out of scope: CSV or HTML output (see
  [`market-report`](../market-report) for that shape), tax-lot accounting,
  cost-basis methods other than the venue's own, per-fill realized P&L
  attribution (the venue does not emit it), and any persistence between runs.
- `GET /account/equity-history` is deliberately **not** used. It is a ~1 hour,
  5-second-cadence series of equity only, and the spec says both endpoints
  derive equity from the same source — so it would add a fourth window without
  adding a fact, and its `equity` is a JSON number by design where
  `portfolio-history`'s is meant to be a string.
