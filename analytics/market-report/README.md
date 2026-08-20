# market-report

A venue-wide market report for the Nexus Exchange, built on the **read-only
market-data and history endpoints**. It reads candles, funding, per-market 24h
figures and the venue's own event stats, and writes a terminal report, a CSV, and
a self-contained HTML page with inline charts.

It needs **no credentials at all** and has **no third-party dependencies** — the
whole thing is the Python standard library.

The report is the easy half. What the code is mostly doing is refusing to turn a
bad series into a plausible number, because this API will hand you one without
saying so: ask for daily candles and you get minute candles, with no error. Every
check in [`series.py`](./series.py) exists because the live venue does the thing
it checks for, measured rather than imagined.

## What it does

```
$ python3 report.py
Nexus Exchange market report — 2026-08-20 03:14:12Z
──────────────────────────────────────────────────────────────────────────────────────
host          https://exchange.nexus.xyz/api/exchange  (spec v0.8.1, testnet, play funds)
window        24h at 5m = 289 buckets requested
requests      13 fetched, 0 served from cache
venue         health healthy, ingest lag 6 ms, sequence gaps 0
activity      25,177 fills, 49 liquidations, traders 14/24h 20/7d 20/30d
──────────────────────────────────────────────────────────────────────────────────────
MARKET           STATUS   CLOSE        RET%     VOL%ann   HIGH         LOW          BASEVOL      VWAP~        FUND%ann  COV%
BTC-USDX-PERP    active   69063.00     7.57     71.4      70090.00     64079.00     40.137       66711.10     3.18      100
ETH-USDX-PERP    halted   2303.30      20.33    117.0     2303.30      1904.80      2026.990     1965.13      97.07     100
NDQ-USDX-PERP    unknown  —            —        —         —            —            —            —            0.00      0
SOL-USDX-PERP    active   84.17        9.61     99.5      87.23        76.57        40099.900    80.65        4.01      100
──────────────────────────────────────────────────────────────────────────────────────
data quality
  BTC-USDX-PERP
    · forming_bucket_dropped: the bucket starting at 1787195400000 has not closed yet
      and was excluded
  NDQ-USDX-PERP
    · missing_from_summary: listed by /markets but absent from
      /api/v1/markets/summary, so there is no 24h volume, trade count or halt status
    ! no_candles: the venue returned no candles at all at 5m; some markets here have a
      1m series and nothing coarser, so try --timeframe 1m

wrote out/report.csv
wrote out/report.html
```

Per market, over the window you ask for: open/high/low/close, return, annualised
realized volatility, base volume, an approximate VWAP, mean funding annualised at
the interval observed in the data, and what share of the window's buckets
actually came back. Plus the venue itself: health, ingest lag, fills,
liquidations and unique traders.

Everything the run could not stand behind is listed under **data quality** rather
than folded into the numbers. `out/report.html` is one file with no external
requests — inline CSS, inline SVG sparklines — so it opens from a `file://` URL
and survives being emailed to someone.

## Prerequisites

- **Python 3.12 or later.** Nothing to install to *run* it: no third-party
  packages, no SDK. Tested on 3.14; CI typechecks against 3.12.
- **No credentials.** Every endpoint used here is public. There is no `.env`.

`requirements.txt` exists because CI installs from it, and the only thing in it
is `mypy` — see below.

## Pinned versions

There is no client library to pin, so what this example pins is **the API
contract: spec `v0.8.1`**, sent on every request as `X-Nexus-Api-Version:
v0.8.1`, and the toolchain: `mypy` `2.3.1`, exactly, in `requirements.txt`.

**Why no SDK?** The official Python SDK (`nexus-exchange`) is not on PyPI yet —
its own README says *"once published; for now, install from source"* — and
[CONTRIBUTING.md](../../CONTRIBUTING.md) requires `requirements.txt` to be the
whole dependency set with every version pinned by `==`, which a
`git+https://` requirement cannot satisfy. So this example talks to the API
directly, which for a read-only tool costs about eighty lines
([`api.py`](./api.py)). When the SDK ships, that file is what it replaces.

Worth knowing: the version header is **not enforced** on the current deployment.
A bogus value and no header at all behave identically, measured. It is sent
anyway, so a deployment that does start enforcing it gets the answer this code
was written against.

It targets **testnet** — play funds, no real-world value — and reads nothing but
public market data, so there is nothing here that can move anything.

## Setup

None. Clone the directory and run it.

```bash
pip install -r requirements.txt   # only if you want to run mypy yourself
```

## Run

```bash
python3 report.py
```

Some things worth trying:

```bash
python3 report.py --window 7d                      # a wider window, coarser buckets
python3 report.py --window 90m --timeframe 1m      # the finest series there is
python3 report.py --markets BTC-USDX-PERP --format text
python3 report.py --strict                         # non-zero if any series is degraded
```

## Configuration

Flags, not environment variables, with one exception: the API base URL is also
read from `NEXUS_EXCHANGE_API_URL`, so a reader behind different DNS has an
escape hatch.

| Flag | Default | What it does |
| --- | --- | --- |
| `--window DURATION` | `24h` | Window to report over: `90m`, `24h`, `7d`. |
| `--timeframe` | `auto` | Candle interval: `auto`, `1m`, `5m`, `1h`. `auto` picks the finest one whose bucket count fits the server's cap, and prints the arithmetic. |
| `--markets IDS` | every market | Comma-separated market ids. An unknown id is refused with the list of real ones. |
| `--out DIR` | `out` | Where `report.csv` and `report.html` are written. |
| `--format` | `all` | `all`, `text`, `csv` or `html`. |
| `--base-url URL` | the gateway base | Also `NEXUS_EXCHANGE_API_URL`. Must **not** end in `/api/v1`. |
| `--timeout SECONDS` | `20` | Per-request ceiling. |
| `--attempts N` | `3` | Attempts per request. Only transient failures retry. |
| `--cache-ttl SECONDS` | `300` | How long a cached response stays usable. |
| `--no-cache` | off | Always fetch; write nothing to `.cache/`. |
| `--strict` | off | Exit non-zero if any finding is worse than routine — see below. For running this on a schedule, where a silently degraded feed is the thing you want to hear about. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The report was produced. |
| 1 | A bad flag or an unknown market. |
| 2 | The venue could not be read at all. |
| 3 | It answered, and no market produced a usable series. |
| 4 | `--strict`, and at least one series had something wrong with it. |

`argparse` exits 2 on a bad flag by default, which would collide with "the venue
could not be read"; the parser is subclassed to exit 1 instead, so a caller
switching on the code cannot read a typo as an outage.

## How it works

| File | What it owns |
| --- | --- |
| [`report.py`](./report.py) | Flags, timeframe arithmetic, orchestration, exit codes. |
| [`api.py`](./api.py) | One hardened GET: deadlines, retries, pacing, caching, and the refusals below. |
| [`series.py`](./series.py) | **The point of the example.** Turning a payload into a series it is safe to compute on. |
| [`analysis.py`](./analysis.py) | The figures, and reconciling the three routes that disagree about which markets exist. |
| [`render.py`](./render.py) | Terminal table, CSV, and the self-contained HTML. |
| [`test_report.py`](./test_report.py) | 65 tests, offline. |

Five decisions worth copying.

### A candle series is not a time series until you check it

Fetching candles is one GET. Establishing that the rows are the series you asked
for is the work, and on this deployment all of the following are true at once:

- **`timeframe=1d` returns one-minute candles.** Only `1m`, `5m` and `1h` are
  honoured; `15m`, `4h`, `1d`, `1w`, a typo and an empty string all silently
  return the 1m series. Nothing in the response says so. So the parser measures
  the modal gap between timestamps and compares it to what was requested — if
  they disagree, that is *fatal*, because the rows are a real series of some
  other interval and every figure from them would be mislabelled rather than
  merely noisy.
- **The 5m and 1h series each start with a row whose timestamp is `0`.** Plotted,
  it lands in 1970. Averaged, it moves everything. Dropped and counted.
- **Buckets are missing wherever nothing traded**, so consecutive rows are not a
  fixed interval apart. Returns are therefore computed over adjacent pairs only,
  and the skipped pairs are counted — otherwise a return across a three-hour hole
  is reported as an hourly one, which understates the period count and
  mis-scales anything annualised from it.
- **The hourly grid is not anchored to the clock hour, and shifts mid-series.**
  One observed step was 24,692,689 ms, which is not a multiple of an hour. Rows
  that are not a whole number of steps from the first are dropped and counted.
- **The final bucket is still being written.** Its close and volume are partial,
  so including it makes the most recent return and the total volume both wrong,
  in the direction that looks like news.
- **`limit` is silently clamped at 1000.** Asking for 5000 returns 1000 rows and
  no indication the window was cut. So the timeframe is chosen *from* the window
  (`--timeframe auto` picks the finest one that fits) and, when even the coarsest
  cannot reach back far enough, the shortfall is reported rather than absorbed.

Notice what none of these do: raise. They all produce a plausible-looking number
instead, which is why an analytics tool has to look for them on purpose.

### Three routes disagree about which markets exist

`/markets` and `/api/v1/tickers` both list four markets. `/api/v1/markets/summary`
lists three — `NDQ-USDX-PERP` is simply absent from it. Enumerate markets from
the summary route and your report covers three markets and never mentions the
fourth.

So the market list is the **union** of all three, and a market missing from any
one of them is a finding printed next to its row. The same idea applied to values
rather than presence catches a second live oddity: that same market reports a
mark price of `717.5` while its candles trade around `18,466`, a factor of 25,
so any figure mixing the two would be wrong by that much. One comparison,
reported as `price_sources_disagree`.

There is a routing wrinkle here too, and it is not a quirk of one host: **the
market catalog is the one endpoint not under `/api/v1`.** `{gateway}/markets`
works and `{gateway}/api/v1/markets` is a 404, which the Python SDK documents in
a comment on its own `fetch_markets` — *"not migrated to /api/v1 (no
direct-service route yet); stays on the legacy gateway."*

### Money is never a float, and the API is two-faced about numbers

The market-data routes are CCXT-shaped and send prices as JSON **doubles** — the
live venue really does report a 24h change of `391.2000000000003`. The funding
route sends decimal **strings** with 28 significant digits. Same API, two
conventions.

The whole answer is one argument:

```python
json.loads(body, parse_float=Decimal)
```

Every JSON float becomes a `Decimal` carrying exactly the digits the venue sent,
which makes a float impossible to introduce later by accident, because there are
none in the data to begin with. `series.to_decimal` then *rejects* a `float`
outright rather than wrapping it: a float arriving there means something parsed
JSON without that argument, and quietly accepting it would preserve the error
while hiding where it came from.

The one place a float is legitimate is the SVG sparkline, where the numbers are
pixel coordinates rather than money — noted in the code at the point it happens.

Rounding differs by output on purpose: the terminal and HTML views quantize for
reading, and the CSV carries the full `Decimal`. Rounding for display is fine.
Rounding on the way into a file someone will sum is how a report becomes the
source of a discrepancy.

### Every statistic states its convention

Annualised volatility is the sample standard deviation (n−1) of close-to-close
**simple** returns over adjacent buckets, scaled by the square root of the number
of buckets in a **365-day** year, with no mean adjustment. Every one of those is
a choice, not a fact, so it is written down here, in the code, and in the HTML
footer — and the function returns nothing at all, rather than a small number,
when there are fewer than two usable returns.

Funding is annualised at the interval **observed in the timestamps**, not at a
hard-coded 8760. The venue funds hourly today; a report that hard-codes that
keeps quoting carry off by 8× the day it changes, and the interval is right there
in the data.

VWAP is labelled `VWAP~` everywhere it appears because it is approximated from
candle typical prices — candles carry no trade-by-trade prices, so it is the best
available proxy and not the real thing.

### The client refuses more than it parses

[`api.py`](./api.py) is eighty lines because a GET is one of them:

- **The content type is checked before parsing.** Point a client at the host root
  instead of the gateway base and the API answers with the marketing site's HTML.
  Parsing that produces `JSONDecodeError: Expecting value: line 1 column 1`,
  which sends you looking at your JSON handling instead of your URL — so an HTML
  body is diagnosed with the actual cause instead of being quoted at you.
- **Redirects are refused, not followed.** `urllib` follows them by default, and
  `{host root}/markets` really does answer `301` to an off-API host. A report
  should not silently describe a different host than the one printed in its own
  header.
- **A base URL ending in `/api/v1` is rejected at construction**, because the
  paths already carry it and `/api/v1/api/v1/...` 404s like a missing endpoint.
- **Response bodies are read with a byte cap**, and a body over it is refused
  rather than parsed.
- **Only transient failures retry** — 429 and 5xx — with exponential backoff and
  equal jitter. A 400 or a 404 says the same thing however many times you ask.
- **Responses are cached to `.cache/`** with a TTL, because analytics gets re-run
  and iterating on an analysis should not mean re-fetching the same window twenty
  times. Three details in there are the ones that matter. It stores the **raw
  response body**, not the parsed payload: JSON has no decimal type, so
  re-serialising `Decimal`s brings them back as *strings*, and a cache hit would
  then hand the program different types than a live fetch — a bug that only
  appears on the second run. Cache files are written to a temporary name and
  moved into place, so an interrupted run cannot leave a truncated file that a
  later run reads as data, and nothing is cached until it has parsed. And the key
  is a hash of the full URL, so a run against a different host can never be
  served this one's answers. Only public data goes through it; there is no
  authenticated call in this example.
- **Pacing is a minimum interval, not a token bucket**, and the comment says why:
  this tool makes a couple of dozen requests in a burst and exits. A trading
  client would need the bucket.

Also worth a look: every string that came off the wire is escaped with
`html.escape` before it reaches the HTML report — a market id, a halt reason, an
issue detail. None of them is under this program's control, and a report is
exactly the sort of artifact that gets forwarded and opened later. There is a
test that a halt reason of `<script>alert(1)</script>` survives as text.

## Verifying it

```bash
python3 -m unittest -q      # 65 tests, no network, no credentials
```

The validation is checked against the exact shapes the live venue returns — the
timestamp-0 row, the silent timeframe fallback, missing and off-grid buckets, the
market that is missing from one route, the mark price that contradicts the traded
price. The client's own refusals are exercised against a **real HTTP server on
the loopback interface** rather than a mock, so the content-type guard, the
redirect refusal, the retry policy, the byte cap and the cache are tested through
an actual socket.

CI does not run these — the Python recipe for this repo compiles and typechecks
every example — so they are here for the reader, and for whoever changes this
next. What CI does run:

```bash
python -m compileall -q .
mypy .                      # strict, targeting 3.12
```

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **Authenticated history is deliberately out of scope.** The account-level
  history endpoints — `/account/portfolio-history`, `/account/equity-history`,
  `/orders/history`, `/account/{address}/adl-history` — would each need HMAC
  request signing, and signing this API by hand is what
  [`exchange-api/trading-terminal`](../../exchange-api/trading-terminal) exists
  to teach, including the three traps that all produce an identical `401`. This
  report is about the venue rather than about your account, and everything it
  reads is public, so it stays credential-free: the best examples run with no
  setup. Adding a "your equity curve against the venue" section is a signing
  exercise on top of a working report, not a change to any of it.
- **The window is the buckets that came back, never an interpolated grid.** No
  figure here is computed over a filled-in series, and coverage is reported next
  to every row so you can see how much of the window was real.
- **A market that could not be fetched keeps its row**, with the failure attached
  as a finding rather than only logged — a CSV row with no numbers and no reason
  is indistinguishable from a quiet market.
- **`--strict` is the scheduled-run switch**, and findings carry a severity so
  that it means something. A feed that quietly degrades — a timeframe stops being
  honoured, a market drops out of a route, two of the venue's prices for one
  market stop agreeing — is exactly what a cron job should shout about. A dropped
  forming bucket is not: it happens on every single run. So findings are `info`
  (routine, `·`), `warn` (the numbers mean something different now, `*`) or
  `fatal` (no figure could be derived, `!`), and `--strict` fires on the last two
  only. A check that always fails is a check nobody looks at.
- Not implemented, and out of scope: the WebSocket (this is a batch tool by
  design), order-book depth or liquidity metrics, per-trade data from
  `/markets/{id}/trades`, cross-market correlation, and any persistence beyond
  the response cache.
