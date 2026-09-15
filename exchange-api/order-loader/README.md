# order-loader

A bulk order loader for the Exchange, built **directly on the Exchange API** —
raw REST, no SDK. It reads a file of orders, refuses the ones the venue would
reject before sending anything, submits the rest through `POST /orders/batch` in
weight-optimal chunks, **paces itself against budgets it reads from the venue
rather than numbers it hardcodes**, and guarantees everything it placed is
cancelled before the process exits.

It exists because the rate-limit model is the thing the API spec spends the most
words on and the thing hand-written clients most reliably get wrong. The rules
are not hard, but almost none of them is what you would assume, and every one of
them is invisible until you are being refused at three in the morning. This app
is the model written out in code.

**It dry-runs by default.** Without `--submit` it sends no write of any kind: it
reads public market data, validates your file, prints exactly what it would do
and what that would cost, and stops.

## What it does

```
14:22:07  Nexus Exchange order loader — https://api.testnet.nexus.xyz/indexer (play funds)
14:22:07  order file: …/exchange-api/order-loader/orders.example.json
14:22:07  run id: 4f1c8a2e (client_id prefix "ol-4f1c8a2e-")
14:22:07  budget request 20/s, using 16.0/s (server)
14:22:07  budget order   20/s, using 16.0/s (server)
14:22:07  budget cancel  20/s, using 16.0/s (server)
14:22:07  tier: pro
14:22:08  markets: BTC-USDX-PERP, ETH-USDX-PERP, SOL-USDX-PERP

  #  0 BTC-USDX-PERP  Buy       0.001 @      62000.0  PostOnly  notional≈62.0000
  #  1 BTC-USDX-PERP  Buy       0.001 @      61500.0  PostOnly  notional≈61.5000
  …

14:22:08  plan: 8 order(s), 1 batch(es) of up to 39, 3 preview(s) (policy "first-per-market")
14:22:08  cost: previews and submits are both charged to the trading bucket, so this run needs 3 + 1 trading unit(s) at minimum
14:22:08  DRY RUN — nothing was sent. Re-run with --submit to place these orders.
```

A file the venue would reject never becomes a request:

```
  #  0 REJECTED  price 62000.3 is not a multiple of the 0.5 tick; nearest legal are 62000.0 and 62000.5
  #  1 REJECTED  unknown market DOGE-USDX-PERP; the venue lists BTC-USDX-PERP, ETH-USDX-PERP, SOL-USDX-PERP
  #  4 REJECTED  quantity 0.05 is not a multiple of the 0.1 lot size
error: 5 of 5 order(s) in the file are not placeable. Nothing was sent.
```

With `--submit` it previews the orders worth previewing, submits the batches,
reports what each order did, and cancels every order it placed on the way out —
on a clean finish, on an error, and on Ctrl-C.

## Prerequisites

- **Node 22.4 or later.** It uses `process.loadEnvFile` (Node 22), and there is
  nothing to install at runtime: **zero runtime dependencies**, just `fetch` from
  the Node standard library. Tested on Node 25.2; CI builds on 22.
- **A Nexus Exchange testnet API key**, for `--submit` and for reading your
  budgets — create one in the [Exchange app](https://exchange.nexus.xyz). The
  dry run works without any.

## Pinned versions

There is no SDK to pin, so what this example pins is **the API contract itself:
spec `v0.8.1`**, from
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api/releases/tag/v0.8.1),
sent on every request as `X-Nexus-Api-Version: v0.8.1`. It targets **testnet** —
play funds, credited by the faucet, with no real-world value. It will not run
against mainnet: the mainnet host is refused by name in `config.ts`.

The toolchain is pinned exactly (no `^`): `typescript` `7.0.2`, `tsx` `4.23.8`,
`@types/node` `26.1.2`. `package-lock.json` is committed and CI installs from it
with `npm ci`.

## Setup

```bash
npm install
cp .env.example .env   # optional — only needed for --submit
```

## Run

```bash
npm start
```

That is the dry run, and it is the whole of what most readers need. To actually
place the orders, once you have credentials in `.env`:

```bash
npm start -- --submit
```

Point it at your own file with `--file path/to/orders.json`.

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | for `--submit` | API key id. Without it, the dry run still works. |
| `NEXUS_EXCHANGE_API_SECRET` | for `--submit` | API secret (hex) paired with the key. |
| `NEXUS_EXCHANGE_API_URL` | no | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Must **not** include `/api/v1` — see below. |
| `NEXUS_EXCHANGE_FUNDS` | no | `play` \| `real` \| `unknown`. Only needed for a host this example does not recognise. Submission is refused unless this is `play`. |
| `NEXUS_ORDER_FILE` | no | The order file. Defaults to `orders.example.json`. |
| `NEXUS_BATCH_CHUNK` | no | Orders per batch call. Defaults to `39` — see "Chunk at 39". Capped at 40. |
| `NEXUS_PREVIEW_POLICY` | no | `none` \| `first-per-market` \| `all`. Defaults to `first-per-market`. |
| `NEXUS_MAX_ORDERS` | no | Refuse a file larger than this. Defaults to `200`. |
| `NEXUS_BUDGET_UTILISATION` | no | Fraction of each budget to spend. Defaults to `0.8`. |
| `NEXUS_ALLOW_TAKER` | no | Allow a `time_in_force` that can fill. Off by default. |
| `NEXUS_RUN_ID` | no | Idempotency prefix. Random per run unless you fix it. |

Setting one credential without the other is refused — half a pair is always a
mistake, and the failure it produces otherwise is an opaque `401`.

## The order file

A JSON array. Every field is checked against the venue's own trading rules,
fetched at startup from `GET /markets/summary`, rather than against constants:
tick and lot sizes are per market and change with a listing.

```json
[
  {
    "market_id": "BTC-USDX-PERP",
    "side": "Buy",
    "order_type": "Limit",
    "price": "62000.0",
    "quantity": "0.001",
    "time_in_force": "PostOnly"
  }
]
```

`price` and `quantity` are **decimal strings, not JSON numbers** — the venue's
`Decimal` fields are strings for a reason, and a number here is refused rather
than rounded. `reduce_only` and `client_id` are optional. `order_type` is
`Limit` only: a bulk loader that fires market orders is a different and much
sharper tool than this one.

**Validation is all-or-nothing.** One unplaceable order in the file and nothing
is sent. A loader that applies the half of a file it likes leaves you with a
position nobody wrote down.

## About the host

**The base is `https://api.testnet.nexus.xyz/indexer`, and the `/indexer` is
part of it.** It is a route prefix the deployment mounts the service under, not
part of the API contract, and the bare host answers `404` on every path. Copy
the base whole rather than trimming it to the hostname.

**Not `https://exchange.nexus.xyz/api/exchange`.** That gateway is what every
Nexus SDK shipped as its default until September 2026, and it now proxies to a
decommissioned indexer: every route answers `500` (ENG-14039). If you are
reading an older example, a pinned older SDK, or a cached copy of the docs, that
is the base you will find, and it does not work. This app points at the durable
host and lets you override it with `NEXUS_EXCHANGE_API_URL` for a local stack.

**Mainnet is not a target.** `api.nexus.xyz` is refused by name before any
request is made. This example places orders in bulk; that is a testnet activity.

**You sign the path the *indexer* sees, not the path in your URL.** The
deployment strips its own `/indexer` prefix before the request reaches the
service that verifies your signature, so a request sent to
`…/indexer/api/v1/orders/batch` is verified as `/api/v1/orders/batch` — with the
`/api/v1`, without the deployment's own prefix. Sign the URL's full path instead
and you get a `401` that looks exactly like a bad secret. This is the same
lesson [`trading-terminal`](../trading-terminal) carries, against a different
prefix.

## The rate-limit model

This is the part worth reading. Six rules, and only the first is what people
assume.

**1. `limit` is weight per second, not requests per second.** Most calls cost 1.
The heavy aggregate reads — `/account/summary`, `/fills`, `/orders/history`,
`/account/portfolio-history`, `/positions/pnl` — cost **5**. A `Pro` caller at
`limit: 20` can make twenty ticker reads a second, or four `/fills` reads. Pace
on the weight.

**2. Order writes are charged to a different bucket from reads, and
cancellations to a third.** Spending one never spends another. So a healthy
`x-ratelimit-remaining` on your last read says nothing at all about your
placement headroom, and a `429` on reads is not a reason to stop placing — a
client that backs the whole connection off a read-budget refusal starves its own
order flow. This app meters three budgets separately and pauses only the one
that refused.

**3. `GET /account/rate-limit` is free**, and it is the only operation that is.
It reports every budget, keyed by the same label a `429` uses. **That is what
this app paces against**: the budgets are read from the venue at startup and
re-read every five seconds during a run, rather than taken from the tier table
in the docs — which the spec explicitly says is per-deployment configuration and
must not be hardcoded. Re-reading also means a co-tenant on the same key shows
up as pacing rather than as a refusal.

**4. `POST /orders/preview` is itself a trading-class write.** It is on the
`/orders` surface, so it costs a trading token exactly as placing an order does.
Preview before every order and you have halved your placement rate — budget two
trading charges per order placed that way. Hence `NEXUS_PREVIEW_POLICY`, whose
default previews the **first order on each market** and nothing else: margin is
what a preview actually catches, and margin is per account and per market, so if
the first order on a market is refused the rest are in trouble too.

**5. `remaining` and `retry-after` are in different units.** `remaining` is in
unit-cost requests — 10 means ten weight-1 calls *or* two weight-5 ones — while
`retry-after` is derived from the weighted cost of what was refused. A limiter
that conflates them over-sends on heavy endpoints and 429s itself. Here
`remaining` is only ever compared against a weighted cost, and `retry-after` is
only ever used as a duration.

**6. `x-ratelimit-reset` and `retry-after` appear on a `429` only.** Read off a
2xx they read nothing, so a limiter that waits for a reset it never saw waits
forever.

And the exception that breaks rule 2: on the `Unlimited` tier reads and order
writes share one per-IP bucket. That tier reports nulls from
`/account/rate-limit`, and this app detects it and collapses to a single pool
rather than modelling three budgets that do not exist.

### When it cannot read the budgets

`buckets` — the field that reports the `order` and `cancel` budgets separately —
is **additive, and newer than the `v0.8.1` tag this example pins.** A deployment
serving that contract answers with the four flat fields only. That is not an
error and not a reason to stop, so the app infers the two trading ceilings from
the request ceiling (the spec says they are the same per-second size on the
tiered plans), starts their local token counts at **empty** so it cannot
over-send, and prints `(inferred)` next to them instead of `(server)`.

If the endpoint is unreachable altogether — no credentials, an older deployment,
a `5xx` — it falls back to an assumed **4/s on every class**, slower than any
real tier, and says so in a full sentence. Guessing the tier numbers instead
would be faster and would be exactly the mistake the spec warns against.

### Chunk at 39

`POST /orders/batch` costs `1 + floor(order_count / 40)` trading units. Read
that literally and **the cheapest chunk is 39, not 40**: 39 orders cost one
unit, 40 orders cost two. The spec's prose says "up to 40 orders cost the same
as a single order", which disagrees with its own formula at exactly the
multiples of 40 — so 39 is optimal under the formula and no worse than 40 under
the prose. It is a two-fold difference in throughput at the boundary, which is a
lot to lose to an off-by-one nobody would ever look for.

Either way, the chunk size **is** the optimisation: forty orders at a time cost
one or two units, and the same forty orders submitted one at a time cost forty.

## How it works

Eight small files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`budget.ts`](./src/budget.ts) | The rate-limit model: three buckets, weighted costs, the free status poll, and what to do when the venue will not say. |
| [`signing.ts`](./src/signing.ts) | The HMAC-SHA256 canonical string, and the three traps that each produce an identical `401`. |
| [`decimal.ts`](./src/decimal.ts) | Exact money arithmetic on `BigInt`. |
| [`config.ts`](./src/config.ts) | Environment parsing, and every guard that can be applied before a request exists. |
| [`plan.ts`](./src/plan.ts) | Reading the order file and refusing what should not be sent. |
| [`rest.ts`](./src/rest.ts) | One hardened, budget-paced request: deadlines, bounded bodies, retry policy. |
| [`loader.ts`](./src/loader.ts) | Preview, submit, reconcile, cancel. |
| [`index.ts`](./src/index.ts) | Wiring and lifecycle. |
| [`rest.test.ts`](./src/rest.test.ts) | One regression test, over the path composition the signing guard compares against. |

`npm test` runs that test. There is nothing to compile here, so the `build`
script runs it too — CI runs `typecheck` and `build`, and a test the gate never
executes is a correctness claim nothing re-checks.

Four decisions beyond the rate-limit model are worth copying.

**A timeout is not a rejection, and `client_id` is what makes that survivable.**
A batch whose response never arrived may have been fully applied. Every order
this app sends carries an idempotency key — `ol-<run>-<index>` unless the file
names one — so an ambiguous failure is answered by *asking the venue what
happened*, matching open orders against the keys we sent, rather than by
re-sending and hoping. Without the key the only way to tell a lost response from
a lost request is to compare prices and sizes against open orders and hope no
two are alike, which for a ladder they never are. A `429` is the one failure
that is unambiguous — it says the request was refused, not processed — so that
is the only thing retried automatically.

**A `403` is not a `429`.** Both are refusals; only one is retryable. A
jurisdiction refusal (`RESTRICTED_JURISDICTION`, `US_RESTRICTED`,
`GEO_UNRESOLVED`) is a decision, and a retry loop that covers both turns it into
four identical requests and a confusing log. They are branched on by `code`,
because the codes are stable — the `429` body's `message` names which pool
bottlenecked and is explicitly *not* stable, so it is never matched on.

**Cancel-everything-on-exit is not optional for a bulk writer**, and it has to
be verified. The cancel runs on every exit path, is scoped to the markets this
run touched rather than being a bare account-wide cancel-all, and is charged to
the separate cancel budget — the guarantee that a run which spent its whole
submission allowance can still pull its orders back. It then *reads* `GET
/orders` to confirm, because `DELETE /orders` answers `200` with the orders it
did cancel even when it could not reach every market: a short array is not
proof.

**Shutdown outlives the stop signal.** If the REST client watched the same
`AbortSignal` that Ctrl-C trips, the first thing shutdown would do is guarantee
the cancel request could not be sent. So there are two stages: `stopping` ends
the submit loop between batches, and only after the cancel finishes does
`halted` close the request path — under a hard deadline, with a second Ctrl-C
exiting immediately while saying plainly that orders may survive.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **The read-only path was run end to end against the live testnet host; the
  authenticated write path was not**, because the author had no testnet
  credentials to hand. The dry run, the validation refusals, the market-rules
  fetch, the base-URL guards and the signed-request path as far as the venue's
  `401` were all exercised against `api.testnet.nexus.xyz`. The batch submit,
  the preview, the reconcile and the cancel are written against spec `v0.8.1`
  and have not been run against a live account.
- `POST /orders/batch` is **sequential and non-atomic**: an early order
  consuming margin is why a later order in the same batch can fail, and
  per-order failures do not abort the batch. That is why chunks preserve file
  order rather than being packed, and why the result is reported per order.
- Not implemented, and out of scope: amendment, conditional and trailing order
  types, position or margin management, `cancel-on-disconnect` (the right
  server-side backstop for a real bot — see
  `PUT /account/cancel-on-disconnect`), the WebSocket, and any persistence
  across restarts.
- Six mutation routes elsewhere in the API currently have no rate limiter at
  all. None of them is on the order surface, and this example does not touch
  them.
