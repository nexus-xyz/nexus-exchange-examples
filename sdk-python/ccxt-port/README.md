# ccxt-port

A market scanner written **twice** — once as the CCXT-shaped code a freqtrade or
hummingbot user already has, once on the native **Python SDK** — running both
against Nexus and reporting, field by field, where the two answers differ.

The Python quant and retail stack speaks CCXT. `nexus_exchange.ccxt_adapter`
exists so that a script written against CCXT can talk to Nexus with almost no
changes, and this example is the shortest path from *"I have a CCXT script"* to
*"it runs on Nexus"*. The side-by-side is what makes it an app rather than a
snippet: it shows what the unified layer costs you, what it does for you, and
where you have to drop down.

```text
$ python3 scan.py --markets BTC-USDX-PERP,SOL-USDX-PERP
ccxt-port on https://api.testnet.nexus.xyz/indexer (from built-in testnet default) — play funds
adapter surface: 9 unified methods implemented, 7 advertised False and not defined (market data only — no balances, orders or positions)
window: 2 market(s) at 5m, 200 candles and 200 trades each, depth within 10 bps of the mid

MARKET (ccxt)               last          chg%    spread_bps   depth_quote         rvol%     taker_buy
────────────────────────────────────────────────────────────────────────────────────────────────────
BTC-USDX-PERP           69063.00          2.25          3.50     424716.82        325.37         0.635
SOL-USDX-PERP              84.17          2.25         12.09        146.45        818.67         0.537

MARKET (native)             last          chg%    spread_bps   depth_quote         rvol%     taker_buy
────────────────────────────────────────────────────────────────────────────────────────────────────
BTC-USDX-PERP           69063.00          2.25          3.50     424716.82        325.37         0.635
SOL-USDX-PERP              84.17          2.25         12.09        146.45        818.67         0.537

MARKET            field                     ccxt (float)            native (decimal)  Δ           verdict
────────────────────────────────────────────────────────────────────────────────────────────────────
BTC-USDX-PERP     last                           69063.0   69063.0000000000000000001  1.000E-19   · rounded
BTC-USDX-PERP     change%                           2.25                        2.25                exact
BTC-USDX-PERP     spread_bps          3.4999927602321623  3.49999276023341007485918…  1.248E-12   · rounded
BTC-USDX-PERP     depth_quote               424716.81744             424716.81744000                exact
BTC-USDX-PERP     rvol%               325.37410932838463  325.374109328384390826209…  2.392E-13   · rounded
BTC-USDX-PERP     taker_buy           0.6349025974025976  0.63490259740259740259740…  1.974E-16   · rounded
BTC-USDX-PERP     tick_size                          0.5                         0.5                exact
SOL-USDX-PERP     last                             84.17      84.1700000000000000001  1.000E-19   · rounded
...

parity: 14 field(s) compared — 6 exact (43%), 8 rounded, 0 differs, 0 absent on both

what the unified layer does not carry
  maintenance_margin_rate
    from CCXT-shaped code: market["info"]["maintenance_margin_rate"], as a string
    BTC-USDX-PERP 0.03   SOL-USDX-PERP 0.03
  liquidation trades
    from CCXT-shaped code: trade["info"]["is_liquidation"], when the venue sends it
    BTC-USDX-PERP 3   SOL-USDX-PERP 5
  exact tick size
    from CCXT-shaped code: market["precision"]["price"] as a float, or market["info"]["tick_size"] as the string the venue sent

data notes
  every market  ccxt   · dropped 1 candle(s) with a non-positive timestamp
  every market  ccxt   · dropped the newest candle: still forming
```

Notice the two scan tables are identical and the parity table is not. That is the
honest summary of the whole thing: at any precision you would print, the unified
layer gives you the same answer. The difference only exists where you go looking
for it — and whether it matters depends entirely on what you do next with the
number.

## Read this first: it is market data only

**The adapter implements the public market-data surface and nothing else.** There
are no balances, no positions, no orders. That is not an omission in this
example; it is where `nexus_exchange.ccxt_adapter` is today, and the private
surface is a deliberate follow-up in the SDK.

| CCXT method | Python | Covered? |
| --- | --- | --- |
| `describe` | `describe()` | ✅ yes |
| `loadMarkets` | `load_markets()` | ✅ yes |
| `fetchMarkets` | `fetch_markets()` | ✅ yes |
| `fetchTicker` | `fetch_ticker()` | ✅ yes |
| `fetchTickers` | `fetch_tickers()` | ✅ yes |
| `fetchOrderBook` | `fetch_order_book()` | ✅ yes |
| `fetchOHLCV` | `fetch_ohlcv()` | ✅ yes |
| `fetchTrades` | `fetch_trades()` | ✅ yes |
| `fetchBalance` | — | ❌ **not implemented** |
| `fetchPositions` | — | ❌ **not implemented** |
| `createOrder` | — | ❌ **not implemented** |
| `cancelOrder` | — | ❌ **not implemented** |
| `fetchMyTrades` | — | ❌ **not implemented** |
| `fetchOrders` | — | ❌ **not implemented** |
| `fetchOpenOrders` | — | ❌ **not implemented** |

The "not implemented" rows are **absent attributes**, not methods that raise a
helpful error. `ex.create_order(...)` is an `AttributeError`, and so is
`ex.fetch_balance()`. `describe()["has"]` reports each of them as `False`, which
is the check to write if you are porting code that branches on capability.

`python3 scan.py --surface` prints that table from the live object rather than
from this file, so a version bump cannot make it quietly untrue — and it prints
the second table you actually need:

```text
CCXT attributes this facade does not define — use the right-hand form:
  ex.has                → ex.describe()["has"]
  ex.id                 → ex.describe()["id"]
  ex.timeframes         → ex.describe()["timeframes"]
  ex.urls               → ex.describe()["urls"]
  ex.market(symbol)     → ex.load_markets()[symbol]
  ex.milliseconds()     → time.time() * 1000, or the standard library
  ex.iso8601(ms)        → datetime.fromtimestamp(ms / 1000, timezone.utc)
```

### It is not a `ccxt.Exchange`

**The adapter follows CCXT's conventions without importing `ccxt` and without
subclassing `ccxt.Exchange`.** This is the single most important sentence in this
README, because everything else reads like a drop-in replacement and this part is
not.

What that means in practice:

- `isinstance(ex, ccxt.Exchange)` is `False`. Anything that dispatches on the
  base class — a framework's exchange registry, a factory keyed on `ccxt.exchanges`,
  a type annotation — will not pick this up.
- `ex.has["fetchOHLCV"]`, the standard CCXT capability check, **raises**. The
  flags exist only inside `describe()["has"]`.
- None of CCXT's helper methods are here: no `milliseconds()`, no `iso8601()`,
  no `market()`, no `price_to_precision()`, no built-in rate limiter, no
  `enableRateLimit`.
- The *return values* are plain `dict` and `list` in CCXT's shapes, so the code
  that consumes a ticker or a book does port unchanged. It is the code that
  consumes the *exchange object* that does not.

The upside is that the SDK takes no `ccxt` dependency, so this works in a project
that has never installed it. Whether a true `ccxt.Exchange` subclass ships later
is an open product decision.

## What it does

Per market, over a window you choose:

| Figure | What it is |
| --- | --- |
| `last` | Last traded price, from the ticker. |
| `chg%` | 24h change, from the ticker's `percentage`. |
| `spread_bps` | Top-of-book spread in basis points of the mid, from the order book. |
| `depth_quote` | Quote-notional resting within `--depth-bps` of the mid, both sides. |
| `rvol%` | Annualised realized volatility from candle closes. |
| `taker_buy` | Share of recent trade base volume on the buy side. |

Then the **parity report**: every one of those, plus the tick size, compared
between the two implementations and classified.

| Verdict | Meaning |
| --- | --- |
| `exact` | `Decimal(str(ccxt_value)) == native_value`. The unified `float` names the native value with every digit intact. |
| `rounded` | Same source value, digits the `float` had no room for — either the venue sent more than an `f64` holds, or a division and a square root accumulated binary error. The delta is printed. |
| `differs` | Beyond what rounding explains, or one path produced a figure and the other did not. **This is the one worth alerting on.** |
| `absent` | Neither path produced a figure. Counted separately so it cannot pad the agreement rate. |

And **what the unified layer does not carry** — the three things the native
client has that no unified structure has a field for, each with the escape hatch
that reaches it anyway.

### Statistical conventions

Stated because every part of them is a choice, not a fact:

- **Realized volatility** is the sample standard deviation (n−1) of
  close-to-close **simple** returns over adjacent buckets, with no mean
  adjustment, scaled by the square root of the number of buckets in a **365-day**
  year. The same convention [`analytics/market-report`](../../analytics/market-report)
  uses, so the two are comparable. Fewer than two usable returns produces no
  figure rather than a small one.
- **Spread** is `(ask − bid) / mid × 10,000`, with the mid as the arithmetic mean
  of the two.
- **Depth** is the sum of `price × amount` over levels within `--depth-bps` of
  the mid. It is a snapshot of one book, not a time-weighted figure.
- The **newest candle is always dropped** — it is still being written, so its
  close and volume are partial — and so is any candle with a non-positive
  timestamp. Both paths drop exactly the same candles, deliberately: if they
  did not, the parity report would be measuring this app's opinions rather than
  the two APIs.

## Prerequisites

- **Python 3.12 or later.** The SDK requires 3.10+; CI installs and typechecks
  against 3.12, and this was developed on 3.14.
- **No credentials.** Every method the adapter implements is public market data,
  and this example does not ask for an API key. There is no `.env` and no
  `.env.example`, because there is nothing to put in one.

## Pinned versions

Pinned to **`nexus-exchange` 0.4.0** (the Python SDK), which is the release that
introduced `nexus_exchange.ccxt_adapter`. `mypy` is pinned at `2.3.1`.

There is no lockfile format to commit here, so `requirements.txt` is one: the
SDK's transitive tree is pinned by `==` too, at the versions this example was
verified against, resolved for **Python 3.12** — the version CI installs — rather
than for whatever interpreter happened to be local.

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python3 scan.py
```

That is the whole command. Some things worth trying:

```bash
python3 scan.py --surface                       # what the adapter implements, and what it does not
python3 scan.py --via ccxt                      # only the CCXT-shaped half
python3 scan.py --timeframe 1h --candles 500    # a longer window
python3 scan.py --markets BTC-USDX-PERP
python3 scan.py --strict                        # non-zero if the two paths genuinely disagree
```

### Tests

```bash
python3 -m unittest -q      # 73 tests, no network and no credentials
```

Most of them run the **real adapter and the real SDK against a real HTTP server
on the loopback interface** rather than against a mock. A mock of an SDK only
proves the mock matches the test author's idea of it; a socket proves the adapter
composes the URL, decodes the body and flattens the fields the way this example
says it does. Every behavioural claim below is pinned by one of them, so a
version bump that changes the adapter fails the gate instead of quietly making
this README wrong.

CI runs them: the Python recipe ends with `unittest discover`.

## Configuration

Flags, with one environment variable.

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_URL` | no | Deployment base. Overrides the built-in testnet default. Pass the deployment base — the SDK appends `/api/v1` itself, so a URL ending in `/api/v1` is refused rather than turned into a 404. A blank value falls back to the default. |

| Flag | Default | What it does |
| --- | --- | --- |
| `--via` | `both` | `both`, `ccxt` or `native`. `both` is what prints the parity report. |
| `--markets IDS` | every market | Comma-separated market ids. An unknown id is refused with the real list. |
| `--timeframe` | `5m` | `1s`, `1m`, `5m` or `1h`. That is the whole set — see below. |
| `--candles N` | `200` | Candles requested per market, 1–1000. |
| `--trades N` | `200` | Recent trades requested per market, 1–1000. |
| `--depth-bps BPS` | `10` | How far from the mid to sum depth. |
| `--tolerance REL` | `1e-12` | Relative difference still counted as rounding rather than a real disagreement. |
| `--base-url URL` | — | Same as `NEXUS_EXCHANGE_API_URL`, and takes precedence over it. |
| `--surface` | off | Print the capability tables and exit. |
| `--strict` | off | Exit non-zero if any field is `differs`. For running this on a schedule. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The scan ran. |
| 1 | A bad flag, an unknown market, or an unusable base URL. |
| 2 | The venue could not be read at all. |
| 3 | It answered, and no market produced a comparable figure. |
| 4 | `--strict`, and at least one field differed by more than rounding explains. |

`argparse` exits 2 on a bad flag by default, which would collide with "the venue
could not be read"; the parser is subclassed to exit 1 instead, so a caller
switching on the code cannot read a typo as an outage. Same reasoning, and the
same subclass, as [`analytics/market-report`](../../analytics/market-report).

## Which deployment it talks to

**Testnet — play funds.** The base is
`https://api.testnet.nexus.xyz/indexer`, named explicitly in
[`target.py`](./target.py) rather than left to a default, so nobody has to guess
whose money this reads. It reads only public market data and has no write path at
all, so there is nothing here that could move anything even if it were pointed
somewhere else.

**It does not use `Network.TESTNET`, and that is deliberate.** The SDK's testnet
descriptor resolves to `https://exchange.nexus.xyz/api/exchange`, a gateway that
is **decommissioned**: measured on 2026-09-18, every route under it answers `500`
with an HTML error page — `/markets`, `/api/v1/tickers` and `health_check` alike.
An example built on it would not run. The rest of this catalog moved to the same
durable base for the same reason
([`exchange-api/trading-terminal`](../../exchange-api/trading-terminal),
ENG-14959; [`analytics/market-report`](../../analytics/market-report)).

The `/indexer` prefix is part of the base, not decoration: the whole API — the
`/api/v1` surface and the host-root `/markets` route alike — is mounted under it,
and `https://api.testnet.nexus.xyz/api/v1/...` is a 404.

`NEXUS_EXCHANGE_API_URL` points it at another deployment. An overridden target
reports `funds=unknown` and the banner says so, because a bare URL declares
nothing about whose money is behind it. That matters more here than in the
sibling examples, for a reason worth its own paragraph:

> **The adapter hides its target.** `NexusExchange` keeps no public reference to
> its `Client` — its only public attributes are `markets` and `symbols` — so
> there is no `ex.urls["api"]` to print and no way to ask it afterwards what it
> connected to. Passing `base_url=` on its own would route correctly and then
> report the wrong thing about it, and it is the deprecated selector (ENG-10955)
> besides. So [`target.py`](./target.py) builds a described target with
> `NetworkConfig.custom(label=..., funds=..., base_url=...)` and the app states
> it in its own first line. There is nowhere else that information can come from.

## How it works

| File | What it owns |
| --- | --- |
| [`scan.py`](./scan.py) | Flags, orchestration, the banner, exit codes. |
| [`ccxt_path.py`](./ccxt_path.py) | **The half you are meant to recognise.** The scan in CCXT-shaped code — unified dicts, positional levels and rows, floats. |
| [`native_path.py`](./native_path.py) | The same scan on the typed client — named fields, `Decimal`. |
| [`parity.py`](./parity.py) | Lining the two up, and classifying each pair. |
| [`surface.py`](./surface.py) | The covered / not-covered tables, read off the live object. |
| [`render.py`](./render.py) | The terminal report. |
| [`test_ccxt_port.py`](./test_ccxt_port.py) | 73 tests, offline. |

Both halves share **one `Client`** — `NexusExchange(client=...)` borrows a
transport rather than opening its own — and make exactly the same number of
requests. If they did not, a difference between their answers could be a
difference between two connections rather than a difference between the two APIs,
which is the only thing this app is trying to measure.

### Nine things a CCXT port hits here

Every one of these is measured against the live adapter and pinned by a test, not
inferred from the source.

**1. There is no `1d`, `4h` or `15m`.** The venue serves exactly `1s`, `1m`, `5m`
and `1h`. A freqtrade config asking for daily bars has nowhere to go.

**2. …and on this one the unified layer is the *safer* of the two.** The adapter
validates `timeframe` against its table and raises `ValueError` on anything else.
The native client does **not** — `Client.fetch_ohlcv` forwards the string, and
this venue answers an unsupported timeframe with the **1m series and no
indication it substituted**. Every figure derived from it is then mislabelled
rather than merely noisy. `native_path.check_timeframe` exists to repeat by hand
the check the adapter gives away free.

**3. `since` is filtered after the fetch, not on the wire.** `fetch_ohlcv` and
`fetch_trades` accept `since`, and it never reaches the server: `limit` is sent,
the rows come back, and `since` filters what arrived. So `since=<a week ago>,
limit=200` gives you whatever part of the most recent 200 rows is younger than a
week — which may be all of them, or none. In CCXT `since` usually paginates
*from* a point. Here it truncates.

**4. Trades arrive newest first.** CCXT's convention is ascending by time, so
`trades[-1]` is the *latest* trade in ordinary CCXT code and the **oldest** one
here. It is the server's order passed through unchanged rather than something
the adapter imposes, so it is not safe to rely on either way — sort, or use a
sum that does not care.

**5. `market["precision"]` holds a tick size, not a digit count.** CCXT's
`precision` is a number of decimal places under the default `DECIMAL_PLACES`
precision mode; what is in this field is `0.5`. The adapter advertises no
`precisionMode` either way, so `round(price, market["precision"]["price"])` —
ordinary CCXT code — raises `TypeError` rather than rounding wrongly. Small
mercy: it fails loudly.

**6. `/markets` is the one route not under `/api/v1`.** `fetch_markets` sends
`{base}/markets` while every other call sends `{base}/api/v1/...`. A port that
assumes a uniform prefix 404s on the first call. The SDK documents this in a
comment on its own `fetch_markets`.

**7. `load_markets()` caches forever.** The first call fetches; every later call
returns the same dict, and `reload=True` is the only way to refetch — measured, a
second `load_markets()` makes no request at all. A long-running port that never
reloads keeps trading against a market list from process start.

**8. `side` is lower-cased by the adapter and not by the SDK.** `Trade.from_dict`
keeps whatever string the venue sent (`side=str(d.get("side", ""))`), so a venue
sending `"BUY"` gives the CCXT path `"buy"` and the native path `"BUY"`. A native
port comparing against `"buy"` counts every buy as an unrecognised side — zero
flow, no error. This is a real thing the unified layer does *for* you.

**9. Everything is a `float`.** Which brings us to the actual subject.

### What the unified layer costs, exactly

The adapter coerces every number with a `safe_float` equivalent. The native
client coerces every number with `Decimal(str(value))`. That one difference is
the entire numeric story, and it has two halves that are easy to conflate:

- **A JSON double survives intact.** `Decimal(str(x))` of a double *is* that
  double, so a field the venue sends as a JSON number comes back identical on
  both paths. The live venue really does emit values like
  `391.2000000000003` — a float artefact already baked in on the wire — and both
  paths carry it faithfully. These are the `exact` rows, and they are the
  majority.
- **A decimal string with more digits than an `f64` holds does not.** Where the
  venue sends a *string*, the native path keeps every digit and the unified path
  keeps about seventeen. These are the `rounded` rows with a non-zero Δ.

Which fields arrive as which is a property of the deployment on the day you run
this, not a constant — so the app **measures** rather than asserting, and
`--strict` is there for running it on a schedule and hearing about it when the
answer changes.

Does it matter? For a scanner, no: the scan tables are byte-identical at any
precision you would print. It matters when the number is summed over many rows,
compared against a limit, or used to size an order — which is to say, it matters
in exactly the places the adapter does not yet reach.

### When to drop to the native client

Not when the unified layer is awkward. When it cannot represent the thing:

| What | Where it lives natively | Reachable from CCXT-shaped code? |
| --- | --- | --- |
| `maintenance_margin_rate`, `initial_margin_rate` | `Market` | Only via `market["info"]` — the raw payload. No unified field. |
| `Trade.is_liquidation` | `Trade` | Only via `trade["info"]`. No unified field. |
| Exact `tick_size` / `lot_size` as decimals | `Market` | `market["precision"]` has them as floats; `market["info"]` has the strings. |
| Anything authenticated | `Client` | **No.** Not in this increment. |
| Funding history, mark price, market status, ADL events | `Client` | No unified method exists; CCXT's `fetchFundingRateHistory` is not implemented. |

`market["info"]` and `trade["info"]` are CCXT's own convention for exactly this,
so the escape hatch is idiomatic — but reaching through it is the same as not
being ported, and the app says so next to every value it reports.

## Notes

- Runs against **testnet** (play funds), reads only public market data, and has
  no write path. It is an example, not production-hardened code.
- **The figures in the sample output above are from a local fixture, not from
  live testnet.** On 2026-09-18 the testnet deployment was returning `503 no
  healthy upstream` on `api.testnet.nexus.xyz/indexer` and `500` on the older
  gateway, so a live capture was not possible and the numbers were produced by a
  local server replaying the venue's payload shapes. Everything structural in
  that block is real — the banner is what a default run prints, and the tables,
  verdicts and sections are the program's actual output — but do not read the
  prices as a market snapshot. The adapter behaviour each section demonstrates is
  pinned by the test suite against the real adapter.
- **When the private surface lands, this example grows a second half rather than
  a rewrite.** The scan is read-only by necessity today; nothing in `parity.py`,
  `render.py` or `target.py` assumes that.
- Trading methods are **not stubbed**, on purpose. A stub that raised
  `NotImplementedError` would read as "coming soon" and a stub that no-opped
  would be dangerous; an absent attribute and an honest table is the least
  misleading of the three.
- **No rate limiting.** CCXT's `enableRateLimit` has no equivalent here, and this
  app makes `2 + 3N` requests in a burst and exits, which is small enough not to
  need one. A port of anything that polls will need to bring its own — that is a
  thing CCXT was doing for you that is no longer happening.
- **No WebSocket.** `ccxt.pro`'s `watch*` methods have no counterpart; the SDK's
  own WebSocket surface is separate from the adapter. `describe()["pro"]` is
  `False`.
- **`Decimal` never meets `float`.** The two paths are computed independently and
  only ever compared through `Decimal(str(...))` at the one boundary in
  `parity.classify`. Mixing them anywhere else would make the measurement the
  thing being measured.
- `mypy.ini` sets `follow_untyped_imports`, and it matters more here than in the
  sibling examples: `nexus-exchange` 0.4.0 is fully annotated but ships no
  `py.typed` marker, so under PEP 561 a typechecker ignores all of it. Without
  that line, `mypy .` would type every adapter return as `Any` — and this app is
  *about* those return shapes, so `strict = True` would pass while checking
  nothing.
- **Not verified: the adapter against a venue under load or partial outage.**
  Every degraded case here — an empty book side, a market missing from
  `fetch_tickers`, a crossed book — is exercised against a stub, because the live
  venue was unavailable. The handling reads top to bottom and each case has a
  test; flagged rather than left implicit.
- Not implemented, and out of scope: any write path, funding and mark-price
  series (no unified method), cross-market analysis, persistence, and a real
  `ccxt.Exchange` subclass.
