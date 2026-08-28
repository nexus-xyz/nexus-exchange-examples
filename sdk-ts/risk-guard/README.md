# risk-guard

A standing risk guard for one Nexus Exchange account, built on the TypeScript
SDK.

It polls your account, checks it against limits you set, and — when armed —
cancels every resting order the moment a limit is breached.

```text
23:57:04  risk-guard on the testnet default host (play funds)
23:57:04  limits: max-notional, max-loss — polling every 15s
23:57:04  --arm: a breach will cancel every resting order on this account
23:57:04  ok  max-notional=within max-loss=within  resting=2
23:57:34  BREACHED  max-notional=within max-loss=breached  resting=2
23:57:34    max-loss: unrealized -61.40 (loss 61.40) vs limit 50
23:57:34    cancelled every resting order on this account (2 seen this tick)
```

This is the TypeScript member of a set: the same app, same limits and same
posture exist as `risk-guard` under [`sdk-rust/`](../../sdk-rust) and
[`sdk-python/`](../../sdk-python), and as `risk-review` over MCP under
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
`cancelAllOrders`. The app never places an order, never amends one, and
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
attention. So `src/risk.ts` reports `within`, `breached` or `unknown`, and
`unknown` never counts as safe. It also never fires the guard: acting on data the
app does not trust is its own failure mode, so it says the limit cannot be proven
and leaves it to a human.

`unknown` is not a licence to stop reasoning, though, and getting that wrong is
the mirror image of the same bug. `notional_value` is `|size| × mark price`, so
it is never negative, which makes a partial sum a **lower bound** on the true
total. If that bound already exceeds the limit, nothing missing can bring it back
under — the breach is *proven*, and the guard fires on it. `unknown` is reserved
for the case where the missing values could still land either side of the limit.
The same argument run the other way covers flat positions: at `size == 0` the
notional is provably zero whatever the mark price is, so a dust position in an
unmirrored market is skipped rather than allowed to make `max-notional`
unprovable on every tick from then on.

**Shutdown must not abort the cancel.** The stop signal ends the loop and unwinds
the sleep, but it is deliberately never passed to the cancel request — a shutdown
that aborts the risk-reducing action is a shutdown that made things worse. Reads
take the signal; the cancel does not. A second Ctrl-C exits at once and says what
that can cost.

"Not interruptible" is only an acceptable trade if the wait is a number you can
state, and `timeoutMs` is *not* that number — it bounds one **attempt**. The SDK
retries transient failures on every method in its `IDEMPOTENT_METHODS` set, and
`DELETE` is one of them, so the cancel retries exactly like a read: on the SDK's
defaults that is three attempts and the panic button can sit there for ~46s, not
~15s. So this app sets the retry policy instead of inheriting it — one retry, a
5s per-attempt timeout — and derives `MAX_CALL_MS` (~10s) from those two
constants in `src/index.ts` rather than asserting a number that can drift. One
honest caveat, stated in the code too: on a `429` the SDK honours the server's
`Retry-After` instead of its own backoff, clamped to 60s, so a rate-limited
cancel is bounded by the server rather than by this app.

Beyond that there is no concurrency to get wrong, by design: the loop is strictly
sequential — fetch, evaluate, act, sleep — so a tick cannot overlap the previous
one, there is no shared mutable state and nothing to deadlock on. The one
concurrent step is fetching the account and the open orders together, safe
precisely because the open orders feed no limit; they are only the thing being
cancelled.

## Prerequisites

- Node 22+.
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).

## Running it

```bash
npm install
cp .env.example .env      # then add your key, secret and at least one limit
npm start
```

That is watch-only: it reports, and changes nothing. Add `--arm` to let a breach
cancel your resting orders:

```bash
npm start -- --arm
```

`--arm` is the whole command line; `npm start -- --help` prints it. Anything else
is **refused** rather than ignored, because every near-miss for that one flag —
`--armed`, `-arm`, `--arm=true` — would otherwise leave you believing the guard
may act while it silently stayed watch-only, and a guard you think is armed and
is not is worse than no guard.

## Configuration

Credentials are **required** — this app watches your account, so there is no
useful public-data mode. Everything is read from the environment; nothing is read
from a committed file. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | Point at another deployment (see below) |
| `NEXUS_GUARD_MAX_NOTIONAL` | one of these | Cap on total position notional |
| `NEXUS_GUARD_MAX_LOSS` | one of these | Cap on total unrealized loss, as a positive number |
| `NEXUS_GUARD_MIN_AVAILABLE_MARGIN` | one of these | Floor on available margin |
| `NEXUS_GUARD_INTERVAL_SECONDS` | no | Poll interval in whole seconds, 2–3600, default 15 |

At least one limit must be set. A guard with no limits would print reassuring
output forever while checking nothing, so it refuses to start instead.

Limits are parsed as exact decimals and must be greater than zero. Plain decimals
only — `1e5`, `NaN` and `1,000` are all refused rather than guessed at, because
each has a plausible-looking parse and this value decides whether the guard
fires.

The poll interval is held to the same standard, which `Number()` is far too
generous to enforce on its own: it reads `1e5` as 100000 and `0x1e` as 30, and
`Number.isInteger` agrees with both. It is also bounded above, not only below.
`setTimeout` silently clamps any delay past 2³¹-1 ms to **1 ms** and warns, so an
unbounded interval does not merely make the guard sleep forever — past ~24.8 days
it inverts into a hot loop hammering the API, which is the exact failure the
minimum exists to prevent, reached from the other end.

## Which deployment it talks to

**Testnet — play funds.** `Network.Testnet` is named explicitly in `src/index.ts`
rather than left to the default, so nobody has to guess whose money this watches.
Selecting `Network.Mainnet` is rejected by the SDK locally, before any bytes
leave the process.

`NEXUS_EXCHANGE_API_URL` goes through `customNetwork({ label, baseUrl, funds })`
rather than the deprecated bare `baseUrl`, because a URL on its own cannot say
what the target moves — the descriptor carries `funds` along with the transport,
so no guardrail can read a play-funds classification off a client pointed
somewhere else. An overridden target is `funds: "unknown"`, and the app says so
on its first line rather than printing "play funds" at a host nobody declared.
That value is the deployment base (e.g. `https://<host>/api/exchange`); the
client adds the `/api/v1` prefix itself.

## Pinned versions

Pinned to **`@nexus-xyz/exchange-ts` 0.3.0**, exact version, with
`package-lock.json` committed.

> 0.3.0 matters specifically: 0.2.0 could not reach the live deployment at all —
> it sent `/api/v1` to the host root, which serves the marketing frontend, and
> refused the gateway base that answers. 0.3.0 split the deployment base from the
> signed path ([`nexus-exchange-ts#65`](https://github.com/nexus-xyz/nexus-exchange-ts/pull/65))
> and fixed it. There is no configuration of 0.2.0 that works, so do not pin
> this example back.

## Notes

- It is an example, not production-hardened code. It watches one account, keeps
  no state across restarts, and has no alerting beyond stdout.
- Money is never a float. Values arrive as decimal strings and are parsed by
  `src/decimal.ts` onto `BigInt`; a limit check is a comparison against a sum,
  which is exactly where binary floating point would decide the wrong way.
- A failed poll is never read as a clean bill of health — but "retry next tick"
  is only right for a *transient* failure. A terminal one (revoked credentials
  above all) will fail identically forever, so the guard stops and exits with a
  `sysexits.h` code: `77` `EX_NOPERM` for credentials, `65` otherwise. Staying
  alive logging the same 401 every tick and still exiting `0` is the worst
  failure this app could have — nothing restarts it, and nobody is told the
  account is now unwatched. The SDK classifies this for us on
  `NexusExchangeError.transient`, the same flag its own retry layer uses.
- Bad configuration is reported as configuration, never as a stack trace.
  `NEXUS_EXCHANGE_API_URL` is the one value that cannot be checked without the
  SDK — the rules for a base URL are the SDK's — so its rejection is caught and
  re-reported where every other bad setting is handled. Worth knowing if you
  copy this code: `NexusExchangeError` is the *base class* of `ApiError` and
  `TransportError`, so catching those two does not catch a local validation
  failure, and it escapes as an unhandled rejection.
- There is no "already fired" latch. The condition is *breached and orders
  exist*, so a successful cancel makes the next tick a no-op by itself, while an
  order placed during a still-live breach is caught on the tick after it appears.
  A latch would have to be cleared by something, and every rule for clearing it
  is a rule that can be wrong.
- Not implemented, and out of scope: flattening positions, per-market limits,
  alerting, and `cancel-on-disconnect` (the API supports it, and it is the right
  server-side backstop for anything that must not outlive its process).
