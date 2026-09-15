# funding-carry

Ranks the venue's markets by **what a held position would earn or pay in
funding, weighted by how stable that rate has been**, alongside the margin the
position would tie up. Built directly on the Exchange API — raw REST, no SDK.

`analytics/market-report` answers *"what happened"*. This answers a
decision-shaped question: **where is the carry, and how noisy is it.** A mean
funding rate with no dispersion beside it is the misleading answer here —
carry that averages well and swings wildly is not the same trade as steady
carry, and a ranking that hides that is worse than no ranking.

**It needs no credentials.** Every surface it reads is public market data, so
it runs on a clean clone with an empty environment. It is also **read-only**:
there is no order path, no cancel path, and no `--submit` to forget. Every
request it makes is a `GET`.

## What it does

```
05:32:13  Nexus Exchange funding carry — https://api.testnet.nexus.xyz/indexer (play funds)
05:32:13  no credentials required; every surface read here is public
05:32:13  read budget not yet reported; pacing at an assumed 4/s until a response says otherwise
05:32:13  reading market list from /tickers and /markets/summary
05:32:14  read budget 50/s (from response headers), using 40.0/s
05:32:14  reading BTC-USDX-PERP: funding, funding-samples, risk-params
...

Funding carry — https://api.testnet.nexus.xyz/indexer (play funds)
look-back: 168h, 2026-09-03 05:00:00Z → 2026-09-10 05:00:00Z
  anchored on the newest settled window in the data, not the local clock
  (which is 0.54h ahead of it); the deployment reported x-indexer-lag-ms
  17429255 (4.84h)

Conventions
  settlement interval   1h (derived: modal gap between settled windows)
  annualisation         simple: annual = mean per-window rate × periods/year (= 8760 here)
  dispersion            sample stdev (n−1) of the per-window rate, annualised by √(periods/year)
  variance window       the 168h look-back above; minimum 30 settled windows to be ranked
  sign                  positive rate → longs pay, shorts receive
  ranked by             |annualised carry ÷ annualised dispersion|, largest first

Ranked markets (4)
market               carry /yr      disp /yr    carry/disp     on margin     n  receives
ETH-USDX-PERP         -420.94%         4.59%        -91.69     -21047.2%   167      long
BTC-USDX-PERP          185.86%         3.45%         53.85       9293.0%   167     short
SOL-USDX-PERP           10.95%         0.00%          flat        219.0%   168     short
NDQ-USDX-PERP            0.00%         0.00%          flat          0.0%   168      flat

ETH-USDX-PERP
  per-window rate  mean -0.00048053  stdev 0.00049050  min -0.00100000  max 0.00001250
  sample           n = 167 settled windows over 167h, interval 1h (1 of 166 gaps differed; range 1h–2h)
  dispersion error ±5.5% on the stdev at n = 167 (normal-theory 1/√(2(n−1)))
  repeated values  75 window(s) at the minimum -0.00100000, 79 at the maximum 0.00001250, of 167
  margin           initial 2.00% of notional, max leverage 50×
  premium samples  233 intra-window observations from /funding-samples — counted, NOT part of the statistics above
...

Rate against premium (counted, never averaged away)
  356 of 670 window(s) settled at a non-zero rate on a zero premium
  0 window(s) had a non-zero premium and settled at exactly zero
  1 window(s) had a rate and a premium of OPPOSITE sign
  297 window(s) settled with mark_price "0" — no price context at all

Market discovery disagreed
  NDQ-USDX-PERP   listed by tickers only
```

That transcript is real, from a run against `api.testnet.nexus.xyz` on
2026-09-10. Explanatory prose under each block is elided here for width — the
tool prints it.

## Prerequisites

- **Node 22.4 or later.** It uses `process.loadEnvFile` (Node 22), and there is
  nothing to install at runtime: **zero runtime dependencies**, just `fetch`
  from the Node standard library. Developed on Node 26.3; CI builds on 22.
- **No credentials.** Nothing to create, nothing to configure.

## Pinned versions

There is no SDK to pin, so what this example pins is **the API contract
itself: spec `v0.9.47`**, sent on every request as
`X-Nexus-Api-Version: v0.9.47`. It targets **testnet** — play funds, with no
real-world value. It will not run against mainnet: the mainnet host is refused
by name in `config.ts`, before any request is made.

The toolchain is pinned exactly (no `^`): `typescript` `7.0.2`, `tsx` `4.23.8`,
`@types/node` `26.1.2`. `package-lock.json` is committed and CI installs from
it with `npm ci`.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

That is the whole thing — no `.env`, no key. Add `--window-hours 24` for a
shorter look-back, `--min-samples 50` to demand a larger sample, `--by carry`
or `--by margin` to sort on something other than the risk-adjusted figure,
`--market BTC-USDX-PERP` to narrow it to one, and `--exact` to print the
full-scale value behind every figure.

## Configuration

Every variable is optional. See [`.env.example`](./.env.example).

| Variable | What it's for |
| --- | --- |
| `NEXUS_EXCHANGE_API_URL` | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Must **not** include `/api/v1`. |
| `NEXUS_EXCHANGE_FUNDS` | `play` \| `real` \| `unknown`. Reported in the header; gates nothing, because nothing here writes. |
| `NEXUS_CARRY_WINDOW_HOURS` | Look-back in hours. Defaults to `168`. Same as `--window-hours`. |
| `NEXUS_CARRY_MIN_SAMPLES` | Sample floor for ranking. Defaults to `30`. Same as `--min-samples`. |
| `NEXUS_CARRY_SORT` | `ratio` \| `carry` \| `margin`. Defaults to `ratio`. Same as `--by`. |
| `NEXUS_MARKET` | Restrict to one market. Same as `--market`. |
| `NEXUS_BUDGET_UTILISATION` | Fraction of the read budget to spend. Defaults to `0.8`. |

## The conventions, and the arithmetic behind them

"Carry and its variance" is a quantitative claim, and a quantitative claim with
an unstated convention is not an answer — it is a number that looks like one.
All four conventions are stated here, printed in the tool's own output, and
implemented in one file ([`carry.ts`](./src/carry.ts)).

### 1. The settlement interval is derived, never assumed

**Annualising needs the interval, and 8 hours is folklore.** This app takes the
**modal gap** between consecutive settled windows, and reports how many gaps
disagreed with it.

Measured on the live testnet: the mode is **3,600,000 ms — one hour** — on all
four markets. BTC and ETH each had exactly one 2-hour gap among 166 (a missed
settlement); SOL and NDQ had none.

The mode, not the mean: a single missed settlement drags a mean gap to
3,621,052 ms, an interval no window on this venue has ever had. The mode is the
cadence, the outliers are missed settlements, and they are counted and named
rather than averaged in. If fewer than 60% of gaps agree on one value, the app
**refuses to annualise that market at all** and says why — there is no honest
answer to "how many of these fit in a year" for windows of no particular
length.

The repo's own documents disagree about this, which is the best argument for
deriving it: `eng/apps/exchange/01-architecture.md` says *"every 8 hours (per
market, configurable)"* and `FUNDING-IMPLEMENTATION-MAP.md` says *"hourly
settlement"*. The wire says hourly.

### 2. Annualisation is simple, not compounded

```
periods per year  P  =  365 days / interval          =  8,760  at 1h
annualised carry     =  mean per-window rate  ×  P
```

**Not** `(1 + r̄)^P − 1`. Compounding assumes every payment is immediately
redeployed at the same notional, which a carry *ranking* does not assume and a
reader comparing two markets does not want; it also explodes near the rate cap,
where the compounded figure describes an arithmetic identity rather than a
trade. A **365-day year**, not 365.25 — the 0.07% that choice moves every
figure by is smaller than anything this ranking resolves, but an unstated
convention is exactly the problem, so it is stated.

Worked, from the transcript above: BTC's mean per-window rate was
`0.00021217`, and `0.00021217 × 8760 = 1.8586`, the `185.86%` in the table.

### 3. Dispersion: the sample standard deviation, over a stated window, with a stated floor

```
s²  =  (n·Σr² − (Σr)²) / (n(n−1))          Bessel-corrected, n−1
annualised dispersion  =  s × √P
```

The mean scales **linearly** in the number of periods and the standard
deviation scales as its **square root**. Applying `P` to both is the commonest
way an annualised Sharpe-shaped number comes out wrong, and it comes out wrong
by a factor of `√P` — 94× at hourly settlement, enough to reorder any ranking
completely.

**The √t scaling assumes successive windows are independent, and they are
not.** Funding is autocorrelated: a premium that persists across an hour
settles twice in the same direction. So `√P` *understates* the annualised
dispersion of a persistent premium. It is used because it is the convention a
reader expects, and it is named in the output rather than left to be
reverse-engineered.

**Over what window, and how many samples?** The look-back is `--window-hours`,
default **168h (7 days)** — chosen against what the endpoint actually holds:
`GET /markets/{id}/funding?limit=1000` returned **173–174 settled windows
spanning 7.2 days** on every market, so 7 days is very nearly the whole buffer
and a 30-day request would silently be a 7-day one wearing a different label.
The tool reports the coverage it actually got.

**A market with too few samples is not ranked.** The default floor is **30
settled windows**, and here is the arithmetic rather than the assertion: the
sample standard deviation has a relative standard error of about `1/√(2(n−1))`.

| n | error on the dispersion |
| --- | --- |
| 3 | ±50% |
| 10 | ±24% |
| 30 | ±13% (the default) |
| 168 | ±5.5% (a full 7-day window) |

At n = 3 the dispersion estimate can be out by half — larger than the
differences a ranking would be claiming to resolve — so three points get "not
ranked" with the reason, never a confident-looking number. The tool prints this
error bar per market from that market's own `n`, so the reader sees it rather
than trusting the cutoff. `--min-samples` lowers it and the output says when it
has been lowered.

### 4. The window is anchored on the data, not on the clock

The look-back runs back from the **newest settled window in the response**, not
from `Date.now()`. Two measurements say why: the venue's newest settled window
was 32 minutes old on the run above while the same response carried
`x-indexer-lag-ms: 17429255` — 4.8 hours. The deployment's own staleness signal
and its data disagree, so neither is a safe anchor for a filter that decides
which samples exist. Anchoring on the data makes the window mean "the last N
hours *of settlements*", which is what a carry figure is about, and makes the
answer reproducible from the same response tomorrow.

## The trap this example exists to demonstrate

**The two funding endpoints return different schemas, and the spec says so
explicitly.**

| Endpoint | Schema | What a row is |
| --- | --- | --- |
| `GET /markets/{id}/funding` | `FundingSample` | A **settled window**: the realized rate for the window, plus the premium and prices of the last observation folded into it. |
| `GET /markets/{id}/funding-samples` | `FundingPremiumSample` | One **intra-window premium observation**: timestamp and `premium_index`, and nothing else. |

The spec is emphatic in both directions — *"This is not the shape of
`/markets/{market_id}/funding-samples`"* on the first, and *"The settled
funding rate, mark price and oracle price are properties of a settled window,
not of an intra-window sample"* on the second.

Conflating them is the exact defect this example exists not to make, so it is
guarded rather than merely avoided. [`wire.ts`](./src/wire.ts) has two parsers
that **refuse each other's shapes**: the settled parser rejects a row with no
`funding_rate`, and the premium parser rejects a row that carries one. That
second check is not paranoia about today's server — it is what turns a future
convergence of the two shapes into an error the reader is told about, rather
than a silent doubling of the sample count with observations that were never
rates.

The premium samples are read, parsed and **counted**, and their values never
touch the statistics. They are the current unsettled window's texture; the
carry series is settled windows only.

## Funding: which sign means what

**Positive `funding_rate` → longs pay, shorts receive.** The `receives` column
names the side, and a market whose mean rate is negative is a long-side
opportunity rather than a bad row — which is why the ranking sorts by
**magnitude**, not by signed value.

> **Flagged, not guessed: the spec does not state this.** `FundingSample`
> describes `funding_rate` as the realized rate for the window and says nothing
> about who pays whom, and a text search of `openapi.json` for the convention
> finds nothing. The direction above comes from the **implementation**, in
> several independent places: `engine/primitives/funding-rate/src/lib.rs`
> (*"Sign convention: positive rate → long pays, short receives"*),
> `system/risk-margin`'s property tests (the long's `amount_signed` is
> `-S × r × T`), and `01-architecture.md` (*"Positive rate → longs pay"*). That
> is good evidence and it is not the contract. If you are building on this,
> read it as measured behaviour.

The account-side endpoint states its own convention explicitly and differently:
`/funding`'s `amount` is **signed**, negative when the account paid, and
`direction` says the same thing in words. That is
[`account-statement`](../account-statement)'s problem, not this one's — this
example never reads an account.

### The rate-versus-premium cross-check

The rate is driven by the premium, so the two are redundant statements about
the same window and it is worth knowing when they part company. The tool counts
the three ways they can disagree **separately**, rather than summing them into
one "mismatches" number that would hide the only alarming one:

- **A non-zero rate on a zero premium** — 356 of 670 windows, measured.
  **Expected, not a defect.** It is the baseline interest component: the spec
  says the premium index reads exactly zero until the market has traded,
  because the trade reference falls back to the oracle and the numerator
  vanishes. The value is `0.0000125` per hour, which is the standard
  0.01%-per-8h baseline pro-rated to this venue's 1-hour window (`0.0001 / 8`)
  — and `0.0000125 × 8760 = 10.95%/yr`, the SOL row in the table.
- **A non-zero premium settling at exactly zero** — 0 windows. Would suggest a
  clamp at zero or a dropped sample.
- **A rate and a premium of opposite sign** — **1 window, measured.** The one
  that would actually contradict the model. It changes no number here (the
  settled rate is the settled rate) and it is reported rather than averaged
  away.

## Other things this run measured

**A pile-up at the extremes censors the dispersion.** ETH settled **75 of 167
windows at exactly `-0.001`** and BTC **23 at exactly `+0.001`**, which look
like the engine's `funding_rate_cap`. A dispersion computed over a censored
sample is not the dispersion of the underlying process — the clamp removes
precisely the observations that would have widened it — so a heavily-clamped
market is flattered twice by a carry-per-variability ranking: the numerator
sits at the cap and the denominator has been trimmed. The tool reports the
counts at **both** extremes and deliberately does **not** label either as the
clamp: the outer end is a clamp and the inner end is the baseline, they are
indistinguishable from counts alone, and the field that would separate them
(`funding_rate_cap`) is on a surface this deployment refuses.

**`GET /markets` is declared public and answers `401`.** Its own spec
description says so at length, citing ENG-11484 and the identical `GET /ready`
mismatch before it — and on the deployment measured it answers
`401 UNAUTHORIZED`, which is exactly the fall-through-to-the-authenticated-catch-all
behaviour that description says was fixed. So the richest market-parameters
surface, and the only one carrying `funding_rate_cap`, is unreadable without
credentials. This example discovers markets from `/tickers` and
`/markets/summary` instead, and prints that note on every run.

**The two list surfaces disagree about which markets exist.** `GET /tickers`
returned four ids and `GET /markets/summary` returned three, with
`NDQ-USDX-PERP` in the first only — yet `NDQ-USDX-PERP` serves 174 settled
funding windows and answers `200` on `risk-params`. The app ranks the **union**
and tags each row with where it was found: dropping a market with a week of
funding history and including one the registry does not carry are both wrong,
in opposite directions, and saying which is which is the only honest option.

**`/tickers` is an object keyed by symbol, not an array.** Its keys are all this
app reads from it: every numeric field on a `Ticker` is a JSON `number` by
declaration, and `quoteVolume`'s own description calls it *"a lossy `f64`
conversion"*.

**`limit` is clamped, not rejected.** `GET /markets/{id}/funding?limit=2000`
answers `200`, above the spec's documented maximum of 1000. A client that asked
for more than the maximum and assumed it got it would silently shorten its own
history. This app asks for the documented maximum and believes the response.

**297 windows settled with `mark_price` `"0"`** — no price context at all. They
still carry a real rate and are still in the statistics. Nothing here
multiplies a rate by a price, which is exactly why this ranking lives in rate
space: a missing price costs it context, not a number.

## Precision: what is exact and what is not

A funding rate is not money, but it is the thing this app multiplies by 8,760
and then squares, so a `Number()` on the way in is a `Number()` compounded
8,760 times on the way out. Measured, live: the venue emits funding rates with
**28 fraction digits** —
`"funding_rate":"0.0000125000000000000000000000"` on every one of BTC's 173
windows, `"-0.0000997258147684889606605368"` on ETH. A `double` holds about
15–17 significant decimal digits, so `Number()` throws away the tail silently.

[`decimal.ts`](./src/decimal.ts) is exact arithmetic on `BigInt`, copied from
[`account-statement`](../account-statement) rather than imported
([CONTRIBUTING.md § 1](../../CONTRIBUTING.md)) — that is the right ancestor
because it is the copy whose parser does **not** cap the fraction digits at 12,
which `order-loader`'s does and which would truncate every value above.

**Being precise about what "exact" means here**, because this app does
something `account-statement` does not:

- **Exact**: every parse, `Σr`, and `Σr²`. Pure integer arithmetic on `BigInt`.
- **Not exact**: the mean, the variance, the standard deviation, and every
  ratio. A mean is a division and a standard deviation is a square root, and
  neither terminates in decimal at any finite scale.

So each statistic is arranged as **one** exact numerator over **one** exact
denominator with a **single** rounding at a stated working scale of **30
places** — 30 because the inputs carry 28, and a working scale below that would
round them before the statistics ever saw them. The variance uses the algebraic
identity `s² = (n·Σr² − (Σr)²) / (n(n−1))` rather than the two-pass form: in
floating point that identity is the classic catastrophic-cancellation trap and
the two-pass form is correct, but here the numerator is computed on exact
`BigInt`s with no error at all, and it buys the property that the only rounding
in the whole statistic is the final division. `sqrt` truncates rather than
rounds, deliberately, so the ratio errs toward flattering a noisy market rather
than a quiet one — a direction a reader can check.

The standard deviation used to break that promise, and it is worth naming
because the promise is the selling point. `sqrt(divide(N, D, 30))` is **two**
roundings: the quotient rounds at 30 places and the root then truncates an
already-rounded value. @nvizble measured the drift on [#25][pr25] — 366 ulps at
the 30th digit on a 167-sample array. `decimal.sqrtRatio` now divides inside
the radicand, so the final truncation is the only rounding between the exact
`BigInt` sums and the answer. Checked against an independent integer reference
on a 167-sample array: the one-step value matches `floor(√(N/D)·10³⁰)` exactly
and the old two-step was 8,188 ulps low.

[pr25]: https://github.com/nexus-xyz/nexus-exchange-examples/pull/25

**No value ever passes through a JS `number`**, and rounding happens only in
the renderer, on the way to a column. `--exact` prints the full-scale strings
so the two can be compared — at the working scale, not beyond it. `carry /yr`,
`dispersion /yr` and `periods/year` are exact products of two scale-30 values,
so they are arithmetically exact at scale 60 and informative to about 30; the
digits past 30 describe the rounding rather than the market, and printing them
would be the thing this section says the app does not do.

`fromWire` also accepts a JSON number where the spec promised a string, tags it
`from-json-number`, and the tool reports any field that arrived that way — the
same ENG-8439 divergence `account-statement` documents. **Measured on this
app's read path: no field diverged.** The report says so by staying silent, and
it is re-taken on every run rather than being a note here that goes stale.

## About the host

**The base is `https://api.testnet.nexus.xyz/indexer`, and the `/indexer` is
part of it.** It is a route prefix the deployment mounts the service under, not
part of the API contract, and the bare host answers `404` on every path
(measured: `https://api.testnet.nexus.xyz/api/v1/markets/summary` → `404`; the
same path under `/indexer` → `200`). Copy the base whole rather than trimming
it to the hostname.

**Not `https://exchange.nexus.xyz/api/exchange`.** That gateway is what every
Nexus SDK shipped as its default until September 2026, and it now proxies to a
decommissioned indexer: every route answers `500` (ENG-14039).

**Mainnet is not a target.** `api.nexus.xyz` is refused by name, before any
request is made — deliberately by name rather than by reachability, since the
host has no DNS record today and an unnamed refusal would look like a network
fault rather than a decision.

**A `503` is not a wrong base URL.** The host answered `503 no healthy
upstream` for about two minutes in the middle of writing this, and the app's
first full run degraded into it: every market listed as unranked, with the
reason. That proves routing works and the upstream is down; a wrong prefix
answers `404`. The client retries a `503` and says which of the two it saw.

**Public data is metered.** A public `GET /markets/{id}/funding` carried
`x-ratelimit-limit: 50` and `x-ratelimit-remaining: 49`, so the app starts at a
deliberately slow assumed rate and corrects upward from the first response
rather than hardcoding a number from the tier table — which the spec says is
per-deployment configuration and not part of the contract.

## How it works

Ten small files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`carry.ts`](./src/carry.ts) | The interval derivation, the statistics, the annualisation, the sample floor, and the ranking. Every convention lives here. |
| [`wire.ts`](./src/wire.ts) | What the venue actually sends: the two funding parsers that refuse each other's shapes, the sign cross-check, and the two-list discovery merge. |
| [`collect.ts`](./src/collect.ts) | Reading the four public surfaces, per-market failure handling, and the look-back anchor. |
| [`decimal.ts`](./src/decimal.ts) | Exact arithmetic on `BigInt`, plus the two operations that are not exact and say so. |
| [`render.ts`](./src/render.ts) | Columns, the printed conventions, and never letting a rounded figure be the only figure. |
| [`config.ts`](./src/config.ts) | Environment parsing and the host guards. |
| [`rest.ts`](./src/rest.ts) | One hardened unauthenticated `GET`. |
| [`budget.ts`](./src/budget.ts) | Pacing, and reading the ceiling from response headers instead of a table. |
| [`async.ts`](./src/async.ts) | Bounded concurrency and the abortable sleep, so a slow venue cannot outlive a Ctrl-C. |
| [`index.ts`](./src/index.ts) | Wiring and lifecycle. |

> **The `account-statement` links below resolve once [#22][pr22] merges.** That
> directory is not on `main` yet; this example does not import from it, so the
> merge order does not matter for correctness — the links are provenance, and
> they dangle until then. The `order-loader` citations in the source resolve
> already: [#18][pr18] merged on 2026-09-14.

[pr22]: https://github.com/nexus-xyz/nexus-exchange-examples/pull/22
[pr18]: https://github.com/nexus-xyz/nexus-exchange-examples/pull/18

`decimal.ts`, `async.ts`, `budget.ts`, `config.ts` and `rest.ts` are **copied**
from [`account-statement`](../account-statement) rather than imported, per
[CONTRIBUTING.md § 1](../../CONTRIBUTING.md): a reader should be able to
download this one directory and have it work. The copies are trimmed rather
than duplicated wholesale — `rest.ts` loses the signing and the cursor walk,
`budget.ts` loses the `GET /account/rate-limit` discovery it cannot call, and
`config.ts` loses the credential handling. `decimal.ts` gains `divide` and
`sqrt`, which are marked as the only inexact operations in the file.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **This one was exercised end to end against the live venue**, unlike the
  authenticated examples in this catalog — which is what having no credentials
  buys. Every number and every measurement quoted in this README came from a
  real run against `api.testnet.nexus.xyz` on 2026-09-10, including the `503`
  window, the `401` on `GET /markets`, the `/tickers`-versus-`/markets/summary`
  disagreement, the derived 1-hour interval, and the single opposite-sign
  window.
- **Not verified**: that these carry figures predict anything. This is a
  measurement of settled history over one week on a testnet with almost no
  trading — three of four markets show a premium of exactly zero for most
  windows, which means most of what is ranked here is the baseline interest
  component rather than a real basis. On a venue with real flow the numbers
  would mean considerably more; the arithmetic would be identical.
- **Not verified**: which side of the `funding_rate` sign convention the
  *contract* intends, as opposed to what the engine implements. Flagged above
  rather than presented as settled.
- The `funding_rate_cap` comparison is **not implemented**, because the surface
  that carries it answers `401`. The pile-up counts are the derivable substitute
  and are labelled as such.
- Not implemented, and out of scope: CSV or HTML output (see
  [`market-report`](../market-report) for that shape), any forecast of a future
  rate, basis against spot, autocorrelation-corrected dispersion, and any
  persistence between runs.
