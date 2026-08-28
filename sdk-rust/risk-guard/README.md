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
  cancelled every resting order on this account (2 seen this tick)
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

`Unknown` is not a licence to stop reasoning, though, and getting that wrong is
the mirror image of the same bug. `notional_value` is `|size| × mark price`, so
it is never negative, which makes a partial sum a **lower bound** on the true
total. If that bound already exceeds the limit, nothing missing can bring it back
under — the breach is *proven*, and the guard fires on it. `Unknown` is reserved
for the case where the missing values could still land either side of the limit.
The same argument run the other way covers flat positions: at `size == 0` the
notional is provably zero whatever the mark price is, so a dust position in an
unmirrored market is skipped rather than allowed to weigh on `max-notional` from
then on.

**`tokio::select!` drops the losing future, and that is a live hazard here.** A
future dropped at an await point stops mid-request, with no unwinding and no
completion. Wrapping the cancel in a `select!` against a shutdown signal — the
obvious shape — makes Ctrl-C the thing that aborts the risk-reducing request. In
this app `select!` wraps *only* the sleep; every request runs to completion
rather than being cut short by a signal. A second Ctrl-C exits at once and says
what that can cost.

"Not interruptible" is only an acceptable trade if the wait is a number you can
state, so the app derives it. A tick makes at most two sequential requests — the
paired poll, then a cancel it may have triggered — each bounded by the 10s
per-request timeout, giving a worst case of **20s**, which is what the shutdown
message prints. That constant is computed from the timeout in `src/main.rs`
rather than written down twice, and it is deliberately inside the 30s that
Kubernetes' `terminationGracePeriodSeconds` defaults to, so a SIGTERM at the
worst moment ends in a clean shutdown instead of a SIGKILL. Worth knowing why
the arithmetic is that simple: the SDK's timeout bounds one *attempt*, and its
unauthenticated public-data `GET` path retries — but every call this app makes is
a signed one, and the SDK's signed helpers do not auto-retry, so here one call is
one attempt.

There is no other concurrency to get wrong, by design: the loop is strictly
sequential — fetch, evaluate, act, sleep — so a tick cannot overlap the previous
one, there is no shared mutable state and nothing to deadlock on. The one
concurrent step is fetching the account and the open orders together, and it is
safe precisely because the open orders feed no limit; they are only the thing
being cancelled.

## Prerequisites

- Rust 1.86+ (stable). Built and tested on 1.95.
  > `nexus-exchange` 0.9.1 declares `rust-version = "1.86"`, and the committed
  > `Cargo.lock` is lockfile v4, so anything older fails `cargo build --locked`
  > outright rather than degrading.
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

`--arm` is the whole command line; `--help` prints it. Anything else is
**refused** rather than ignored, because every near-miss for that one flag —
`--armed`, `-arm`, `--arm=true` — would otherwise leave you believing the guard
may act while it silently stays watch-only, and a guard you think is armed and
is not is worse than no guard.

## Configuration

Credentials are **required** — this app watches your account, so there is no
useful public-data mode. Everything is read from the environment; nothing is
read from a committed file. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | Override the base URL (a local stack, a preview deployment). Validated at startup |
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
funds-guarded, so `Unknown` costs nothing here and is the honest value. The
banner prints whatever the target's funds actually are — `play funds` for
testnet, `funds not declared` for an override — and never asserts one over the
other, which is the reason the SDK models funds as a tri-state in the first
place.

A `CustomNetwork` also needs a **label**, and it cannot be any label you like:
the SDK namespaces stored credentials by it, so it refuses every built-in
network's name and reserves the literal `"custom"` for the target its own
deprecated `Config::with_base_url` builds. This app labels the override
`api-url-override` after the variable it came from. Worth knowing if you copy
this code: passing `"custom"` there fails at startup, and it fails for exactly
the reader who needed the escape hatch.

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
- A failed poll is never read as a clean bill of health — but "retry next tick"
  is only right for a *transient* failure. A terminal one (revoked credentials
  above all) fails identically forever, so the guard stops and exits with the
  SDK's `sysexits.h` code — `77` `EX_NOPERM` for credentials, `65` otherwise.
  Sitting there logging the same 401 every tick and still exiting `0` is the
  worst failure this app could have: nothing restarts it, and nobody is told the
  account is now unwatched.
- `Unknown` is strict where it can hide exposure and nowhere else. A position
  with no mark price leaves the notional total unprovable *in one direction
  only*: the positions that do report still bound it from below, so a bound
  already over the limit is a breach the guard acts on, and `Unknown` is kept
  for the total that could still land either side. A *flat* position contributes
  `|size| × mark price = 0` whatever the mark is, so it is skipped entirely —
  otherwise one dust position in an unmirrored market would weigh on
  `max-notional` on every tick from then on, and a limit that can never be
  proven within is a limit that never checks anything.
- There is no "already fired" latch. The condition is *breached and orders
  exist*, so a successful cancel makes the next tick a no-op by itself, while an
  order placed during a still-live breach is caught on the tick after it appears.
  A latch would have to be cleared by something, and every rule for clearing it
  is a rule that can be wrong.
- Not implemented, and out of scope: flattening positions, per-market limits,
  alerting, and `cancel-on-disconnect` (the API supports it, and it is the right
  server-side backstop for anything that must not outlive its process).
