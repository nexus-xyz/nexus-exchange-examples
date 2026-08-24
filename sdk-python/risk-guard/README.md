# risk-guard

A standing risk guard for one Nexus Exchange account, built on the **Python SDK**.

It polls your account, checks it against limits you set, and — when armed —
cancels every resting order the moment a limit is breached.

```text
risk-guard on the testnet default host (play funds)
limits: max-notional, max-loss — polling every 15s
--arm: a breach will cancel every resting order on this account
ok  max-notional=within max-loss=within  resting=2
BREACHED  max-notional=within max-loss=breached  resting=2
  max-loss: unrealized -61.40 (loss 61.40) vs limit 50
  cancelled every resting order on this account (2 seen this tick)
```

This is the Python member of a set: the same app, same limits and same posture
exist as `risk-guard` under [`sdk-rust/`](../../sdk-rust) and
[`sdk-ts/`](../../sdk-ts), and as `risk-review` over MCP under
[`sdk-mcp/`](../../sdk-mcp). Reading two of them side by side is the point — the
differences are the ones the language and the SDK actually impose, not stylistic
ones.

## What it does, and what you learn from it

The app is small on purpose. `exchange-api/trading-terminal` builds a trading app
on the raw REST + WebSocket API and spends ~2,700 lines doing it — HMAC signing,
retry policy, bounded response reads, clock-skew detection, exact decimal
arithmetic. This is a few hundred because the SDK already owns all of that, and
what is left is the part that is actually yours: deciding what "too much risk"
means and what to do about it.

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
attention. So `risk.py` reports `WITHIN`, `BREACHED` or `UNKNOWN`, `UNKNOWN`
never counts as safe, and it never fires the guard either: acting on data the app
does not trust is its own failure mode.

`UNKNOWN` is not a licence to stop reasoning, though, and getting *that* wrong is
the mirror image of the same bug. `notional_value` is `|size| × mark price`, so
it is never negative, which makes a partial sum a **lower bound** on the true
total. If that bound already exceeds the limit, nothing missing can bring it back
under — the breach is *proven*, and the guard fires on it. `UNKNOWN` is reserved
for the case where the missing values could still land either side of the limit.
The same argument run the other way covers flat positions: at `size == 0` the
notional is provably zero whatever the mark price is, so a dust position in an
unmirrored market is skipped rather than allowed to make `max-notional`
unprovable on every tick from then on.

**A signal must not abort the cancel.** This is where Python's specifics bite. A
signal handler that raises — which is what the default `KeyboardInterrupt`
does — can tear down whatever request is in flight, and under
[PEP 475](https://peps.python.org/pep-0475/) the interpreter runs the handler
*before* retrying a syscall a signal interrupted. So the obvious shape makes
Ctrl-C the thing that stops the risk-reducing request, which is a shutdown that
made the situation worse. Here the handler only sets a `threading.Event`; the
loop notices it between steps, and nothing raises into a request. A second signal
exits at once and says what that can cost.

"Not interruptible" is only an acceptable trade if the wait is a number you can
state. A tick makes at most three sequential requests — the two reads, then a
cancel they may have triggered — so `MAX_SHUTDOWN_WAIT_SECONDS` is derived as
`3 × REQUEST_TIMEOUT_SECONDS` (15s), printed in the shutdown message, and kept
inside the 30s that Kubernetes' `terminationGracePeriodSeconds` defaults to. It
is derived rather than written down twice, and a test asserts the relationship so
the README cannot drift from the code.

**There is no concurrency at all**, and that is worth saying plainly rather than
defending. `nexus_exchange.Client` is synchronous, so the loop is exactly what it
looks like: fetch, evaluate, act, sleep, on one thread. The Rust and TypeScript
siblings fetch the account and the open orders concurrently and have to explain
why that is safe; here the question does not arise. The cost is one extra
round-trip of skew between the two reads, which no limit depends on — the open
orders feed no limit, they are only the thing being cancelled.

## Two things the SDK will let you get wrong

Both were measured, not guessed, and both are pinned by tests so a version bump
cannot quietly undo them.

**`ApiError.transient` reports `429` as terminal.** It is
`status >= 500 or status == 408`, so a rate-limited poll looks permanent — and a
guard that stops on terminal errors would shut itself down the first time the
venue throttled it. A rate limit is the textbook *retryable* failure. So
`guard.is_transient` treats 429 as transient regardless of the flag, as a small
named exception rather than a blanket "retry everything", because the whole value
of the distinction is that a revoked credential still stops the guard.

**Passing a network *and* a base URL reports the wrong funds.**
`Client(Network.TESTNET, base_url=...)` routes requests at your override — but
`client.network` keeps the testnet descriptor, so the client goes on reporting
`label='Testnet'` and `funds=PLAY` for a host you supplied. Printing "play funds"
over an undeclared target is the one lie a risk tool must not tell. Both forms
send to the same place; only one of them tells the truth about it afterwards.

So `build_client` declares the target instead, with
`NetworkConfig.custom(label=..., funds=Funds.UNKNOWN, base_url=...)`. A lone
`base_url=` resolves to exactly that config and would do — but it is the
deprecated selector (ENG-10955), and it makes the funds classification something
the app inherits rather than something it states. Spelling it out is the same
shape [`sdk-mcp/risk-review`](../../sdk-mcp) uses for the same override.

## Prerequisites

- Python 3.12+. (The SDK requires 3.10+; CI installs and typechecks against 3.12.)
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).

## Running it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

export NEXUS_EXCHANGE_API_KEY=...      # see .env.example
export NEXUS_EXCHANGE_API_SECRET=...
export NEXUS_GUARD_MAX_LOSS=50

python guard.py
```

That is watch-only: it reports, and changes nothing. Add `--arm` to let a breach
cancel your resting orders:

```bash
python guard.py --arm
```

`--arm` is the whole command line; `--help` prints it. Anything else is
**refused** rather than ignored, because every near-miss for that one flag —
`--armed`, `-arm`, `--arm=true` — would otherwise leave you believing the guard
may act while it silently stayed watch-only, and a guard you think is armed and
is not is worse than no guard.

### Tests

```bash
python -m unittest -q
```

44 tests, no network and no credentials. Most are table-driven over `risk.py`,
which is pure. The rest run the real SDK against a **real HTTP server on the
loopback interface** rather than a mock — a mock of an SDK only proves the mock
matches the test's idea of it, while a socket proves the SDK composes the URL,
signs the request and decodes the body the way this app assumes. Both SDK traps
above were found that way.

CI runs them: the Python recipe ends with `unittest discover`, so a version bump
that undoes either trap fails the gate rather than only failing for whoever
happens to run the suite locally.

## Configuration

Credentials are **required** — this app watches your account, so there is no
useful public-data mode. Everything is read from the environment; nothing is read
from a committed file. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | Point at another deployment — the deployment base, not the `/api/v1` path |
| `NEXUS_GUARD_MAX_NOTIONAL` | one of these | Cap on total position notional |
| `NEXUS_GUARD_MAX_LOSS` | one of these | Cap on total unrealized loss, as a positive number |
| `NEXUS_GUARD_MIN_AVAILABLE_MARGIN` | one of these | Floor on available margin |
| `NEXUS_GUARD_INTERVAL_SECONDS` | no | Poll interval in whole seconds, 2–3600, default 15 |

At least one limit must be set. A guard with no limits would print reassuring
output forever while checking nothing, so it refuses to start instead.

Limits are parsed as exact decimals and must be greater than zero. Plain decimals
only: `1e5`, `nan`, `inf`, `1,000`, `1_000` and `١٠٠٠` are all refused rather
than guessed at, because `Decimal()` accepts every one of them with a
plausible-looking reading — `Decimal("nan")` compares false against everything,
which would make a limit that never fires, and `Decimal("١٠٠٠")` is 1000 in a
form nobody can check by eye — and this value decides whether the guard fires.
The poll interval is held to the same standard and bounded at both ends.

## Which deployment it talks to

**Testnet — play funds.** `Network.TESTNET` is named explicitly in `guard.py`
rather than left to the default, so nobody has to guess whose money this watches.
Its base already resolves to `https://exchange.nexus.xyz/api/exchange`, the
gateway base that serves the API, so no override is needed to reach the live
venue. `Network.MAINNET` needs no guard of our own: the SDK refuses to resolve a
base for it, locally, before any bytes leave the process.

`NEXUS_EXCHANGE_API_URL` points the client at another deployment. Pass the
deployment base; the SDK appends `/api/v1` itself. An overridden target reports
`funds=UNKNOWN` and the banner says so — see the second trap above for why the
obvious way to write this reports `play funds` instead.

## Pinned versions

Pinned to **`nexus-exchange` 0.4.0** (the Python SDK), with `mypy` 2.3.1.

There is no lockfile format to commit here, so `requirements.txt` is one: the
SDK's transitive tree is pinned by `==` too, at the versions this example was
verified against. A pin on the direct dependency alone is not reproducible — the
tree underneath it would still float, and a reader a year from now would get
different bytes than this README describes.

## Notes

- It is an example, not production-hardened code. It watches one account, keeps
  no state across restarts, and has no alerting beyond stdout and the exit code.
- Exit codes follow `sysexits.h`, matching the siblings so a supervisor sees the
  same number whichever one it runs: `0` clean shutdown, `77` `EX_NOPERM` for
  credentials, `65` `EX_DATAERR` for another terminal failure, `1` for a
  configuration error. A second signal forces the exit and reports itself the way
  a shell does, `128 + signum` — so `130` for Ctrl-C and `143` for a second
  SIGTERM, rather than one number standing in for both.
- A failed poll is never read as a clean bill of health — but "retry next tick"
  is only right for a *transient* failure. A terminal one fails identically
  forever, so the guard stops rather than sitting there logging the same 401 and
  still exiting `0`, which would mean nothing restarts it and nobody is told the
  account is now unwatched.
- Money is never a float. Values arrive as `Decimal` from the SDK and stay that
  way; a limit check is a comparison against a sum, which is exactly where binary
  floating point would decide the wrong way.
- `mypy.ini` sets `follow_untyped_imports`, and the reason is worth knowing.
  `nexus-exchange` 0.4.0 is fully annotated but ships no `py.typed` marker, so
  under PEP 561 a type checker ignores all of it: without that line `mypy .`
  reports one `import-untyped` error and then types every SDK value as `Any`. A
  `strict = True` gate that passes while checking nothing at the one boundary
  that matters is worse than no gate at all.
- There is no "already fired" latch. The condition is *breached and orders
  exist*, so a successful cancel makes the next tick a no-op by itself, while an
  order placed during a still-live breach is caught on the tick after it appears.
  A latch would have to be cleared by something, and every rule for clearing it
  is a rule that can be wrong.
- **Not verified: a breach firing against a funded account.** The cancel path is
  exercised against a stubbed venue, not a real one, because that needs a funded
  testnet account. The decision logic in `risk.py` is pure and reads top to
  bottom, and the cancel itself is one line. Flagged rather than left implicit.
- Not implemented, and out of scope: flattening positions, per-market limits,
  alerting, and `cancel-on-disconnect` (the API supports it, and it is the right
  server-side backstop for anything that must not outlive its process).
