# trading-terminal

A terminal trading desk for one market, built **directly on the Exchange API** —
raw REST and WebSocket, no SDK. It signs its own requests, keeps a local order
book it knows when to distrust, and can rest a single order and guarantee it is
cancelled before the process exits.

It exists to show the wire contract end to end: if you are writing a client in a
language Nexus does not ship one for, everything you need to get right is in
here — about 1,700 lines of TypeScript, with another 700 of comments explaining
*why*, and **zero runtime dependencies**: just `fetch` and `WebSocket` from the
Node standard library.

## What it does

Read-only by default. It fetches the market's trading rules, snapshots the order
book, then keeps it live — over the WebSocket when one is configured, otherwise
by polling REST — and prints top of book whenever it moves.

```
21:13:23  Nexus Exchange trading terminal — https://exchange.nexus.xyz/api/exchange (play funds)
21:13:23  market: BTC-USDX-PERP
21:13:23  tick=0.5 lot=0.001 size=[0.001, 100]
21:13:23  BTC-USDX-PERP  bid 62821.5 × 0.001  ask 62881.0 × 0.05  mid 62851.0  spread 59.5  live
21:13:26  BTC-USDX-PERP  bid 62820.0 × 0.001  ask 62879.5 × 0.05  mid 62849.5  spread 59.5  live
21:13:30  shutting down (SIGINT)
```

With `--trade` it also places exactly one order — a `PostOnly` buy 2% below the
mid, sized at the venue minimum — reports fills, and cancels it on exit.

`STALE` in place of `live` means the book is no longer trustworthy (the stream
dropped, a gap was signalled, or nothing has updated for ten seconds). The app
will not place an order against a stale book.

## Prerequisites

- **Node 22.4 or later.** It uses `process.loadEnvFile` (Node 22) and the global
  `WebSocket` (unflagged from 22.4), so there is nothing to install at runtime.
  Tested on Node 25.2; CI builds on 22.
- **Optional: Nexus Exchange testnet API credentials** — create them in the
  [Exchange app](https://exchange.nexus.xyz). The dashboard runs without any.
  You need them for the WebSocket (its upgrade token comes from a signed call)
  and for `--trade`.

## Pinned versions

There is no SDK to pin, so what this example pins is **the API contract itself:
spec `v0.8.1`**, from
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api/releases/tag/v0.8.1),
sent on every request as `X-Nexus-Api-Version: v0.8.1`. It targets **testnet** —
play funds, credited by the faucet, with no real-world value.

The toolchain is pinned exactly (no `^`): `typescript` `7.0.2`, `tsx` `4.23.8`,
`@types/node` `26.1.2`. `package-lock.json` is committed and CI installs from it
with `npm ci`.

## Setup

```bash
npm install
cp .env.example .env   # optional — only for the WebSocket and --trade
```

## Run

```bash
npm start
```

Then, once you have credentials in `.env` and want to see the write path:

```bash
npm start -- --trade
```

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | no | API key id. Without it, public market data only. |
| `NEXUS_EXCHANGE_API_SECRET` | no | API secret (hex) paired with the key. |
| `NEXUS_EXCHANGE_API_URL` | no | REST base. Defaults to `https://exchange.nexus.xyz/api/exchange`. Must **not** include `/api/v1` — see below. |
| `NEXUS_EXCHANGE_WS_URL` | no | WebSocket endpoint, e.g. `wss://<host>/ws`. Unset ⇒ REST polling. |
| `NEXUS_EXCHANGE_FUNDS` | no | `play` \| `real` \| `unknown`. Only needed for a host this example does not recognise. |
| `NEXUS_MARKET` | no | Market id. Defaults to `BTC-USDX-PERP`. |
| `NEXUS_ORDER_DISTANCE_BPS` | no | How far below the mid `--trade` rests, in bps. Defaults to `200`. |
| `NEXUS_ORDER_QUANTITY` | no | Order size. Defaults to the market minimum. |

Setting both credentials, or neither, is enforced — half a pair is always a
mistake, and the failure it produces otherwise is an opaque `401`.

## About the host

Three things about the current testnet deployment will cost you an afternoon if
you discover them yourself. All three were measured against the live host, not
inferred from the spec.

**1. The API is under `/api/exchange`, not at the host root.**

```
https://exchange.nexus.xyz/api/exchange/api/v1/markets/summary  → 200, JSON
https://exchange.nexus.xyz/api/v1/markets/summary               → 404, an HTML page
```

The `/api/v1` surface is mounted *under* the gateway prefix on this deployment.
Point a client at the host root and every call returns the marketing site's 404
page. That is why `NEXUS_EXCHANGE_API_URL` defaults to the gateway base, and why
the app refuses a base URL ending in `/api/v1` rather than sending
`/api/v1/api/v1/...`.

**2. You sign the path the *indexer* sees, not the path in your URL.**

The gateway strips its own `/api/exchange` prefix before the request reaches the
service that verifies your signature. So a request sent to
`…/api/exchange/api/v1/orders` is verified as `/api/v1/orders`, and that — with
the `/api/v1`, without the gateway prefix — is what goes in the canonical
string. Sign the URL's full path instead and you get a `401` that looks exactly
like a bad secret. (Host-root routes such as `/ws/token` are signed bare, for
the same reason.)

**3. Testnet has no reachable WebSocket origin right now.**

The spec publishes `wss://api.testnet.nexus.xyz` for testnet, but that hostname
does not resolve yet, and the `/api/exchange` gateway is a serverless function
that cannot proxy a WebSocket upgrade — an upgrade request to it answers `400`
rather than `101`. The two ends have to move together: an upgrade token is
minted over REST and is scoped to the origin that issued it, so pairing today's
REST host with tomorrow's WebSocket host would present a token to a server that
never issued it.

So this app **will not guess a WebSocket origin.** Leave `NEXUS_EXCHANGE_WS_URL`
unset and it polls REST, which is why the dashboard works today. Set it when a
reachable origin exists — or point it at a local stack — and the streaming path
lights up with no other change. The protocol implementation in
[`src/stream.ts`](./src/stream.ts) is written against spec `v0.8.1`; it has been
exercised against the token-mint and failure paths on the live host, but not
against a live upgrade, because there is not one to reach.

## How it works

Eight small files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`signing.ts`](./src/signing.ts) | The HMAC-SHA256 canonical string, and the three traps that each produce an identical `401`. |
| [`decimal.ts`](./src/decimal.ts) | Exact money arithmetic on `BigInt`. |
| [`config.ts`](./src/config.ts) | Environment parsing, and every guard that can be applied before a request exists. |
| [`rest.ts`](./src/rest.ts) | One hardened request: deadlines, bounded bodies, retry policy, rate limiting. |
| [`stream.ts`](./src/stream.ts) | The `op`-envelope WebSocket protocol, reconnection, resume cursors, and duplicate suppression. |
| [`book.ts`](./src/book.ts) | Local book state, and when it may be trusted. |
| [`trader.ts`](./src/trader.ts) | The write path — one order, at most once, always cancelled. |
| [`index.ts`](./src/index.ts) | Wiring and lifecycle. |

Four decisions are worth copying into whatever you build:

**Money is never a float.** The API is deliberately two-faced about numbers:
what you *send* is a lossless decimal string, what you *read* on the CCXT-shaped
market-data routes is a JSON double. So a price arrives as a double and has to
leave as an exact decimal. `decimal.ts` handles the crossing by snapping to the
market's tick or lot grid at the boundary and staying on integers afterwards, so
every price sent is an exact multiple of the tick — which is the only thing the
venue accepts anyway. Rounding is always `floor` or `ceil`, never "nearest":
rounding a bid to the *nearest* tick can move it across the spread and turn a
maker order into a taker.

**A timeout is not a rejection.** `POST /orders` is never retried. The API has
no client-supplied idempotency key, so a second attempt after a timeout is how
one intended order becomes two real ones. When the outcome is unknown the app
asks the exchange what happened (`GET /orders`, matched on what it sent) rather
than guessing — and if it still cannot tell, it says so and lets the exit
cancel-all clean up. Retries are opt-in per call and only for genuinely
repeatable ones.

**Stale data is worse than no data.** The book carries an explicit freshness
verdict, and `--trade` refuses to act unless it is fresh. Anything that could
have cost continuity — a reconnect, an `out_of_sync` frame, a payload shape the
app does not recognise, ten seconds of silence — marks it stale and triggers a
throttled REST re-snapshot. A crossed book counts as untrustworthy too: it
yields a mid inside no real spread.

**Shutdown outlives the stop signal.** This one is a bug worth naming, because
it is easy to write and invisible once written. If the REST client watches the
same `AbortSignal` that Ctrl-C trips, then the first thing shutdown does is
guarantee the cancel-the-order request cannot be sent. So there are two stages:
`stopping` ends the loops, and only after teardown finishes does `halted` close
the request path. Every exit route converges there — `SIGINT`, `SIGTERM`, an
uncaught exception, an unhandled rejection — under a hard deadline, and a second
Ctrl-C exits immediately while saying plainly that an order may survive.

Also worth a look, briefly: redirects are refused rather than followed, because
`fetch` forwards custom headers across an origin change and would hand a valid
signature to another host; response bodies are read with a byte cap and their
content type checked before parsing, so the HTML-404 case produces a diagnosis
instead of a `JSON.parse` error; the WebSocket refuses a cleartext `ws://` to
anything but loopback, since the upgrade token rides in the query string; a
client-side token bucket keeps the app inside its tier; and clock skew is read
off the server's `Date` header, because signatures are only valid for ±30
seconds and a drifting clock fails every signed call with a `401` that looks
exactly like a bad secret.

### On concurrency

Node is single-threaded, so there are no locks here and nothing can deadlock.
The hazards that *are* real in an async client are these, and each is handled at
the point it arises:

- **Stale socket callbacks.** A replaced socket can still fire `onclose` after
  the next one is open. Every handler is fenced behind `this.socket === socket`,
  so a dead connection cannot start a second reconnect loop.
- **A silently half-open connection.** TCP will not tell you the peer is gone;
  `onclose` simply never fires. A liveness watchdog treats a long silence as
  death and forces the reconnect the socket declined to trigger.
- **Redelivery across a reconnect.** A resubscribe is a join, and a join can
  hand back frames the previous connection already delivered — nothing
  acknowledges frames, so a server backfilling from its own checkpoint is
  backfilling from a point behind ours. An event stream is not idempotent at the
  consumer: rendering the same `fills` frame twice is a fill that never
  happened. So `stream.ts` keeps a per-channel high-water mark that it will
  raise but never lower, and drops anything that does not advance it. It lives
  in the stream rather than in each consumer, so a fifth channel added later is
  covered without having to know it needed to be. The one thing a never-lowered
  mark costs is recovery from a server that restarts its numbering, so a long
  run of suppressed frames resets the filter and signals a gap rather than
  letting a channel go quiet while traffic is still arriving.
- **Overlapping work.** Single-flight guards, not hopeful `if` checks: one
  in-flight snapshot, one poll loop, one placement. The placement guard
  specifically covers the window where the request has been sent and the reply
  has not arrived — which is the window a `if (orderId === null)` test leaves
  wide open.
- **Unbounded growth.** Re-snapshots have a floor on frequency, so a stream of
  frames the app cannot parse becomes a slow poll rather than a REST flood.
- **Reconnect storms.** Exponential backoff with equal jitter, bounded to
  `[ceiling/2, ceiling]` so it is never zero and never synchronised across
  clients. A permanently failing mint (`401`) gives up at once instead of
  retrying six times to get the same answer. Only a connection that *stayed up*
  clears the failure count — resetting it the moment a socket opens looks right
  and is not, because a server that completes the upgrade and then drops the
  connection would reset the backoff on every attempt and never escalate.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **The streaming path has not been exercised against a live upgrade**, because
  testnet does not currently serve one — see "About the host". The REST path,
  the token mint, the write path and every failure branch were run end to end
  against the live host.
- The `book` channel's payload is forwarded verbatim by the API and is not
  pinned by the spec, so this app applies the documented snapshot shape and
  falls back to a REST re-snapshot for anything else, rather than guessing at a
  delta encoding. If that channel turns out to publish deltas, the cost is
  freshness, not correctness.
- `--trade` places one order per process, deliberately. It is a demonstration of
  the write path, not a strategy: it rests far from the mid, expects not to
  fill, and cancels on the way out.
- Not implemented, and out of scope: position and margin management, order
  amendment, `cancel-on-disconnect` (the API supports it — see
  `PUT /account/cancel-on-disconnect` — and it is the right server-side backstop
  for a real bot), and any persistence across restarts.
