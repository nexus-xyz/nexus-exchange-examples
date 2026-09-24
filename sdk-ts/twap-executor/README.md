# twap-executor

A TWAP executor, built on the TypeScript SDK. It takes one parent order (market,
side, total size, duration, slice count, limit price) and works it as timed
**IOC child orders**, then prints what it got: filled vs target, VWAP vs arrival
mid, and slippage.

What it's really about is the part of an execution client that fails at 3 a.m.:
a process that dies between sending an order and hearing back. Every child has
a client id derived from `(run id, slice index)`, the journal records the intent
*before* the order goes out, and `--resume` asks the venue what those ids became
before it sends anything. Kill it at the worst possible moment and it picks up
without sending anything twice.

**It dry-runs by default.** Without `--live` it sends no write of any kind.

## What it does

A dry run against live testnet (no credentials). This is what testnet looked like
on 2026-09-22: every book empty, so every slice correctly finds nothing to trade
against and rolls its quantity forward.

```text
22:43:31  twap-executor on https://api.testnet.nexus.xyz/indexer (testnet, play funds)
22:43:31  dry run: live data, no writes of any kind. Pass --live to trade
22:43:31  weights from spec v0.8.1 (openapi.json sha256 0160c4a5f779…)
22:43:31  tier    no credentials: public reads only, paced on the per-IP bucket the response headers report
22:43:31  run     7631578d (new)
22:43:31  budget  shared  4/s, spending up to 2.0/s (assumed)
22:43:31  market  BTC-USDX-PERP: rules unread. GET /markets is signed, so lot and minimum size are unchecked
22:43:32  arrival bid — / ask — → mid unavailable (one side empty)
22:43:32  plan    Buy 0.006 BTC-USDX-PERP over 60s in 6 IOC children of 0.001 / 0.001 / 0.001 / 0.001 / 0.001 / 0.001, limit none (dry run only)
22:43:32  ids     twap-7631578d-0 … twap-7631578d-5  (journal …/runs/7631578d.json)
22:43:32  slice 0  skipped: no asks on the book; 0.001 rolls forward
22:43:41  slice 1  skipped: no asks on the book; 0.002 rolls forward
…
22:44:21  slice 5  skipped: no asks on the book; 0.002 rolls forward

22:44:21  summary run 7631578d (dry run)
22:44:21    slices   6 skipped
22:44:21    filled   0 of 0.006 (0%). A dry run fills nothing
22:44:21    vwap     —  (no fills)
22:44:21    arrival  —  (no two-sided book at start)
22:44:21    slippage —  (needs both a VWAP and an arrival mid)
22:44:21    budget  shared  50/s, spending up to 25.0/s (header)
```

The pacer starts at a deliberately low assumed rate. It then adopts the venue's
real ceiling (`50/s` on the per-IP bucket) from the first response's labelled
headers.

And the part worth seeing: a `--live` run **SIGKILLed right after slice 2's
order went out**, then resumed. **This transcript is from the loopback venue in
[`src/run.test.ts`](./src/run.test.ts), not from testnet.** With testnet's books
empty there was nothing to fill against (see [Notes](#notes)). It's the
output of `TWAP_E2E_VERBOSE=1 npm test` (which runs these two commands against it), trimmed of the header
lines shown above.

```text
$ npm start -- --live --size 0.006 --duration 12 --slices 6 --limit 80001 --run-id e2e-43936 --kill-after 2
22:45:52  market  BTC-USDX-PERP: tick 0.5, lot 0.001, min size 0.001
22:45:52  arrival bid 79999.5 / ask 80000 → mid 79999.75
22:45:52  plan    Buy 0.006 BTC-USDX-PERP over 12s in 6 IOC children of 0.001 / 0.001 / 0.001 / 0.001 / 0.001 / 0.001, limit 80001
22:45:52  slice 0  twap-e2e-43936-0 IOC 0.001 @ 80000: Filled, filled 0.001
22:45:54  slice 1  twap-e2e-43936-1 IOC 0.001 @ 80000: Filled, filled 0.001
22:45:56  --kill-after 2: SIGKILL now, before the outcome of slice 2 is recorded

$ npm start -- --live --resume e2e-43936
22:45:56  resume  run e2e-43936, started 2026-09-22T22:45:52.244Z
22:45:56  resume  asking the venue about twap-e2e-43936-2 (open orders + history + fills)
22:45:56  resume  slice 2 (twap-e2e-43936-2): the venue has it. o6 Filled, filled 0.001. Adopted, not re-sent
22:45:58  slice 3  twap-e2e-43936-3 IOC 0.001 @ 80000: Filled, filled 0.001
22:46:00  pace    429 on the order bucket: pausing order for 1.47s (retry-after 1s + jitter)
22:46:00  slice 4  refused (429 RATE_LIMIT_EXCEEDED). Not placed, not retried; the quantity rolls forward. Exchange API 429: Order placement rate limit exceeded
22:46:02  slice 5  twap-e2e-43936-5 IOC 0.002 @ 80000.5: Filled, filled 0.002
22:46:02  sweep   verified: no order carrying twap-e2e-43936-* is resting
22:46:02  summary run e2e-43936 (live)
22:46:02    slices   5 done, 1 refused
22:46:02    filled   0.006 of 0.006 (100%)
22:46:02    vwap     80000.16667
22:46:02    arrival  79999.75
22:46:02    slippage 0.05 bps vs arrival (positive = worse)
```

The venue had slice 2 and the journal didn't. The resume found it by client id
and adopted it instead of sending it again. The `429` on slice 4 was a refusal,
so it wasn't retried. Its quantity rolled into slice 5, which caught up. The test
asserts all of this, including that no client id reached the venue twice.

## How it works

### Children are IOC, at the touch, never through your limit

Each child is a `Limit` order with `time_in_force: IOC`, priced at the **best
ask for a buy, best bid for a sell**. If the touch is already beyond `--limit`,
the slice sends nothing and its quantity rolls forward.

Why IOC rather than post-only:

- **A TWAP's job is the schedule.** A post-only child can sit unfilled while the
  market walks away, and then the executor has to cancel and replace. That costs
  two trading-budget units per slice, it's a cancel race, and the schedule drifts
  anyway. An IOC resolves in one request: it fills what's there at or better than
  its price, and the venue cancels the rest.
- **A crashed IOC leaves nothing behind.** It cannot rest, so there's no order
  on the book for a dead process to have forgotten. The exit sweep still reads
  `GET /orders` for this run's ids and cancels anything it finds, because "cannot
  rest" is a claim worth checking, not assuming.
- **The price guard is enforced twice.** A limit order can't fill worse than its
  price, so the venue holds the line even if the app's own check were wrong.

The cost is that you pay the spread: every child takes liquidity. A passive TWAP
that rests at the bid is a different tool with different failure modes. This
one chooses schedule fidelity and a clean crash.

### Slices are integer lots, and a shortfall rolls forward

The parent size is converted to a whole number of lots, and slice `i`'s
cumulative target is `floor(totalLots × (i+1) / slices)`. The per-slice
differences always sum to the parent exactly, with no dust child at the end.
Each child asks for "cumulative target minus what has filled", so a skipped or
partly filled slice is made up by the next. That catch-up is **capped at twice
the even share** (`CATCH_UP_CAP` in `src/plan.ts`), so an hour of downtime
doesn't arrive as one order. Anything still unfilled at the end is reported,
not dumped.

If the process is late (after a resume, or a slow slice) and a *later* slice is
already due, the earlier one is marked `missed` and only the latest runs. Two
back-to-back children would be a burst, which is what a TWAP exists to avoid.

### Idempotent and resumable

Three pieces, and each covers a gap in the others:

1. **Deterministic client ids.** `twap-<run id>-<slice index>`. The same run and
   slice always produce the same key.
2. **A write-ahead journal** in `runs/<run id>.json`. A slice goes to `sending`
   on disk *before* `POST /orders` is made, and the file is replaced atomically
   (write, then rename). A crash leaves each slice either unmarked (never sent)
   or `sending` (maybe sent), never "sent and forgotten".
3. **Reconcile before resending.** `--resume` takes every `sending` slice and
   asks the venue: `GET /orders` (weight 1), `GET /orders/history` (5) and
   `GET /fills` (5), matched on `clientOrderId`. That's eleven tokens however
   many slices are in doubt. Found means adopted, with its fills. Not found
   anywhere means it never landed, so it's sent again **under the same id**.

The venue's own `client_id` dedupe is the backstop behind step 3, not a
replacement for it. A repeated id answers `200` with the original while it's
still resting, and `409 DuplicateClientId` once it isn't, which for an IOC is
always. The app treats a `409` as "look it up", not as an error. But the venue
documents that its key retention is "sized to cover a retry window rather than
a session", and "must not be used as" a durable uniqueness constraint. So the
app asks first and lets the dedupe catch only the case where the indexer hadn't
caught up yet.

### Pacing on weight, against budgets the venue reports

- **Weights** come from the pinned spec's `x-nexus-rate-limit-weight` markers,
  which the spec calls "the machine-readable form ... for client-side
  limiters". `npm run sync-weights` extracts them from spec `v0.8.1` into
  [`src/spec-weights.json`](./src/spec-weights.json), recording the tag and the
  file's sha256. An operation with no marker costs 1, which is the spec's rule.
  `/fills` and `/orders/history` cost 5. `GET /account/rate-limit` costs 0,
  since it's "the one operation that consumes no tokens".
- **Budgets** come from `GET /account/rate-limit`, never the tier table
  ("per-deployment configuration and not part of this contract"). Order writes
  draw on a separate trading budget from reads. When the venue reports
  `buckets.order` / `buckets.cancel` (additive, newer than v0.8.1) they're used.
  When it doesn't, the trading ceiling is inferred from the request ceiling and
  starts empty, and cancels share it, as v0.8.1 describes. After that, every
  response's `x-ratelimit-limit` / `-remaining` is adopted **only when
  `x-ratelimit-bucket` names the bucket it describes**.
- **A `429`** pauses only the bucket it names, for `retry-after` **plus up to
  50% jitter**. Jitter only adds, because waking early is being refused again.
  Reads and cancels are then retried. The SDK is built with `maxRetries: 0` so
  this is the only retry policy in play.
- **An order submission is never retried**, not even on a `429`. The `429`
  means it wasn't placed, so the slice is marked `refused` and the next slice's
  catch-up absorbs it, with a fresh price and its own id. A timeout or `5xx` is
  ambiguous, so the app reconciles by reads and never resends.
- **`POST /orders/preview` is never called.** It's a trading action billed
  exactly like a placement. Previewing each child would halve the placement
  rate to learn what the IOC's own response says anyway.

### Money is never a float

Sizes, prices, VWAP and slippage are exact decimals on `BigInt`
([`src/decimal.ts`](./src/decimal.ts)). The one float that enters is the order
book, which is CCXT-shaped and sends levels as JSON numbers. Each level is read
through its shortest round-trip string and then **checked against the tick
grid**. An off-grid price means digits were lost on the way in, so it's refused
rather than rounded. Division happens only in the report (VWAP, mid, bps), with
its rounding mode stated.

### Where the pinned SDK and the live venue disagree

Worth knowing if you copy this into your own code. Each one is handled
explicitly in `src/venue.ts` / `src/plan.ts`:

- **`client_id` isn't in spec v0.8.1 or the SDK 0.4.0 types**, but the venue
  accepts and documents it. The child is typed `OrderRequest & { client_id }`,
  and the SDK sends the body through unchanged.
- **The venue serves `Order` in CCXT's vocabulary** (`symbol`, `clientOrderId`,
  `amount`, `filled`), not the SDK's (`market_id`, `filled_qty`, no client id).
  `Market.market_id` is now `id`. Everything is read structurally under both
  spellings. A reconcile that read only one would match nothing, and "matched
  nothing" reads as "never placed", which is exactly the double-send this
  design exists to prevent.

## Prerequisites

- Node 22 or later (tested on Node 22.23; CI builds on 22).
- For `--live`: a Nexus Exchange **testnet** API key, created in the
  [Exchange app](https://exchange.nexus.xyz). The dry run needs none.

## Pinned versions

This example pins **`@nexus-xyz/exchange-ts` `0.5.0`**, exact version, with
`package-lock.json` committed. 0.5.0 is compiled against Exchange API spec
**`v0.8.1`**, which is also the tag `src/spec-weights.json` was generated
from. A test fails if the two ever disagree. Toolchain: `typescript` `7.0.2`,
`tsx` `4.23.8`, `@types/node` `26.1.2`.

## Setup

```bash
npm install
cp .env.example .env   # optional: only needed for --live
```

## Run

```bash
npm start
```

That's the dry run with a small default parent (buy 0.006 BTC-USDX-PERP over
60s in 6 slices). To trade on testnet, with credentials in `.env`:

```bash
npm start -- --live --size 0.006 --duration 60 --slices 6 --limit 80000
```

`--limit` is required with `--live`: a TWAP with no price guard buys at whatever
the book offers for as long as it runs. To see the resume, add
`--kill-after 2`, then run `npm start -- --live --resume <run id>` with the id
it printed.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market ID` | `BTC-USDX-PERP` | Market to trade |
| `--side buy\|sell` | `buy` | Direction |
| `--size N` | `0.006` | Total size, a decimal. Must be a multiple of the market's lot |
| `--duration S` | `60` | Seconds to work it over |
| `--slices N` | `6` | Number of children. Each must reach the market's minimum size |
| `--limit P` | none | Worst price any child may trade at. Required with `--live` |
| `--live` | off | Place real IOC orders |
| `--run-id ID` | random | Name the run. Child ids derive from it |
| `--resume ID` | | Continue a run from its journal, reconciling first. The parent comes from the journal and can't be changed |
| `--kill-after N` | | Demonstration: SIGKILL right after slice N is sent, before its outcome is recorded |

Unknown flags are refused, not ignored.

**Exit codes:** `0` done; `1` configuration, plan or API error; `3` something is
unresolved (a slice whose outcome is unknown, or an order the sweep couldn't
clear), so run `--resume`; `130` interrupted. Ctrl-C stops the schedule, then
sweeps and summarises. A second Ctrl-C exits at once.

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | for `--live` | API key. Without it, the dry run uses public data only |
| `NEXUS_EXCHANGE_API_SECRET` | for `--live` | Secret paired with the key. Set both or neither |
| `NEXUS_EXCHANGE_API_URL` | no | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Must not include `/api/v1` |
| `NEXUS_EXCHANGE_FUNDS` | no | `play` to declare an overridden host a testnet. `--live` refuses an undeclared one |
| `NEXUS_TWAP_UTILISATION` | no | Fraction of each rate-limit budget to spend. Default `0.5` |

## Which deployment it talks to

**Testnet: play funds.** The default base is
`https://api.testnet.nexus.xyz/indexer`, spelled out in `src/config.ts` rather
than taken from `Network.Testnet`. As in the other `sdk-ts` examples, the SDK
0.4.0 preset points at `https://exchange.nexus.xyz/api/exchange`, which proxies
to a decommissioned service and answers 500. The `/indexer` prefix is part of
the deployment, since the bare host 404s. An `NEXUS_EXCHANGE_API_URL` override
is declared `funds: "unknown"` unless you set `NEXUS_EXCHANGE_FUNDS=play`, and
the first line of output says which.

## Tests

`npm test` runs both suites, offline, and CI runs them through `npm run build`:

- [`src/plan.test.ts`](./src/plan.test.ts): the schedule sums exactly, a child
  never crosses the limit, off-grid book prices are refused, VWAP/slippage are
  exact and signed, reconcile matches both vocabularies, the weights file matches
  the SDK's spec tag, and `429` pauses never undercut `retry-after`.
- [`src/run.test.ts`](./src/run.test.ts): the kill-and-resume transcript above,
  against a loopback venue that implements the documented `client_id` replay and
  `409` semantics, IOC matching, and a `429` with `retry-after`. It asserts no
  client id reaches the venue twice.

## Notes

- **What ran against live testnet, and what didn't.** The dry run was run end to
  end against `api.testnet.nexus.xyz` without credentials: the public book
  reads, header-driven pacing on the per-IP bucket, the journal, SIGINT, and a
  dry-run `--resume`. **The `--live` trading path has not been run against
  testnet.** The author had no testnet credentials to hand. On the same day the
  venue's own `GET /status` reported its engine and indexer `down`, every book
  was empty, and marks were unavailable, so there was nothing to trade against.
  The live path, the kill and resume, the reconcile, the `429` handling and the
  sweep ran against the loopback venue in `src/run.test.ts`, which implements
  the venue's documented behaviour. That isn't the same as the venue. Before
  relying on this, run the `--live` command above with a small size against a
  testnet that has a book.
- **The journal is local state**, one file per run in `runs/` (gitignored).
  Delete it and a resume has nothing to resume. The venue still has the orders,
  under ids you can recompute from the run id.
- **Reconcile reads bounded windows**: the last 500 terminal orders and 1,000
  fills. A run resumed long after it died, on a busy account, can find its
  orders evicted, and would then send those slices again. The venue's dedupe
  won't catch that either, since its retention is shorter still. Resume
  promptly.
- Not implemented, and deliberately so: participation caps against traded
  volume, passive (resting) children, randomised slice timing, and multiple
  parents. Each is a real TWAP feature and each would double the size of this
  example.
- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
