# risk-guard

A standing risk guard for one Nexus Exchange account, built on the Rust SDK.

It polls your account, checks it against limits you set, and — when armed —
cancels every resting order the moment a limit is breached.

```text
risk-guard on https://exchange.nexus.xyz/api/exchange (play funds)
limits: max-notional, max-loss — polling every 15s
--arm: a breach will cancel every resting order on this account
ok  max-notional=within max-loss=within  resting=2
BREACHED  max-notional=within max-loss=breached  resting=2
  max-loss: unrealized -61.40 (loss 61.40) vs limit 50
  cancelled 2 resting order(s)
```

## What it does, and what you learn from it

The app is small on purpose. `exchange-api/trading-terminal` builds a trading
app on the raw REST + WebSocket API and spends ~2,700 lines doing it — HMAC
signing, retry policy, bounded response reads, clock-skew detection, exact
decimal arithmetic. This is a few hundred lines because the SDK already owns all
of that, and what is left is the part that is actually yours: deciding what "too
much risk" means and what to do about it.

Three decisions in here are worth copying into whatever you build.

**It can only ever reduce exposure.** The entire write surface is
`cancel_all_orders`. The app never places an order, never amends one, and
deliberately does *not* flatten positions — flattening means sending a market
order, and a market order is a new risk rather than the removal of one. A guard
whose worst-case bug is "cancelled some orders you wanted" is a guard you can
actually leave running.

**A limit has three outcomes, not two.** The exchange reports a position's risk
fields as nullable, each paired with a machine-readable reason it is missing
(`notional_value` / `notional_value_error`): the mark price may not be mirrored
yet, market params may be unavailable. A guard that reads a missing notional as
zero concludes "exposure is under the limit" at the exact moment it has no idea
what the exposure is — it goes green during the outage that most warrants
attention. So `src/risk.rs` reports `Within`, `Breached`, or `Unknown`, and
`Unknown` never counts as safe. It also never fires the guard: acting on data the
app does not trust is its own failure mode, so it says the limit cannot be proven
and leaves it to a human.

**`tokio::select!` drops the losing future, and that is a live hazard here.** A
future dropped at an await point stops mid-request, with no unwinding and no
completion. Wrapping the cancel in a `select!` against a shutdown signal — the
obvious shape — makes Ctrl-C the thing that aborts the risk-reducing request. In
this app `select!` wraps *only* the sleep; every request runs to completion,
bounded by the client's own per-request timeout rather than by a signal. The
cost is that Ctrl-C during a poll waits for that poll, which is bounded and the
right trade. A second Ctrl-C exits at once and says what that can cost.

There is no other concurrency to get wrong, by design: the loop is strictly
sequential — fetch, evaluate, act, sleep — so a tick cannot overlap the previous
one, there is no shared mutable state and nothing to deadlock on. The one
concurrent step is fetching the account and the open orders together, and it is
safe precisely because the open orders feed no limit; they are only the thing
being cancelled.

## Prerequisites

- Rust 1.80+ (stable). Built and tested on 1.95.
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).

## Running it

```bash
export NEXUS_EXCHANGE_API_KEY=...      # see .env.example
export NEXUS_EXCHANGE_API_SECRET=...
export NEXUS_GUARD_MAX_LOSS=50

cargo run
```

That is watch-only: it reports, and changes nothing. Add `--arm` to let a breach
cancel your resting orders:

```bash
cargo run -- --arm
```

## Configuration

Credentials are **required** — this app watches your account, so there is no
useful public-data mode. Everything is read from the environment; nothing is
read from a committed file. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | Override the base URL (a local stack, a preview deployment) |
| `NEXUS_GUARD_MAX_NOTIONAL` | one of these | Cap on total position notional |
| `NEXUS_GUARD_MAX_LOSS` | one of these | Cap on total unrealized loss, as a positive number |
| `NEXUS_GUARD_MIN_AVAILABLE_MARGIN` | one of these | Floor on available margin |
| `NEXUS_GUARD_INTERVAL_SECONDS` | no | Poll interval, minimum 2, default 15 |

At least one limit must be set. A guard with no limits would print reassuring
output forever while checking nothing, so it refuses to start instead.

Limits are parsed as exact decimals and must be greater than zero. Plain
decimals only — `1e5`, `NaN` and `1,000` are all refused rather than guessed at,
because each has a plausible-looking parse and this value decides whether the
guard fires.

## Which deployment it talks to

**Testnet — play funds.** `Network::Testnet` is named explicitly in
`src/main.rs` rather than left to the default, so nobody has to guess whose money
this watches. Selecting `Network::Mainnet` is rejected by the SDK locally, before
any bytes leave the process, so this app does not re-implement that guard badly.

Passing `NEXUS_EXCHANGE_API_URL` builds a `Network::Custom` with
`Funds::Unknown`, because a bare URL cannot declare what the target moves.
Undeclared stays undeclared; this app only reads and cancels, neither of which is
funds-guarded, so `Unknown` costs nothing here and is the honest value.

## Pinned versions

This example is pinned to **`nexus-exchange` 0.9.1** (the Rust SDK), with
`rust_decimal` 1.38.0 and `tokio` 1.48.0. Exact `=` pins, and `Cargo.lock` is
committed, so a reader a year from now gets the behaviour this README describes
rather than a silently-upgraded SDK.

## Notes

- It is an example, not production-hardened code. It watches one account, keeps
  no state across restarts, and has no alerting beyond stdout.
- Money is never a float. Position values arrive as decimals and stay in
  `rust_decimal::Decimal` end to end; a limit check is a comparison against a
  sum, which is exactly where binary floating point would decide the wrong way.
- A failed poll is never read as a clean bill of health — it reports and retries
  on the next tick.
- There is no "already fired" latch. The condition is *breached and orders
  exist*, so a successful cancel makes the next tick a no-op by itself, while an
  order placed during a still-live breach is caught on the tick after it appears.
  A latch would have to be cleared by something, and every rule for clearing it
  is a rule that can be wrong.
- Not implemented, and out of scope: flattening positions, per-market limits,
  alerting, and `cancel-on-disconnect` (the API supports it, and it is the right
  server-side backstop for anything that must not outlive its process).
