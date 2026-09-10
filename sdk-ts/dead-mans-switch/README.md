# dead-mans-switch

A session supervisor that proves cancel-on-disconnect, built on the TypeScript
SDK.

It arms cancel-on-disconnect, opens the authenticated WebSocket the venue keys
that setting off, rests one order — and then **kills its own trading session
with SIGKILL** and watches the exchange cancel the order on its behalf.

```text
02:41:07  dead-mans-switch on https://api.testnet.nexus.xyz/indexer (testnet, play funds)
02:41:07  --live: this run arms cancel-on-disconnect and places one real order
02:41:07  cancel-on-disconnect: enabled=false active=false grace=10s — not opted in
02:41:08  plan: BTC-USDX-PERP Buy 0.001 @ 74878.5 PostOnly (mark 77998.325, -400bps, band 500bps)
02:41:08  armed: cancel-on-disconnect: enabled=true active=true grace=10s — the venue will cancel for you
02:41:08  spawning the session — it will place one order and then be killed
02:41:09    session: ws open at wss://api.testnet.nexus.xyz/indexer/ws — this is the connection COD watches
02:41:09    session: placed 0c41f6b2… status=Open
02:41:09    session: session is idle and holding the socket. Waiting to be killed.
02:41:09  confirmed over REST: 0c41f6b2… is resting
02:41:09  SIGKILL -> session pid 48211 (nothing in it gets to run)
02:41:09  session gone: code=null signal=SIGKILL
02:41:09  watching 0c41f6b2… — venue grace is 10s, giving up after 40s
02:41:21  PROVEN: 0c41f6b2… was cancelled 11.4s after the kill, by the venue.
02:41:21    Nothing this app runs did that — the process that placed it no longer exists.
02:41:21  restored: cancel-on-disconnect: enabled=false active=false grace=10s — not opted in
```

## What it does, and what you learn from it

Every other write example in this catalog cancels its own orders in a `finally`.
That covers a clean exit, and a clean exit is not the interesting case. This is
the failure mode where the process is simply *gone* — SIGKILL, a lost network,
an evicted container — and the only thing left that can cancel your orders is
the exchange.

It is the first example in the catalog about a control the **venue** runs for
you rather than one you run yourself, and everything about its shape follows
from having to prove that honestly.

### It is two processes, and it has to be

- **`src/session.ts`** is the trading session. It opens the authenticated
  WebSocket, places one resting order, tells its parent the order id, and then
  waits to die. It contains no cleanup of any kind — no `finally`, no signal
  handler, no `exit` hook. That absence is the point: a cleanup path in there
  would make a passing run prove that cleanup paths run.
- **`src/index.ts`** is the supervisor. It arms cancel-on-disconnect, spawns the
  session, **SIGKILLs it**, and then watches an order that no live process is
  managing any more.

One process could not do this. If the process that places the order is also the
one that reports the outcome, then either it survived the kill — so the kill was
not real — or it did not, and there is nobody left to tell you what happened.

The split also puts the safety net in the right place. The supervisor never
holds a WebSocket, so its own liveness is invisible to the venue's view of the
account, and it is still running when the demonstration ends. If
cancel-on-disconnect does *not* fire, the supervisor cancels the order itself
and reports the demonstration as failed. An example that can leave a resting
order behind on a venue is not one anybody should run.

### `enabled`, `active` and `grace_secs` are three states, not two

`GET /account/cancel-on-disconnect` returns all three, and the app prints all
three on every line that mentions COD:

| Field | What it means |
| --- | --- |
| `enabled` | Your account's own opt-in. It is off by default and you set it. |
| `active` | `enabled` **and** the exchange-side feature switch. This is the one that decides whether a disconnect cancels anything. |
| `grace_secs` | The reconnect window. `null` means the feature is unavailable on this deployment, which is a third thing again. |

Reading `enabled` and reporting "you're covered" is wrong, and it is wrong in
the worst available direction: `enabled && !active` is exactly the state where
somebody stops cancelling their own orders because they believe the venue is
doing it. So `--live` **refuses to place anything when `active` is false**, and
says why. There is no client-side setting that changes it — the switch belongs
to the deployment.

That refusal is not hypothetical. The exchange-side switch (`COD_ENABLED`) ships
**off by default** — the venue's own design note calls it "ship dark", because
enabling COD for everyone at once risks mass-cancelling real books on a benign
disconnect. Run the dry run first; it tells you which of the three states this
deployment and this account are in before you ask for anything.

### The order is chosen so it cannot become a position

One order, and three properties, each for a different reason:

- **`PostOnly`**, so it can only ever join the book. The engine refuses a
  post-only order that would cross rather than crossing it.
- **Priced 400 bps below the mark**, far enough that nothing trades down into it
  during a run that lasts under a minute — and inside the market's
  `price_band_bps` collar, which refuses any limit price further from the mark
  than that (500 bps on the testnet perps today). `src/plan.ts` checks your
  offset against the *live* band and refuses rather than letting the venue
  reject the order.
- **`min_order_size`**, the smallest the market allows. The point is to have *an*
  order resting; the margin it consumes should be as close to nothing as the
  venue permits.

The price is computed on exact decimals (`src/decimal.ts`, `BigInt`) and floored
onto the tick grid. Flooring is the direction chosen deliberately: it moves a bid
further from a fill and further inside the band it was just checked against.

### The account has to be empty first

Cancel-on-disconnect cancels **every** resting order on the account when it
fires, not the one this app placed. So `--live` reads `GET /orders` before
arming anything and refuses if the book is not empty. Running the demonstration
on a working account would destroy somebody's orders to prove a point about a
different one.

### The WebSocket token is minted per connection, never cached

WS tokens are single-use and expire in 60 seconds, and they are scoped to the
host that minted them. The session therefore passes `client.wsTokenProvider()`
to `createWsClient` rather than a token: the provider is called on every
(re)connect, which is exactly a ws token's lifetime. A supervisor that cached
one comes back **unauthenticated** after its first reconnect — and an
unauthenticated connection is one the venue is no longer watching on your
behalf, which is the failure this whole feature exists to prevent, arriving
silently.

The session also waits for `ws.status() === "open"` before placing. The upgrade
only succeeds with a valid token, so that is the point at which the session is
known to be both connected and authenticated. Placing the order the moment
`createWsClient` returns would rest it with no connection for the venue to
watch, and the run would then "pass" for the wrong reason.

## Prerequisites

- Node 22 or later (tested on Node 22 and 26). The SDK's WebSocket client uses
  the runtime's global `WebSocket`, which Node has unflagged since 22.4.
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).
- An account with **no resting orders** — see above.

## Setup

```bash
npm install
cp .env.example .env      # then add your testnet key and secret
```

## Run

```bash
npm start
```

That is the **dry run**, and it is the default: it reads the account's
cancel-on-disconnect status, prices the order it would place, and reports every
refusal it would hit. It writes nothing and places nothing.

The demonstration itself is an explicit opt-in:

```bash
npm start -- --live
```

`--live` is the whole command line besides `--help`; `npm start -- --help`
prints it. Anything else is **refused** rather than ignored.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Dry run completed, or the venue cancelled the order — proven. |
| `1` | Configuration, planning, or venue error. |
| `2` | Refused before placing anything: COD not `active`, or the account already had resting orders. |
| `3` | The demonstration ran and the venue did **not** cancel within the deadline. This app cancelled the order itself. |
| `130` | Interrupted. Cleanup ran. |

## Configuration

Credentials are **required**. Everything is read from the environment; nothing
is read from a committed file. See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | REST deployment base (see below) |
| `NEXUS_EXCHANGE_WS_URL` | no | WebSocket base, prefix included. Defaults to the REST base with the scheme swapped |
| `NEXUS_DMS_MARKET` | no | Market for the one resting order. Default `BTC-USDX-PERP` |
| `NEXUS_DMS_PRICE_OFFSET_BPS` | no | How far below the mark to rest, in bps. Default 400, checked against the live price band |
| `NEXUS_DMS_WATCH_SLACK_SECONDS` | no | Extra wait past the venue's grace window, 5–600, default 30 |

## Which deployment it talks to

**Testnet — play funds.** The default base is
`https://api.testnet.nexus.xyz/indexer`, spelled out in `src/config.ts`.

That is a deviation from what every other example here does, and it is
deliberate rather than sloppy. `@nexus-xyz/exchange-ts` 0.4.0 ships
`https://exchange.nexus.xyz/api/exchange` as `Network.Testnet`, and that host
returns **HTTP 500 on every route** — it proxies to a decommissioned service.
Naming `Network.Testnet`, as CONTRIBUTING asks, would produce an example that
cannot reach the venue at all.
[`nexus-exchange-ts#78`](https://github.com/nexus-xyz/nexus-exchange-ts/pull/78)
moves the constant to the durable host; until a release carries it, the host is
named here instead. When it lands, this app should go back to
`network: Network.Testnet` and delete both constants.

The `/indexer` prefix is load-bearing. Measured 2026-09-09:

| URL | |
| --- | --- |
| `https://api.testnet.nexus.xyz/indexer/markets` | 200 |
| `https://api.testnet.nexus.xyz/markets` | **404** |
| `wss://api.testnet.nexus.xyz/indexer/ws` | upgrades (400 without a token) |
| `wss://api.testnet.nexus.xyz/ws` | **404** |
| `https://exchange.nexus.xyz/api/exchange/api/v1/markets` | **500** — the base the SDK ships |

**The WebSocket URL is built by this app, not by the SDK, and that is the second
half of the same problem.** In 0.4.0 `Client.wsUrl` is the REST *origin* with
the scheme swapped, and `customNetwork` refuses a `wsUrl` that carries a path at
all ("wsUrl must be an origin with no path"). Against this deployment that
yields `wss://api.testnet.nexus.xyz/ws`, which 404s. So `src/config.ts` derives
the WS base from the REST base **keeping the prefix**, and hands it to
`createWsClient`, which takes a free-form `url` and does not go through the
network descriptor. Without that, the authenticated socket never opens — and
with no socket there is no connection for cancel-on-disconnect to key off, so
the example would have nothing to demonstrate.

`NEXUS_EXCHANGE_API_URL` goes through `customNetwork({ label, baseUrl, funds })`
rather than the deprecated bare `baseUrl`, because a URL on its own cannot say
what the target moves. The default host is declared `funds: "play"` — it is
testnet and this example is the thing declaring it. An override is
`funds: "unknown"`, and the app's first line says so rather than printing "play
funds" at a host nobody declared.

**Mainnet is not reachable and this example does not try.** `api.nexus.xyz` has
no DNS record, and the SDK refuses `Network.Mainnet` locally, before any bytes
leave the process.

## Pinned versions

Pinned to **`@nexus-xyz/exchange-ts` 0.4.0**, exact version, with
`package-lock.json` committed. 0.4.0 is compiled against Exchange API spec
**v0.8.1**, which is where `GET`/`PUT /account/cancel-on-disconnect`,
`POST /ws/token` and the three-field `CancelOnDisconnectStatus` come from.

Do not pin this example back to 0.3.0: `getCancelOnDisconnect` /
`setCancelOnDisconnect` are not in it.

## When it does not fire

`NOT PROVEN` (exit 3) means the order was still resting when the deadline
passed. The app cancels it and stops. The usual causes, in the order worth
checking:

- **The exchange-side switch is off.** This is caught before anything is placed
  — `active` would have been false and the run would have exited 2 — so if you
  reached `NOT PROVEN`, this is not it.
- **The account has another WebSocket open.** Cancel-on-disconnect fires when
  the account's *last* connection drops. A browser tab logged into the same
  account, or another client, keeps the count above zero and nothing arms. This
  is the most common cause by a distance.
- **The venue's indexer has more than one replica without connection affinity.**
  The per-account connection count is in-memory per replica, so an account whose
  connections span replicas can see a "last drop" that is not one.
- **The grace window is longer than this app waited.** `grace_secs` is read from
  the venue, and `NEXUS_DMS_WATCH_SLACK_SECONDS` is added on top; raise the
  slack if the deployment is slow rather than lowering your expectations.

## Notes

- It is an example, not production-hardened code. It runs one demonstration and
  exits; it keeps no state and has no alerting beyond stdout.
- **Cancel-on-disconnect covers WebSocket sessions only.** A client that trades
  purely over REST and never opens `/ws` has no connection to drop, so it is not
  covered — there is no REST dead-man switch. This example holds the socket
  precisely because that is the thing being watched.
- Money is never a float. Prices arrive as decimal strings and are parsed by
  `src/decimal.ts` onto `BigInt`. `src/decimal.ts` is a trimmed copy of the same
  idea in [`risk-guard`](../risk-guard); examples are self-contained by design
  (CONTRIBUTING § 1), so it is copied rather than imported from next door.
- **The account's COD setting is restored on exit**, but only if this app was
  the one that changed it. If it was already enabled, it is left enabled.
- `src/plan.ts` reads `price_band_bps` off the market structurally rather than
  through the SDK's typed model, which does not carry the field yet. Its absence
  downgrades to "could not check" rather than to a silent assumption — casting
  the model to claim the field exists would make a server that omits it compare
  `undefined > number`, which is `false`, and the check would pass by accident.
- If you SIGKILL the **supervisor** as well, the session is orphaned and keeps
  its socket open, so nothing fires until that process also dies. At which point
  cancel-on-disconnect cancels the order — which is the feature working, with
  nobody left to report it.
- Runs against **testnet** (play funds). With `--live` it places one real order
  there.
