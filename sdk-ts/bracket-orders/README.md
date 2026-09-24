# bracket-orders

A bracket order manager, built on the TypeScript SDK. It places one entry, then
a **take-profit** and a **stop-loss** exit, and keeps them one-cancels-other:
when one exit fills, it cancels the other.

The exits are the venue's own conditional orders (`TakeProfitMarket` and
`StopMarket` with a `trigger_price`), reduce-only, and sized to what the entry
**actually filled**. The venue fires them. This process isn't the stop; it only
cleans up the sibling. That split is the point of the example: kill the app,
lose the network, press Ctrl-C, and the position is still protected.

**It dry-runs by default.** Without `--live` it sends no write of any kind.

## What it does

A dry run against live testnet, with no credentials. This is what testnet looked
like on 2026-09-23: the venue's `GET /status` reported its engine, indexer and
oracle `down`, the mark price answered `503` and every book was empty, so there
was no reference price to check the triggers against, and the app says so:

```text
$ npm start -- --limit 81300 --tp 82100 --sl 80900 --run-id readme
01:29:46  target  https://api.testnet.nexus.xyz/indexer (testnet, play funds); ws wss://api.testnet.nexus.xyz/indexer/ws
01:29:46  mode    dry run: reads live data, sends no write of any kind
01:29:48  mark    unavailable (the venue answered 503) and the book is empty: no reference price, so the trigger-vs-mark checks can't run
01:29:48  plan    Buy 0.002 BTC-USDX-PERP IOC at worst 81300, then two reduce-only Sell exits:
01:29:48          take-profit TakeProfitMarket trigger 82100
01:29:48          stop-loss   StopMarket       trigger 80900
01:29:48          tick, lot and minimum size unchecked: GET /markets is signed and there are no credentials
01:29:48  ids     br-readme-entry, br-readme-tp, br-readme-sl
01:29:48  check   ok: triggers on the right side of the entry limit
01:29:48  account unread: no credentials, so cancel-on-disconnect, the position and open orders are unchecked
01:29:48  would send, in this order (exit quantity is the entry's *filled* size; shown here as if it fills in full):
01:29:48    POST /orders {"market_id":"BTC-USDX-PERP","side":"Buy","order_type":"Limit","price":"81300","quantity":"0.002","time_in_force":"IOC","client_id":"br-readme-entry"}
01:29:48    POST /orders {"market_id":"BTC-USDX-PERP","side":"Sell","quantity":"0.002","time_in_force":"GTC","reduce_only":true,"order_type":"StopMarket","trigger_price":"80900","client_id":"br-readme-sl"}
01:29:48    POST /orders {"market_id":"BTC-USDX-PERP","side":"Sell","quantity":"0.002","time_in_force":"GTC","reduce_only":true,"order_type":"TakeProfitMarket","trigger_price":"82100","client_id":"br-readme-tp"}
01:29:48    then hold /ws orders+fills, and cancel the survivor with DELETE /api/v1/orders/{id}?market_id=BTC-USDX-PERP
01:29:48  dry run: nothing was sent.
```

The live path, run against the **local fake venue** in
[`src/run.test.ts`](./src/run.test.ts), not against testnet (see
[Notes](#notes)). The entry asks for 0.006 and the book only holds 0.004, so
both exits are sized 0.004. Then the socket drops, the stop fires while it's
down, and no frame for that fill ever arrives. The reconnect forces a REST read,
which finds the fill and cancels the take-profit:

```text
target  http://127.0.0.1:64666 (overridden host, declared play funds); ws ws://127.0.0.1:64666/ws
mode    LIVE: places the bracket and manages it
market  BTC-USDX-PERP: tick 0.5, lot 0.001, min size 0.001
mark    80000
plan    Buy 0.006 BTC-USDX-PERP IOC at worst 80010, then two reduce-only Sell exits:
        take-profit TakeProfitMarket trigger 80500 (62.5 bps from reference)
        stop-loss   StopMarket       trigger 79600 (-50 bps from reference)
ids     br-t1-entry, br-t1-tp, br-t1-sl
check   ok: triggers on the right side of the entry limit and the mark, prices on tick, size on lot
account cancel-on-disconnect off
account BTC-USDX-PERP: position 0, 0 open order(s)
entry placed: 00000000-0000-4000-8000-000000000001 canceled
entry filled 0.004 of 0.006 (IOC: the rest was cancelled by the venue)
stop-loss 0.004 @ trigger 79600 placed: 00000000-0000-4000-8000-000000000002 open
take-profit 0.004 @ trigger 80500 placed: 00000000-0000-4000-8000-000000000003 open
managing: one-cancels-other over /ws orders+fills, every decision from a REST read. Ctrl-C leaves both exits resting.
reconcile (initial reconcile): tp open, sl open, position 0.004
reconcile (websocket reconnected): tp open, sl filled (filled 0.004), position 0
stop-loss filled: cancelling take-profit 00000000-0000-4000-8000-000000000003
reconcile (confirming the cancel): tp gone, sl filled (filled 0.004), position 0
done: stop-loss filled; take-profit is already off the book. Nothing of this bracket is resting.
```

And Ctrl-C while managing, from the same fake venue:

```text
reconcile (initial reconcile): tp open, sl open, position 0.004
interrupted. The exits are left resting, so the position stays protected:
  take-profit 00000000-0000-4000-8000-000000000003 trigger 80500
  stop-loss   00000000-0000-4000-8000-000000000002 trigger 79600
  last read: tp open, sl open, position 0.004
  Nothing links them now. If one fills, cancel the other yourself: DELETE /orders/{id}?market_id=BTC-USDX-PERP.
```

## How it works

### What the venue offers, and what this relies on

Checked against spec **v0.8.1** (the tag SDK 0.4.0 is compiled against) and the
SDK's own types:

| | Spec v0.8.1 | SDK 0.4.0 |
| --- | --- | --- |
| Conditional types | `StopLimit`, `StopMarket`, `TakeProfitLimit`, `TakeProfitMarket`, `TrailingStop`, `TrailingLimit` | all six on `OrderType` |
| Trigger | `trigger_price` for the four non-trailing types (`stop_price` is a deprecated fallback) | `OrderRequest.trigger_price` |
| Reduce-only | `reduce_only: boolean`, no description | `OrderRequest.reduce_only` |
| Time in force | `GTC`, `IOC`, `FOK`, `PostOnly`, required on every order | `TimeInForce` |
| Linked orders (OCO, brackets) | none | none |
| Account stream | `/ws` `orders` and `fills` channels, `seq` / `since` / `out_of_sync` | `createWsClient`, which reconnects and resubscribes itself |

Where the spec is silent, this is exactly what the app assumes:

- **Trigger direction.** The spec says a stop fires "when the mark price crosses
  `trigger_price` in the adverse direction" and a take-profit "on the favorable
  direction", and doesn't define either per side. This app reads them relative
  to **the position the exit closes**: for a long (Sell exits) the stop fires on
  the mark falling to the trigger and the take-profit on it rising; for a short,
  the mirror. Because a different reading would fire an exit on placement, it
  refuses any plan whose triggers aren't on the expected side of the mark and
  the entry limit, and it places the stop first so a stop the venue rejects as
  "already crossed" is found before a take-profit exists.
- **Amending a conditional order.** `PATCH /orders/{id}` is an "atomic
  cancel-replace amend of a **resting** order". Whether an untriggered
  conditional order counts as resting isn't stated. **The app never amends an
  exit.** Exits are sized once, from the filled entry, and never resized.
- **Reduce-only when the exit is bigger than the position.** `reduce_only` has
  no description in the spec. This app relies on it meaning "never opens or
  flips a position": after a *partial* exit fill, the sibling keeps its full
  size, and `reduce_only` is what stops it closing more than is left. The
  alternative, cancelling and re-placing the stop smaller, opens a window with
  no stop at all.
- **Time in force on a trigger.** Every order needs one, and the spec doesn't
  say whether it governs the untriggered order or the market order it fires.
  The exits are `GTC`, the only reading under which a trigger can wait.
- **A native bracket may exist.** `Order.cancellation_reason` lists
  `BracketClosed` and `BracketFlipped`: "a bracket child whose parent position
  closed to zero or flipped sign". So the engine has *some* notion of a bracket
  child. But no field of `OrderRequest` creates one, and nothing else in v0.8.1
  describes it, so this app doesn't depend on it. If it's real, the venue may
  one day cancel these exits for you when the position closes; the manager
  already treats "the exit is gone and the position is flat" as done.

### The entry is IOC, so the exits' size is known

The entry is an IOC limit at `--limit`. Whatever fills, fills on arrival, and
the venue cancels the rest, so the quantity the exits must cover is final when
the placement answers. The app takes the larger of what the response and a REST
read of the order and its fills report, and sizes both exits to that. A resting
entry would keep growing the position after the exits were sized, and since the
exits are never amended (see above), every late fill would be unprotected.

### The socket is the doorbell, REST is the ledger

One-cancels-other runs client-side, because the venue doesn't link the exits.
Frames on the `orders` and `fills` channels wake the manager, but a frame never
decides anything: the payload shapes of those channels aren't in the spec, and
a decision that cancels a stop should rest on documented reads. Every wake leads
to the same thing: read open orders, order history, fills and positions over
REST, and hand that snapshot to one pure function, `decide` in
[`src/bracket.ts`](./src/bracket.ts), which is tested as a table.

That makes "reconcile before acting after a reconnect" true by construction.
The SDK's socket client reconnects and resubscribes with `since` on its own and
doesn't tell its consumer. It does call the token provider on every connect,
though, so the app counts mints: a second token means a reconnect, and a
reconnect forces a REST read. `out_of_sync` forces one too, and so does a
timer (15s by default) in case the socket is silently dead. A frame missed
during a disconnect, which the server's bounded replay ring allows, can't leave
both exits live.

`decide` in order: an exit filled, so cancel the other. The position is flat
while an exit rests, so cancel what's left. The stop is gone without filling
(the venue cancelled it: `InsufficientLiquidity`, a halt, a liquidation) while
the position is open: that's **unprotected**, the app exits `3`, and it
deliberately doesn't cancel the take-profit or invent a replacement stop.
Anything it can't read is a hold, never a guess: an unreadable position is not
"flat".

### Ctrl-C leaves the position protected

On SIGINT or SIGTERM the manager stops watching and **cancels nothing**. Both
exits stay resting, and it prints their ids and triggers. The obvious shutdown,
cancelling your own orders on the way out, is the wrong one here: it turns
"I stopped the program" into "I removed my stop", at whatever moment you
happened to press the key. The cost is that nothing links the exits any more,
so if one fills after you exit, the other stays on the book until you cancel
it. A reduce-only order with no position to reduce is an annoyance; a position
with no stop is a loss.

The same logic runs the other way during placement. A signal between the entry
and the exits doesn't stop the app: it finishes placing the exits first, then
exits. A second signal forces the exit and says what that can cost.

### It refuses to start where the exits wouldn't be safe

With `--live`, before sending anything:

- **Cancel-on-disconnect must be off.** With it on, the venue cancels resting
  orders when this app's socket drops, and the exits are resting orders. The
  moment the socket drops is exactly when the stop has to survive. See
  [`sdk-ts/dead-mans-switch`](../dead-mans-switch) for what COD does.
- **The account must be flat, with no open orders, in that market.** Reduce-only
  exits sized to this entry would also act on a position that was already there.
- **All three prices are yours.** The dry run can derive illustrative prices
  from the mark; `--live` refuses to run without `--limit`, `--tp` and `--sl`.

### Where the pinned SDK and the live venue disagree

- **The venue serves orders in CCXT's vocabulary** (`symbol`, `clientOrderId`,
  `amount`, `filled`, status `closed` for filled), not the spec's (`market_id`,
  `filled_qty`, `Filled`). Everything is read under both spellings.
- **`client_id` isn't in spec v0.8.1 or the SDK types**, but the venue accepts
  it. Each order carries one derived from the run id, so a placement whose
  answer was lost is looked up by client id and **never resent**.
- **The WebSocket base keeps the `/indexer` prefix.** `Client.wsUrl` drops it,
  so the base is derived in `src/config.ts` and handed to `createWsClient`, as in
  [`dead-mans-switch`](../dead-mans-switch).

### Money is never a float

Prices and sizes are exact decimals on BigInt ([`src/decimal.ts`](./src/decimal.ts),
copied from `sdk-ts/twap-executor`). The exits are sized by summing fills, which is
exactly where binary floating point would leave dust unprotected.

## Prerequisites

- Node 22 or later (tested on Node 22.23; CI builds on 22). Node 22's global
  `WebSocket` is what the SDK's stream client uses.
- For `--live`: a Nexus Exchange **testnet** API key, created in the
  [Exchange app](https://exchange.nexus.xyz). The dry run needs none.

## Pinned versions

This example pins **`@nexus-xyz/exchange-ts` `0.5.0`**, exact version, with
`package-lock.json` committed. 0.5.0 is compiled against Exchange API spec
**`v0.8.1`**. Toolchain: `typescript` `7.0.2`, `tsx` `4.23.8`, `@types/node`
`26.1.2`.

## Setup

```bash
npm install
cp .env.example .env   # optional: only needed for --live
```

## Run

```bash
npm start
```

That's the dry run: buy 0.002 BTC-USDX-PERP, with illustrative prices derived
from the mark (limit +10 bps, take-profit +100 bps, stop-loss -50 bps). If the
venue has no mark and an empty book, as on the day this was written, it can't
derive anything and says so; pass the prices yourself, as in the transcript
above. To trade on testnet, with credentials in `.env`:

```bash
npm start -- --live --size 0.002 --limit 81300 --tp 82100 --sl 80900
```

It manages the bracket until one exit fills and the other is cancelled, or until
you press Ctrl-C, which leaves both exits resting.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market ID` | `BTC-USDX-PERP` | Market to trade |
| `--side buy\|sell` | `buy` | The entry's direction. The exits are the other side |
| `--size N` | `0.002` | Entry size, a decimal. Must be a multiple of the market's lot |
| `--limit P` | derived (dry run) | Worst price the IOC entry may fill at. Required with `--live` |
| `--tp P` | derived (dry run) | Take-profit trigger price. Required with `--live` |
| `--sl P` | derived (dry run) | Stop-loss trigger price. Required with `--live` |
| `--live` | off | Place the bracket and manage it |
| `--run-id ID` | random | Name the run. The client ids derive from it |

Unknown flags are refused, not ignored.

**Exit codes:** `0` done (or, in a dry run, a sound plan); `1` configuration or
API error; `2` the plan was refused and nothing was sent; `3` needs a human (the
position has no stop, an order's outcome is unknown, or the manager couldn't
read the account; whatever was placed is left resting); `130` interrupted, with
the exits left resting.

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | for `--live` | API key. Without it, the dry run uses public data only |
| `NEXUS_EXCHANGE_API_SECRET` | for `--live` | Secret paired with the key. Set both or neither |
| `NEXUS_EXCHANGE_API_URL` | no | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Must not include `/api/v1` |
| `NEXUS_EXCHANGE_WS_URL` | no | WebSocket base; `/ws` is appended. Defaults to the REST base with its path kept |
| `NEXUS_EXCHANGE_FUNDS` | no | `play` to declare an overridden host a testnet. `--live` refuses an undeclared one |
| `NEXUS_BRACKET_RECONCILE_SECONDS` | no | REST re-read interval when the socket is quiet, 2-300. Default `15` |

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

- [`src/bracket.test.ts`](./src/bracket.test.ts): the plan checks (trigger
  sides for longs and shorts, tick and lot), derived prices snapping away from
  the mark, exits sized to the fill, both wire vocabularies, and `decide` as a
  table of twelve snapshots.
- [`src/run.test.ts`](./src/run.test.ts): the whole live path in-process, with
  the real SDK against a loopback venue, and the SDK's real stream client over an
  injected socket. A partial entry; the stop placed before the take-profit; a
  take-profit frame cancelling the stop with `market_id`; a fill missed while the
  socket was down, found by the reconcile the reconnect forces (with the timer
  set to 60s, so nothing else can explain it); `out_of_sync`; Ctrl-C cancelling
  nothing; the venue removing the stop; a position closed elsewhere; and a
  refusal when cancel-on-disconnect is active.

## Notes

- **What ran against live testnet, and what didn't.** The dry run was run end to
  end against `api.testnet.nexus.xyz` without credentials, and the transcript
  above is that run. **The `--live` trading path has not been run against
  testnet.** There were no testnet credentials to hand, and on the same day the
  venue's `GET /status` reported its engine `down`: the mark price answered
  `503` and every book was empty, so there was nothing to trade against. The
  live path ran only against the fake venue in `src/run.test.ts`, which
  implements the behaviour this app depends on as far as the spec and the live
  wire describe it. That's not the same as the venue: in particular, the
  trigger-direction and `reduce_only` readings above are **assumptions no live
  run has confirmed**. Before relying on this, run the `--live` command with a
  small size against a testnet that has a book, and watch the exits fire.
- **One bracket per market, and it doesn't adopt existing orders.** It won't
  pick up a bracket it placed in an earlier run, so after Ctrl-C the exits are
  yours to manage.
- **No replacement stop.** If the venue removes the stop (for example
  `InsufficientLiquidity` when it fires into an empty book), the app reports the
  position unprotected and exits `3`. Placing a new stop automatically, at a
  price it would have to choose, is a trading decision this example leaves to a
  person.
- **Both exits can fill.** If the take-profit and the stop fire in the same
  instant, before the cancel lands, both can execute. `reduce_only` is what
  should stop the second one from opening a position the other way, and the app
  reports it if it ever sees both filled.
- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
