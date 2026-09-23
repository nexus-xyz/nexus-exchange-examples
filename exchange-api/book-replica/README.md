# book-replica

A local L2 order-book replica for one market, fed by the public WebSocket and
checked against REST. It shows how to keep a book in sync from a stream
without trusting the stream: order frames by sequence, treat every sign of lost
continuity as a reason to re-snapshot, and keep comparing the replica with the
venue's own REST book, printing a divergence when it finds one.

It is built **directly on the Exchange API** (raw WebSocket and REST, no SDK)
with **zero runtime dependencies**: just `fetch` and `WebSocket` from Node. It
needs **no credentials**. The public stream and the order-book route are both
unauthenticated.

## What it does

- Takes a REST snapshot of `GET /markets/{market_id}/orderbook`, then connects
  to `GET /stream` and subscribes to `book:<market>`.
- Applies each book frame whose sequence is higher than the one it holds.
  Frames at or below that sequence are dropped as stale.
- Re-fetches REST whenever continuity is lost: a `gap` frame from the
  server, an `out_of_sync`, a reconnect, a frame it cannot read, or a stream
  that stops advancing while REST moves on.
- Cross-checks against a fresh REST snapshot every 15 s and prints the verdict:
  `match`, `diverged`, `replica-behind`, `rest-behind` or `incomparable`.
- Reconnects forever with capped exponential backoff and jitter, and abandons
  any connection that goes 10 s without a frame.
- Prints one compact top-of-book line when the top or the replica's state
  changes, a heartbeat when nothing does, and on exit a summary of what the
  stream actually sent.

### What it printed against testnet (2026-09-22)

**Testnet had no live book when this was written.** The run below is real
and unedited except for trimming. It shows the replica working correctly
against a venue with nothing to replicate.

```
22:42:57  Nexus Exchange book replica — BTC-USDX-PERP
22:42:57  REST   https://api.testnet.nexus.xyz/indexer  (testnet, public data, no credentials)
22:42:57  stream wss://api.testnet.nexus.xyz/indexer/stream
22:42:57  initial REST snapshot at nonce 0
22:42:57  BTC-USDX-PERP  bid —  ask —  spread —  depth 0/0  EMPTY  seq 0 via rest
22:42:57  stream connected (attempt 1), subscribed to book:BTC-USDX-PERP
22:43:07  … no book frames yet; connected; replica at seq 0, EMPTY (watchdog abandons at 10s)
22:43:07  !  no frames for 10s — abandoning this connection
22:43:07  !  stream closed (liveness timeout) after 10.0s and 0 frame(s)
22:43:07  reconnecting in 0.3s
22:43:08  stream connected (attempt 2), subscribed to book:BTC-USDX-PERP
22:43:08  resync (reconnected): REST confirms the replica at seq 0
22:43:12  cross-check: match at seq 0 (0 levels, level for level)
   … four more connect / silence / abandon rounds, backoff growing to 14 s …
22:44:12  stopping (--seconds 75)

22:44:12  summary after 75s
22:44:12    connections        6
22:44:12    book frames        0 (0.00/s)
22:44:12    frame interval     n/a
22:44:12    gaps / missed      0 / 0
22:44:12    out_of_sync        0
22:44:12    REST resyncs       5
22:44:12    cross-checks       match 4
```

Why it looked like that, measured the same day:

- `GET /indexer/health` returned `"health":"unhealthy"`, `"connected":false`,
  `"events_received":0`. The indexer was up, but no matching engine was
  serving behind it, so nothing produced a book.
- `GET /markets/{BTC,ETH,SOL}-USDX-PERP/orderbook` returned
  `{"bids":[],"asks":[],"nonce":0}` on every read. A `nonce` of `0` means the
  indexer had not written a book for the market since it started.
- `GET /stream` completed the upgrade (`101`) with no token, took the
  subscribe, and sent **no frames at all**. That held on every connection
  tried: both subscribe dialects, `book:*` and a single market, and one probe
  held open deliberately. Each idle connection was dropped with a bare `1006`
  about 30 s after opening, with no close frame. That drop is why the
  watchdog exists, and why it abandons a socket instead of waiting for the
  close handshake to finish.

Run it when testnet has a live book and you should see a line roughly every
second while the book moves, and `cross-check: match at seq N` lines between
them. Anything else is reported rather than hidden. **Until testnet is serving
again, this README has no live-book transcript.** The logic is covered by the
offline tests (`npm test`), which feed it frames in the exact shape the
indexer serialises.

## Prerequisites

- **Node 22.4 or later.** It uses `process.loadEnvFile` and the global
  `WebSocket` (unflagged from 22.4), so nothing is installed at runtime. Tested
  on Node 22.23; CI builds on 22.
- **No API key.** Nothing here is authenticated.

## Pinned versions

There is no SDK to pin. What this example pins is **the API contract itself:
spec `v0.8.1`**, from
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api/releases/tag/v0.8.1),
sent on every request as `X-Nexus-Api-Version: v0.8.1`. It targets **testnet**
(play funds) at `https://api.testnet.nexus.xyz/indexer`, and it refuses
mainnet's host outright.

The toolchain is pinned exactly: `typescript` `7.0.2`, `tsx` `4.23.8`,
`@types/node` `26.1.2`. `package-lock.json` is committed and CI installs it
with `npm ci`.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

`npm start -- --seconds 60` runs for a fixed time, then prints the summary.
Ctrl-C prints it too.

## Configuration

Every variable is optional. Put overrides in `.env` (see `.env.example`) or
the environment.

| Variable | Default | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_URL` | `https://api.testnet.nexus.xyz/indexer` | REST base. Must **not** end in `/api/v1`. The `/indexer` prefix is required; the bare host 404s. |
| `NEXUS_EXCHANGE_STREAM_URL` | the REST base, `wss://`, plus `/stream` | Public market-data WebSocket. Derived from the REST base so the two cannot silently point at different deployments. |
| `NEXUS_MARKET` | `BTC-USDX-PERP` | Market to replicate. Any id from `GET /markets/summary`. |
| `NEXUS_CROSSCHECK_SECONDS` | `15` | Seconds between REST cross-checks. |

## What the stream sends

This is the part to read before writing your own replica. It comes from the
spec, the indexer's source and the live host, and where they disagree it says
so.

**`GET /stream` is the legacy public stream, and it needs no token.** The
pinned spec (`v0.8.1`) still says it requires one from `POST /ws-tokens`. It
does not: token auth was removed in ENG-3128, and the live host upgrades
without one. The newer spec says so. The token-gated `GET /ws` speaks the
`op`-envelope protocol that `trading-terminal` uses. `/stream` does not:

```
→ {"subscribe":["book:BTC-USDX-PERP"]}            one message, read once, on connect
← {"type":"BookUpdate","market_id":"BTC-USDX-PERP",
   "book":{"bids":[{"price":"62815.5","quantity":"0.25","order_count":3},…],
           "asks":[…],"sequence":15994}}
← {"type":"gap","missed":12}                      this connection fell behind; frames dropped
```

These facts shaped the design:

- **Every book frame is a full snapshot, not a delta.** It carries the top 20
  levels a side, the same depth REST serves. So the replica never merges.
  Each frame replaces the book, and a gap repairs itself on the next frame.
  The replica still re-fetches REST at once, because the next frame might be a
  second away.
- **The book is fed by two producers** (ENG-12905): a poller that re-reads the
  book about once a second and republishes it whether or not it moved, and,
  since ENG-12905 landed, a push at fill time off the engine's
  `OrderBookUpdate`. Expect a frame about every second, plus extra ones around
  trades. Between trades, a new resting order or a cancel shows up only on the
  next poll, up to 1 s later. This is not a tick-level feed, and the engine's
  200 ms block time does not make it one.
- **Frames carry no timestamp** (ENG-15966). Sequence is the only ordering.
  The age shown here is local arrival time, which is the best a client can do.
  The REST book's `timestamp` is when the response was served, not when the
  book was observed.
- **`sequence` is monotonic but not contiguous.** The indexer computes it as
  `max(engine_sequence, previous + 1)`. A poll frame advances it by one, and a
  fill frame jumps it to the engine's global event sequence, which moves for
  every market. So `seq > last + 1` is **not** a gap. The replica counts jumps
  and does not act on them. It learns about gaps from the server's `gap` frame
  and from its own reconnects.
- **`sequence` is the REST book's `nonce`.** Both read the same stored
  projection, and that is what makes an honest cross-check possible (see
  below).
- **There is no replay.** `/stream` has no `since` cursor and never sends
  `out_of_sync`. `missed` frames are gone, and REST is the only way back.
- **A known wrinkle the replica cannot see.** The indexer documents that a
  late poll can republish a book *older* than a fill-time frame, at a
  *higher* sequence. A client cannot tell that it went back in time. It
  corrects on the next frame. Sequence ordering cannot catch it and neither
  can this replica, and the README would be lying if it claimed otherwise.

**If the stream changes shape.** Frame parsing lives in
[`frames.ts`](./src/frames.ts), and it already reads the `op`-envelope
protocol (`event`, `out_of_sync`, `subscribed`, `error`) as well as `/stream`'s
`type` frames. An `out_of_sync` triggers a REST resync and a fresh subscribe.
If the venue ever ships an **incremental** encoding, a frame the parser cannot
read as a complete `{bids, asks}` snapshot is reported as `unrecognised`,
never merged on a guess, and the replica resyncs from REST. You get a book
that is slightly less live, never one that is silently wrong. A delta merge
belongs in `frames.ts` as a new frame kind, and it should run only on
contiguous sequence numbers. The encoding is not documented, so this example
does not guess at it.

## How it works

| File | What it owns |
| --- | --- |
| [`frames.ts`](./src/frames.ts) | Both wire protocols, classified into book / gap / out_of_sync / ignored / unrecognised. |
| [`replica.ts`](./src/replica.ts) | The book, the sequence it holds, the resync flag, and the cross-check verdicts. |
| [`stream.ts`](./src/stream.ts) | One WebSocket connection: subscribe, watchdog, backoff, stale-callback fencing. |
| [`rest.ts`](./src/rest.ts) | One hardened unauthenticated GET: deadline, byte cap, content-type check, no redirects. |
| [`decimal.ts`](./src/decimal.ts) | Exact decimals on `BigInt`. |
| [`index.ts`](./src/index.ts) | Wiring, the resync path, the view, the summary. |

Three decisions are worth copying:

**A difference only counts as divergence when both sides name the same
sequence.** REST's `nonce` and the stream's `sequence` come from one stored
book, so a replica and a REST read at the **same** sequence must agree level
for level. If they do not, that is `diverged`, and the replica resyncs. At
different sequences, a difference is just time passing. That is reported as
`replica-behind` or `rest-behind`, with whether the levels differ, and is not
counted as divergence. An alarm that fires on ordinary lag teaches people to
ignore it. If the replica stays behind for three checks without its sequence
moving, the stream has stalled and it resyncs.

**The comparison is made on the lossy side's terms.** The stream sends levels
as decimal strings (`"62815.50"`). The REST book is CCXT-shaped, with
`[price, amount]` as JSON doubles. The replica keeps exact decimals and
computes the spread exactly. It compares with REST by asking whether a
replica level is the double the server would have written. It does not
compare digits, which would false-alarm on any value with more precision than
a double holds.

**A snapshot stream still needs a resync path.** Each frame is complete, so it
is tempting to skip resyncs entirely. But after a gap or a reconnect, the next
frame can be a second away, and the replica is what you quote from. The
resync is single-flight and throttled to once a second, so a run of unreadable
frames turns into a slow REST poll, not a flood. If REST answers with an
*older* nonce than the stream has since delivered, the replica keeps the
newer stream book. Overwriting it with the older REST read would be the one
wrong move available.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **Testnet was not serving a book when this was built** (see above). The
  replica ran end-to-end against the live host, but only ever saw an empty
  book and a silent stream. Its handling of real frames, gaps, stale frames,
  reconnects and divergence was exercised offline and against a local
  stand-in that emits the indexer's frame shapes. It has not yet been seen
  against a moving testnet book.
- One market per process. `/stream` would happily send `book:*`, but a replica
  per market keeps the sequence and resync logic one-dimensional.
- The replica holds the top 20 levels a side because that is what the venue
  sends. It is not a full-depth book, and no client can build one from this
  feed.
- Not implemented: persistence across restarts, and trades or ticker. Both
  are on the same stream, and neither is needed to show how to keep a book
  honest.
