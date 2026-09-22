# latency-probe

A latency probe for one testnet account. It places a post-only limit order
that cannot fill, cancels it, and repeats. Each round trip is timed in four
stages:

1. place to REST ack
2. place to the account WebSocket reporting the order
3. cancel to REST ack
4. cancel to the WebSocket reporting the cancel

At the end it prints p50/p95/p99/max per stage, the sample size behind each,
and a clock-offset estimate against the venue's own timestamps.

A reader learns two things from it. The first is how to measure a venue
honestly: a frame that never arrives is **missing**, not a timeout. The second
is how to write a tool that places real orders and leaves nothing behind.

> **Not yet exercised live.** No testnet API key was available when this was
> built, so `--live` has not run against testnet. The venue was also down at
> the time (see [What was exercised](#what-was-exercised-and-what-was-not)).
> The transcript below is real. It is the dry run refusing, which is what the
> app is meant to do when the venue cannot give it a safe price. No latency
> numbers appear here, because none were measured against the venue.

```text
$ cargo run            # 2026-09-22 22:41 UTC
latency-probe — https://api.testnet.nexus.xyz/indexer (play funds)
ws        wss://api.testnet.nexus.xyz/indexer/ws
refused   GET https://api.testnet.nexus.xyz/indexer/markets answered 502 Bad Gateway: error code: 502
          nothing was placed.
```

At that moment `GET /status` reported `"status":"down"` for the indexer,
engine and oracle. `mark-price` answered `503 mark price unavailable`, and the
order book was empty on both sides.

## What it does

- **Dry run by default.** `cargo run` reads the market's rules, price band,
  mark and book, prints the exact order it would place, and places nothing.
  It needs no credentials.
- **`--live` runs the probe.** For each round:
  - place a post-only BUY at the market minimum size
  - wait for the `orders` frame saying the order is resting
  - cancel it by id
  - wait for the frame saying it is cancelled

  It prints one line per round, then the report.
- **The report** has a percentile table and warnings about sample size and
  missing frames. It also has a catalogue of every `orders` frame the venue
  sent for this run's orders, grouped by shape (`OrderUpdate status=Open`, …)
  and by which stage timed it, if any. Last comes the clock-offset bound and
  how it was derived.

The report table's columns:

| column | meaning |
| --- | --- |
| `n` | samples that produced a measurement. Percentiles are over these only |
| `p50` `p95` `p99` `max` | nearest-rank, in ms, on the local monotonic clock. A trailing `*` means "at this n this percentile *is* the max" |
| `missing` | rounds whose frame did not arrive inside the wait window, e.g. `3 of 30`. **Never** counted as a latency |

## Prerequisites

- Rust 1.86+ (stable). Built and tested on 1.97.
  > `nexus-exchange` 0.11.0 declares `rust-version = "1.86"`, and the
  > committed `Cargo.lock` is lockfile v4.
- For `--live` only: a Nexus Exchange **testnet** API key and secret, created
  in the [Exchange app](https://exchange.nexus.xyz), on an account with a
  little testnet collateral. The order is the market minimum, far from the
  mark, so the margin it reserves is close to nothing.

## Pinned versions

This example pins **`nexus-exchange` 0.11.0** (the Rust SDK). It also pins
`rust_decimal` 1.42.1, `tokio` 1.53.1, `futures-util` 0.3.34, `serde_json`
1.0.151 and `reqwest` 0.12.28, each held at the version the SDK itself resolves
to. The pins are exact `=`, and `Cargo.lock` is committed. It targets the
Exchange API on **testnet**.

## Setup

```bash
cp .env.example .env   # add your testnet API key and secret (only needed for --live)
set -a; . ./.env; set +a
```

## Run

```bash
cargo run -- --live
```

Leave out `--live` for the credential-free dry run. `--help` prints the usage.
Any other argument is refused, not ignored.

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | `--live` only | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | `--live` only | Paired secret |
| `NEXUS_EXCHANGE_API_URL` | no | REST base override. Must be set together with `NEXUS_EXCHANGE_WS_URL`, and must not end in `/api/v1` |
| `NEXUS_EXCHANGE_WS_URL` | no | WebSocket origin override, prefix included |
| `NEXUS_PROBE_MARKET` | no | Default `BTC-USDX-PERP` |
| `NEXUS_PROBE_ITERATIONS` | no | Round trips, 1–200, default 30 |
| `NEXUS_PROBE_INTERVAL_MS` | no | Minimum gap between rounds, 250–60000, default 1000. Only ever lengthened by rate-limit pacing |
| `NEXUS_PROBE_WS_WAIT_MS` | no | Per-frame wait before a stage counts as missing, 500–30000, default 3000 |
| `NEXUS_PROBE_OFFSET_BPS` | no | Distance below the mark, 50–5000. Default is 80% of the live `price_band_bps`. Must be under the band |

Out-of-range values are refused, never clamped. A clamped limit is one the
reader did not choose.

## Which deployment it talks to

**Testnet, play funds.** It uses the same base as `liquidation-watch`,
`https://api.testnet.nexus.xyz/indexer`, spelled out in `src/config.rs`.
`Network::Testnet` in SDK 0.11.0 still points at the decommissioned
`exchange.nexus.xyz/api/exchange`.

The WebSocket origin is spelled out too:
`wss://api.testnet.nexus.xyz/indexer/ws`, the one `exchange-api/trading-terminal`
and `cli/stream-monitor` use. `Network::Testnet.ws_base()` is `None` in 0.11.0
(ENG-3398), so the SDK's streaming client refuses to connect unless it is told
where to go. The two URLs can only be overridden **together**. The upgrade token
is minted over REST, and it is only good on the deployment that issued it.

Any override is built as `Funds::Unknown`, and the banner says "funds not
declared" rather than claiming play funds.

## How it works

### 1. The order cannot fill, and the venue will accept it

`src/plan.rs` builds the order from what the venue reports. Nothing in it is
hardcoded.

- **Price band.** `price_band_bps` is read raw from `GET /markets`, because the
  SDK's typed `Market` does not carry the field. The venue rejects a limit
  price further from the mark than that band. If the field is missing, the
  app **refuses** to place: it cannot show the price is inside the collar, so
  it does not guess.
- **Price.** The order rests at 80% of the band below the mark. That is near
  the edge, as far from a fill as the venue allows, with 20% slack for the mark
  to drift. It is never closer to the mark than 50 bps.
- **Rounding.** The price is rounded **up** onto the tick, towards the mark. So
  rounding can only move it further *inside* the band. Rounding down would push
  it towards the band edge, the one direction that turns a safe order into a
  rejected one.
- **Refusals.** The app refuses if the price would cross the best ask. Post-only
  would reject such an order anyway, but a book that forces the question is not
  one to probe. It also refuses if the tick is so coarse that rounding lands
  near the mark.
- **Side, size, time in force.** BUY, at `min_order_size` on the lot grid, with
  `TimeInForce::PostOnly`.
- **Refresh.** The mark and book are re-read every 10 rounds, so a long run
  cannot drift out of the band.

### 2. Bounded, paced, and never retried

- **Hard caps in constants.** At most 200 rounds, and never closer together than
  250 ms.
- **Rate-limit budget.** `GET /api/v1/account/rate-limit` (free to call) is read
  up front and every 10 rounds. The gap between rounds is stretched until the
  probe uses at most **25%** of the account's budget: 2 signed requests per
  round against `limit × 0.25` per second. If the bucket is nearly empty
  because something else is using the key, the probe waits for the venue's
  `reset_at_ms`. A probe that spends the whole budget ends up measuring its own
  throttling.
- **No retry on placement.** The SDK does not retry signed calls, and this app
  does not either. A placement that fails ambiguously (timeout, transport, 5xx)
  may or may not have created an order. The app records its client id as
  *uncertain* and stops the run. Resubmitting would risk two orders to save one
  measurement.

### 3. It leaves nothing behind, and checks that it didn't

Every order carries a client id `lp-<run>-<n>`. At exit the app does two
things:

1. It cancels every order this run placed that has no acknowledged cancel.
   It cancels **by id**, never with the account-wide `DELETE /orders`, which
   would take your other orders with it.
2. It lists open orders and looks for this run's ids or client-id prefix. That
   check also catches an uncertain placement that did land.

If anything is still resting after two more cancel passes, the app prints the
ids and exits `3`.

This runs on a normal finish, on a stop caused by an error, on Ctrl-C/SIGTERM
(the current wait is cut short, then the order is cancelled), and on a
**panic** in the probe. The probe runs in its own task, so a panic surfaces as a
`JoinError` in `main` instead of unwinding past the cleanup. A second Ctrl-C
abandons the cleanup, and prints the ids and client-id prefix to check by hand.

Cancels in cleanup may be repeated. Cancelling is idempotent, so a repeat can
only find the order already gone. The no-retry rule is about submissions.

### 4. Missing is missing

A WS stage's clock starts just before the REST call and stops at the first
`orders` frame that matches the order and says the right thing: resting for the
place, cancelled for the cancel. The frame matches if the order's id or client
id appears anywhere in it. Frames are timestamped by a dedicated reader task
the moment the SDK decodes them, so a REST call in flight in the probe loop does
not delay the WS measurement.

If no such frame arrives within the wait window, the stage is recorded as
**missing**. It is not given the window as a latency, which would invent a
number. It is not dropped silently either, which would flatter the percentiles.
Frames that arrive late, or that the app did not expect, stay in the catalogue
marked `not timed`. A fresh `subscribed` ack mid-run means the SDK reconnected
underneath, and frames may have been lost across it, so the app prints it as a
WS problem.

### 5. Percentiles that say how far to trust them

Percentiles use the nearest-rank method with no interpolation, so every number
printed is a latency that was actually observed. At nearest rank, p95 is the
max until n ≥ 20, and p99 is the max until n ≥ 100. The table marks such cells
`*` and prints a small-sample warning. At the default 30 rounds, the p99 column
is the max, and the report says so.

### 6. Clock offset, and how it was bounded

`θ = venue clock − local clock` is bounded, not estimated by assumption:

- **REST acks.** A REST ack carrying `order.created_at` was stamped at a local
  instant between send `s` and ack `a`. So `created_at − a ≤ θ ≤ created_at − s`,
  a bracket one round trip wide. It needs no assumption that the two network
  legs are equal.
- **WS frames.** A WS frame carrying `emitted_at` left the venue before it was
  received at `r`. So `θ ≥ emitted_at − r`.

The report prints the intersection of every constraint as `midpoint ± half
width`, plus the tightest single REST bracket. If the constraints do not
intersect, the report says **INCONSISTENT** and gives no number, because then
the timestamps are not all from one clock. The offset is reported only. It is
never used to adjust a latency: every latency is local-monotonic end to end.

## What the `orders` channel sends: expected, not yet observed

The venue changed the `orders` channel on **2026-09-22**. nexus#12163 projects
an STP-cancelled maker's terminal `OrderUpdate`, and nexus#12198 publishes a
filled maker's order state. Both frames use the engine shape
`{"OrderUpdate": {order, epoch, sequence, emitted_at}}`. According to the
indexer's `docs/ws-channel-coverage.md`, `orders` carries the engine's
`OrderUpdate` plus the new maker-fill derivation.

Neither change is specifically about a *user* cancel of a *resting post-only*
order, and that is exactly what this probe produces. So nothing is assumed:
`src/frames.rs` matches frames by searching for the order's ids and reading
whatever `status` they carry, and the report catalogues what arrived. **This
has not been observed on testnet yet** (see below). The first `--live` run
answers it: a `cancel→WS` column that reads `30 of 30` missing is itself the
finding.

## What was exercised, and what was not

- **Exercised:** `cargo build --locked --all-targets`, `cargo clippy -- -D
  warnings`, and 20 unit tests. The tests cover:
  - order planning: band edge, tick rounding direction, cross refusal,
    coarse-tick refusal, lot rounding
  - nearest-rank percentiles, and the `*` marking
  - missing-frame accounting
  - clock-bound intersection, including the inconsistent case
  - frame matching against the shape nexus#12198 documents

  Also exercised: the dry run against live testnet (the refusal above), and
  the `--help` and argument-refusal paths.
- **Not exercised:** `--live` against testnet. No testnet credentials were
  available when this was built, and the venue was down at the time (`/markets`
  answered 502, `/status` reported the engine down). The signed routes this app
  uses (`POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`,
  `GET /api/v1/orders`, `GET /api/v1/account/rate-limit`, `POST /ws/token`) all
  answer `401` unsigned. That confirms the gate, not the path. Until someone
  runs it live, treat the latency table's shape as the only claim this README
  makes.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **What a stage includes.** `place→REST ack` includes the SDK's HMAC signing
  (microseconds) and TLS on an already-warm connection, not a cold handshake.
  The first round's numbers include the cold one. With n ≥ 20 that shows in the
  max, not in p50.
- **The WS stage is not "engine latency."** It measures the whole path: REST
  in, engine, indexer, hub, socket out. Comparing it with `place→REST ack` shows
  whether the account stream beats the REST response (the report counts how
  often it does). It does not isolate where the time went.
- **One order at a time, by design.** Concurrent probes would measure queueing
  on your own key.
- **The WS reader's queue is unbounded.** It is bounded in practice by the run:
  at most 200 rounds, plus whatever else the account does. The SDK's own
  channel is sized at 4096, so a burst of other account activity cannot make it
  drop frames and have them misread as missing.
- **Exit codes:** `0` clean, `1` bad configuration, `2` refused before placing
  or stopped early, `3` could not verify that this run's orders are gone (check
  the printed ids), `101` the probe panicked (cleanup still ran).
