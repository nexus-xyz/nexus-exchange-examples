# quote-ladder

A desk automation you can actually put on a timer: it keeps a ladder of resting
post-only orders on one market, driven entirely by the **`nexus` CLI**, `jq` and
bash. No SDK, no runtime, no compile step.

What it teaches is not how to place an order — that is one command — but how to
make a *repeatable* workflow out of a CLI that has no memory between runs. It is
written as a **reconciler**: it computes the ladder that should be resting,
reads what actually is, and applies the difference. Run it twice and the second
run does nothing. Kill it halfway and the next run finishes the job.

## What it does

Read-only by default. It reads the market's trading rules, its lifecycle status
and its mark price, works out the rungs, reads back your open orders, and prints
the diff.

```
$ ./run.sh
02:24:16Z  no credentials configured — running read-only (public market data only)
quote-ladder  BTC-USDX-PERP  (testnet)
──────────────────────────────────────────────────────────────────────────────
cli         nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)
auth        no — read-only, public market data only
rules       tick 0.5   lot 0.001   min 0.001   max 100
market      BTC-USDX-PERP   status active
price       mark 69509.350   best bid 69493   best ask 69561
ladder      buy × 3, from 100bps, 50bps apart, 0.001 per rung, post-only
owns        ql-*
──────────────────────────────────────────────────────────────────────────────
ACTION   SIDE  PRICE           QTY         CLIENT ORDER ID
place    buy   68814           0.001       ql-b-137628-1
place    buy   68466.5         0.001       ql-b-136933-1
place    buy   68119           0.001       ql-b-136238-1

0 to cancel, 3 to place, 0 already correct.

plan only — nothing was sent. Re-run with --commit to apply it.
```

`--commit` applies that plan and then reads the account back. `--flatten`
cancels every order the app owns and places nothing. A second run against an
unchanged market prints `0 to cancel, 0 to place, 3 already correct.` and sends
no write at all — which is the property that makes it safe in a crontab.

## Prerequisites

- **`nexus-exchange-cli` 0.4.0.** Install it with
  `curl https://cli.nexus.xyz | sh`, or see the
  [CLI README](https://github.com/nexus-xyz/nexus-exchange-cli#install) for
  Homebrew and release artifacts. `run.sh` checks the version and refuses to run
  against a different one.
- **bash 4.4 or newer.** Checked at startup. macOS still ships bash 3.2, where
  associative arrays do not exist — `brew install bash` and re-run.
- **`jq`.** Every response is parsed with it. Tested on 1.8.2, works on 1.6+
  (it uses `first(f)`, `@tsv` and `-e`).
- **Optional: Nexus Exchange testnet API credentials.** The plan path needs
  none. `--commit` and `--flatten` do, and so does reading your open orders —
  mint a pair with `nexus keys create`, or run `nexus setup`.

No `bc` and no `awk`: see [Money is not a float](#money-is-not-a-float).

## Pinned versions

This example pins **`nexus-exchange-cli` 0.4.0**, which reports API spec
**v0.8.1** and SDK `nexus-exchange` 0.9.1 — the exact string it prints is in the
report's `cli` line. There is no lockfile to commit because the CLI ships as a
prebuilt binary rather than a package, so the pin is enforced at runtime instead:
`nexus --version` is compared against 0.4.0 on every run, and a mismatch is a
refusal rather than a warning. The CLI's command surface has changed
incompatibly between releases before now — `--network stable` was removed in
favour of `testnet`, and `order get`/`order cancel` grew a required `--market` —
so "probably close enough" is not a safe default for a script that places
orders. Set `LADDER_ALLOW_CLI_VERSION=1` to try anyway.

It targets **testnet** — play funds, no real-world value. `mainnet` is refused,
and that refusal has no override.

## Setup

```bash
cp .env.example .env   # optional — only for --commit, --flatten, and reading your orders
```

## Run

```bash
./run.sh
```

Then, once you have credentials in `.env`:

```bash
./run.sh --commit     # cancel what's off-ladder, place what's missing
./run.sh --flatten    # cancel everything this app owns, place nothing
```

On a timer, which is what it is for:

```cron
*/5 * * * * cd /path/to/quote-ladder && ./run.sh --commit >> ladder.log 2>&1
```

## Configuration

Environment only — nothing is passed on the command line, because arguments are
visible in the process list. `.env` is read if present, and the real environment
always wins over it.

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_API_KEY` | no | API key id. Without it, public market data only. **Not** `NEXUS_EXCHANGE_API_KEY` — that is the SDKs' name, and the CLI does not read it. |
| `NEXUS_API_SECRET` | no | API secret (hex) paired with the key. |
| `LADDER_MARKET` | no | Market to quote. Defaults to `BTC-USDX-PERP`. |
| `LADDER_SIDES` | no | `buy` (default), `sell`, or `both`. |
| `LADDER_RUNGS` | no | Rungs per side, 1–20. Defaults to `3`. |
| `LADDER_START_BPS` | no | How far the first rung sits from the mark, in bps. Defaults to `100` (1%). |
| `LADDER_STEP_BPS` | no | Spacing between rungs, in bps. Defaults to `50`. |
| `LADDER_QUANTITY` | no | Size per rung. Defaults to the market's minimum order size. |
| `LADDER_TAG` | no | Client-order-id prefix marking an order as this app's. Defaults to `ql`. |
| `LADDER_NETWORK` | no | `testnet` (default) or `local`. `mainnet` is refused. |
| `LADDER_STATE_DIR` | no | Where the run lock lives. Defaults to `.state/` beside the script. |
| `LADDER_TIMEOUT_SECONDS` | no | Per-CLI-call ceiling. Defaults to `30`. |
| `LADDER_READ_ATTEMPTS` | no | Retries for a *read*, 1–5. Defaults to `3`. Writes are never retried. |
| `LADDER_ALLOW_CLI_VERSION` | no | `1` to run against an unpinned CLI. |
| `LADDER_ALLOW_NETWORK` | no | Names a custom network to permit. Never honoured for `mainnet`. |

Every value is validated before the first request. `LADDER_*` rather than
`NEXUS_*` on purpose: `NEXUS_*` is the CLI's own namespace, and a variable that
looks like the CLI's but is read by a script sitting on top of it is a good way
to spend an afternoon.

### Exit codes

Because the intended caller is `cron`, a CI step, or a systemd unit, and "it
failed" is not enough for any of them to decide what to do next.

| Code | Meaning |
| --- | --- |
| 0 | The plan was printed, or applied in full. |
| 1 | Bad flag, or a configuration value that could not be read. |
| 2 | Preflight refusal: wrong network, missing tool, unpinned CLI, broken credentials. |
| 3 | The market cannot be quoted: unlisted, halted, or no usable mark price. |
| 4 | A write was attempted and did not fully land. Nothing is retried; the next run reconciles. |
| 75 | Another run holds the lock (sysexits' `EX_TEMPFAIL` — "nothing is wrong, come back later"). |

## How it works

Six files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`run.sh`](./run.sh) | Modes, lifecycle, the report, and the order writes happen in. |
| [`lib/decimal.sh`](./lib/decimal.sh) | Exact decimal arithmetic on bash integers. |
| [`lib/ladder.sh`](./lib/ladder.sh) | The desired set, the actual set, and the diff between them. |
| [`lib/nexus.sh`](./lib/nexus.sh) | The single place the CLI is invoked, and the read/write retry asymmetry. |
| [`lib/preflight.sh`](./lib/preflight.sh) | Everything checked before the first order is computed. |
| [`lib/lock.sh`](./lib/lock.sh) | The single-writer lock. |

Five decisions are worth copying into whatever you build.

### The client order id is derived, not generated

Every rung's id is `<tag>-<b|s>-<price in ticks>-<size in lots>` — computed from
what the rung *is*, so two runs that want the same rung compute the same id.
That one choice is what makes the whole thing idempotent: matching is a string
comparison, not a guess about which of six open orders was probably mine.

A random or timestamped id would be unique, and would make every run see the
previous run's orders as strangers, cancel all of them, and place the same
ladder again under new ids — churn every cycle, fees every cycle, and a window
with nothing resting at all.

Because the id names the rung's whole intent, a rung whose size changed is a
*different rung*: cancelled, and replaced under the id that names the new size.
That is also why this app never calls `order amend`. Amend is an atomic
cancel-replace at the venue, and the spec does not say whether the replacement
inherits the client order id; since every match here is by that id, a rung that
came back without one would be an orphan the app could neither recognise nor
clean up. The cost is that a resized rung is off the book for the moment between
the cancel and the placement — for an order resting 1% away, not a cost at all.
On a market where queue position matters, that trade-off flips, and then the
first thing to establish is what amend actually does to the id.

### Money is not a float

The venue accepts and echoes prices as decimal *strings*, and only accepts a
price that is an exact multiple of the market's tick size. So the last digit is
not cosmetic — it decides whether the order is accepted at all. Every obvious
way to do arithmetic on those strings in a shell script goes through a double:

```sh
awk 'BEGIN { printf "%d", 69694.1125 * 0.995 }'   # a double, then truncated
echo "69694.1125 * 0.995" | bc                    # and bc is not always installed
```

[`lib/decimal.sh`](./lib/decimal.sh) carries every value as an integer mantissa
plus a scale, combines two values only at a common scale, and floors division in
a direction the caller states. Three details in there are the ones that bite:

- **Rounding is `floor` or `ceil`, never "nearest".** Rounding a bid to the
  *nearest* tick can move it up, across the spread, turning a resting order into
  a crossing one.
- **`mantissa * bps` is where a real price overflows 64 bits**, so the multiply
  is split into whole and remainder parts. Bash arithmetic wraps silently — there
  is no error to catch — so every mantissa is also width-checked *before* it
  reaches `$(( ))`, where a too-wide value has already wrapped.
- **Comparison is numeric, never textual.** The venue legitimately echoes
  `69300.00` for a price this app computed as `69300`, and `0.00100` for
  `0.001`. Compare those as strings and the reconciler cancels and replaces the
  entire ladder, on every single run, forever. There is a test for exactly this.

### A timeout is not a rejection

Reads are retried; **writes never are.** The Exchange has no client-supplied
idempotency key on the request, so a retry after a timeout is how one intended
order becomes two real ones — the first attempt may well have been accepted and
only the reply lost. When a write's outcome is unknown, the app reads the state
back and reports what it finds, rather than guessing. The next run reconciles
whatever this one left behind, which is the same mechanism that makes it safe to
Ctrl-C.

Two more things about writing here:

- **`order batch` is not atomic.** Each entry independently reports
  `outcome: "ok"` or `outcome: "err"`, so a zero exit status means "the request
  was processed", not "every order was placed". The outcomes are what this reads;
  a rejected entry exits 4.
- **`"tif": "postonly"`, not `"post-only"`.** The command-line flag really is
  `--tif post-only`, and the same value inside a batch file has to be spelled
  `postonly` — two serialisers, one for the flag parser and one for the JSON,
  and only the flag gets the dash. Worth knowing because the batch file is also
  the only placement path that carries `client_order_id`, so a script built on
  derived ids cannot avoid it and take the flag's spelling instead.

### It cancels only orders it can name

`nexus order cancel --all` is one flag away at all times, and it would take out
every resting order on the account — including ones you placed by hand, on other
markets, for other reasons. This app never uses it. Everything it cancels, it
cancels by client order id under its own `LADDER_TAG` prefix; an order it does
not own is reported and left alone, and an order it owns on a *different* market
is reported and left alone too.

Two smaller refusals in the same spirit. `.env` is **parsed, never sourced** —
`source .env` is a code-execution primitive, and the one file whose entire
purpose is to hold a credential is the last one to hand to a shell. And nothing
in the app ever reads, prints or logs the secret: credentials go to the CLI
through the environment, never as arguments, because arguments are visible in the
process list. Even the warning about an unparsable `.env` line prints the line
*number* and not the line, since a mangled `.env` line is as likely as not to be
a mangled secret.

### On concurrency

There is exactly one real hazard, and it is the one a timer creates: a run that
takes longer than the interval overlaps the next one. Two runs that each read
"nothing is resting" and then each place three rungs leave six orders on the
book — twice the intended exposure, from code where every individual step was
correct.

So a write is taken under a single-writer lock, and the details matter more than
the idea:

- **`mkdir`, not a file test.** `[[ -e lock ]] && exit || touch lock` is two
  operations with a window between them, and both runs can pass the test. A
  `mkdir` either creates the directory or fails, in one step.
- **`mkdir`, not `flock`.** `flock(1)` is util-linux and is not on a stock
  macOS, and a lock that only holds on Linux is not a lock.
- **Non-blocking, always.** A held lock exits 75 and never waits. Nothing here
  can deadlock because nothing here ever waits — and a timer-driven job that
  blocks on its predecessor piles up processes until the box falls over, which is
  a worse failure than a skipped cycle and a much harder one to read afterwards.
- **A stale lock is cleared only when its holder is provably dead**, and every
  ambiguous case resolves towards refusing: an unreadable pid file means a run
  that started microseconds ago, and a `kill -0` failure is only proof of death
  when the kernel said "no such process" (a live process owned by another user
  fails it too). Stealing a lock from a run that is mid-placement is the
  expensive mistake; skipping one cycle is the cheap one.
- **Clearing a stale lock renames it aside rather than deleting it in place**,
  because two runs can see the same dead pid at the same moment. Exactly one
  `mv` can succeed, which picks a single winner; the loser refuses. Deleting in
  place would let the loser delete the winner's freshly created lock.
- **The lock is released from a trap on every exit path** — clean finish, `die`,
  an uncaught failure under `set -e`, Ctrl-C, SIGTERM — and only if the pid file
  still names this process, so a late-firing trap cannot release a lock some
  other run has since taken.
- **Reads take no lock**, so a plan run never blocks a committing one.

Also worth a look, briefly: the report is on stdout and every log line on
stderr, so the output stays pipeable; `--network` and `--output json` are passed
as flags on every call so a stale `NEXUS_NETWORK` or `NEXUS_OUTPUT` in the
reader's shell cannot change what a command does or how it is parsed; and
`NEXUS_BASE_URL` — which outranks `--network` in the CLI, and would send a run
labelled `testnet` somewhere else entirely — is refused outright, including when
it comes from the CLI's own config file, which the app can only detect from the
deprecation notice the CLI prints on stderr.

## Verifying it without an account

The read path runs against live testnet with no credentials at all. The write
path needs a funded testnet account — and the behaviour most worth being sure
about is exactly what a reader without one cannot reach. So the venue is
stubbed:

```bash
./test/run-tests.sh      # 137 assertions, no network, no account
```

[`test/fake-nexus.sh`](./test/fake-nexus.sh) stands in for the `nexus` binary,
answering from files the tests write and recording every invocation — which is
how the suite asserts on what the app *did not* send. It covers the idempotent
re-run, trailing zeros in an echoed price, the off-ladder cancel, the partially
filled rung, a rejected batch entry, the crossing-rung and halted-market
refusals, `--flatten` leaving a hand-placed order alone, every lock path
including the stale one, and the decimal arithmetic directly.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **The write path has not been run against the live venue.** It needs a funded
  testnet account, which needs a wallet-signed `nexus keys create`; every read
  path here was run end to end against live testnet, and the write path is
  covered by the stubbed suite above. The two things it depends on that a stub
  cannot confirm are that the venue accepts `"tif": "postonly"` in a batch entry
  (the CLI's own parser does — that much was checked against the binary) and
  that `order cancel-by-client-id` matches on the id this app derives.
- **A ladder is not a strategy.** It rests far from the mark, post-only so it can
  never take, at the venue's minimum size by default, and it does not hedge,
  size, or manage a position. If a rung fills you have a position and this app
  will not do anything about it — it reports the fill and leaves it. Deliberately:
  a partially filled rung is never topped back up, because replacing the filled
  amount re-arms the same exposure, and a market walking down through the ladder
  would be met with an order that keeps regenerating itself.
- **Rungs are priced off the mark price, not the mid.** A mid needs both sides of
  the book, and testnet routinely has none on one side — while this was being
  written, `BTC-USDX-PERP` had an empty ask side and `ETH-USDX-PERP` was halted
  outright. The mark is a single published number that is always there.
- **A ladder-wide reprice is not atomic.** Cancels are sent before placements so
  margin is freed before it is consumed, but between the two the book is thinner
  than it should be, and a run that dies in the middle leaves it that way until
  the next one. That is the trade this design makes: recoverable rather than
  transactional.
- Not implemented, and out of scope: the WebSocket (`nexus ws`) as a trigger
  instead of a timer, funding-aware or volatility-aware spacing, position and
  margin management, `order amend` (see above), and any state carried between
  runs other than the lock — the venue is the state.
