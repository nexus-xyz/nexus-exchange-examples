# stream-monitor

A monitor you can leave running on your account's WebSocket channels: it
follows `orders`, `fills`, `positions` and `balances`, keeps a **durable
cursor** per channel, and resumes at the sequence it left off when the socket
breaks — or when the whole process does. Driven entirely by the **`nexus`
CLI**, `jq` and bash.

What it teaches is not how to open a stream — that is one command — but the
part that only shows up after the stream breaks. Sequence numbers, replay
buffers, single-use tokens, and what "I have fallen behind" actually means. It
is the read-side counterpart to [`quote-ladder/`](../quote-ladder), which is a
reconciler over the same CLI's write path.

It is **read-only**. It places nothing, cancels nothing, and moves nothing.

## What it does

`--prove-resume` is the whole example in one command: it attaches, takes a few
events, **severs its own socket mid-stream**, resumes from the stored cursor,
and then checks the sequences on both sides of the break for a hole.

```
$ ./run.sh --prove-resume
stream-monitor  api.testnet.nexus.xyz  (nexus-testnet-indexer)
──────────────────────────────────────────────────────────────────────────────
cli         nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)
rest        https://api.testnet.nexus.xyz/indexer
socket      wss://api.testnet.nexus.xyz/indexer/ws
channels    fills
cursors     /path/to/stream-monitor/.state/cursor/
mode        sever each channel after 2 event(s), then resume from the cursor
──────────────────────────────────────────────────────────────────────────────
CHANNEL       CURSOR        SOURCE
fills         —           no cursor stored; would attach at the live edge

04:18:48Z  fills: attach #1 from the live edge (no stored cursor)
04:18:49Z  fills: attached, seq_at_join=8412 (cursor seeded)
{"op":"event","channel":"fills","market":null,"seq":8413,"payload":{...}}
{"op":"event","channel":"fills","market":null,"seq":8414,"payload":{...}}
04:18:49Z  warning: fills: severing the socket after 2 event(s) at seq 8414 — this is the demonstration, not a fault
04:18:49Z  fills: attach #2 resuming from seq 8414
04:18:50Z  fills: attached, seq_at_join=8418 — expecting a replay of 8415..8418
{"op":"event","channel":"fills","market":null,"seq":8415,"payload":{...}}
{"op":"event","channel":"fills","market":null,"seq":8416,"payload":{...}}
{"op":"event","channel":"fills","market":null,"seq":8417,"payload":{...}}
{"op":"event","channel":"fills","market":null,"seq":8418,"payload":{...}}

──────────────────────────────────────────────────────────────────────────────
CHANNEL       EVENTS   CURSOR    RESULT       DETAIL
fills         6        8418      contiguous   8413..8418, 6 event(s), no gap
──────────────────────────────────────────────────────────────────────────────

Every severed channel resumed with no unexplained hole in its sequences.
```

8415 and 8416 were already in flight when the socket died. They came back
because the reattach asked for them, and `contiguous 8413..8418` is the
assertion that they did — not a claim that the socket reconnected, which is a
much weaker thing and the one an example usually demonstrates by accident.

`--follow` is the same machinery with no bounds: run it, leave it, and the
event journal lands on stdout one JSON frame per line while everything
conversational goes to stderr. `--status` prints the cursor store without
touching the network; `--reset` forgets it, **under the lock** — a reset while
another monitor is running would send its next reattach to the live edge, which
is the silent gap this whole app exists to rule out. `--unlock` is the escape
hatch for a lock a crashed run left behind; it refuses while the recorded pid
is alive, so it is not a `--force`.

## Prerequisites

- **`nexus-exchange-cli` 0.4.0.** Install it with
  `curl https://cli.nexus.xyz | sh`, or see the
  [CLI README](https://github.com/nexus-xyz/nexus-exchange-cli#install) for
  Homebrew and release artifacts. `run.sh` checks the version and refuses to
  run against a different one.
- **bash 3.2 or newer** — so a stock macOS works with no `brew install bash`.
  (`quote-ladder` next door needs 4.4; see [Why bash 3.2](#why-bash-32).)
- **`jq`** and **`mkfifo`**. Tested on jq 1.7.1.
- **Nexus Exchange testnet API credentials.** Not optional here: per-account
  channels are scoped to the wallet that minted the token, so there is no
  public path through this example. Mint a pair with `nexus keys create`, or
  run `nexus setup`.

## Pinned versions

This example pins **`nexus-exchange-cli` 0.4.0**, which reports API spec
**v0.8.1** and SDK `nexus-exchange` 0.9.1 — the exact string it prints is on
the report's `cli` line. There is no lockfile to commit because the CLI ships
as a prebuilt binary rather than a package, so the pin is enforced at runtime:
`nexus --version` is compared against 0.4.0 on every run, and a mismatch is a
refusal rather than a warning. Set `MONITOR_ALLOW_CLI_VERSION=1` to try
anyway.

The pin matters more here than in most examples, because the reconnect
behaviour this app is built around is version-specific — see
[One process per attempt](#one-process-per-attempt).

It targets **testnet** — play funds, no real-world value. `api.nexus.xyz` is
refused by hostname, and that refusal has no override.

## Setup

```bash
cp .env.example .env   # then add your testnet API key pair
```

## Run

```bash
./run.sh --prove-resume
```

Then, to just leave it running:

```bash
./run.sh              # follow every channel, resuming; Ctrl-C to stop
./run.sh --status     # what the cursor store holds; no network
./run.sh --reset      # forget every cursor (takes the lock first)
./run.sh --unlock     # clear a lock a crashed run left behind
```

## Configuration

Environment only — nothing is passed on the command line, because arguments
are visible in the process list. `.env` is read if present, and the real
environment always wins over it.

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_API_KEY` | **yes** | API key id. **Not** `NEXUS_EXCHANGE_API_KEY` — that is the SDKs' name, and the CLI does not read it. |
| `NEXUS_API_SECRET` | yes | API secret (hex) paired with the key. |
| `MONITOR_BASE_URL` | no | REST base. Defaults to `https://api.testnet.nexus.xyz/indexer`. Falls back to `NEXUS_EXCHANGE_API_URL` if that is set and this is not. |
| `MONITOR_WS_URL` | no | WebSocket origin. Defaults to `wss://api.testnet.nexus.xyz/indexer/ws`. |
| `MONITOR_NETWORK_LABEL` | no | Label for the generated custom-network entry. Defaults to `nexus-testnet-indexer`. |
| `MONITOR_CHANNELS` | no | Space-separated per-account channels. Defaults to `orders fills positions balances`. |
| `MONITOR_STATE_DIR` | no | Where the cursor store and the run lock live. Defaults to `.state/` beside the script. |
| `MONITOR_RUN_SECONDS` | no | Wall-clock budget. `0` (default) means run until stopped. |
| `MONITOR_MAX_EVENTS` | no | Per-channel event budget. `0` (default) means no limit. |
| `MONITOR_MAX_ATTEMPTS` | no | Per-channel attach budget. `0` (default) means no limit. |
| `MONITOR_HANDSHAKE_SECONDS` | no | How long to wait for the subscribe ack. Defaults to `30`. |
| `MONITOR_IDLE_SECONDS` | no | Silence tolerated on an open socket before reattaching. Defaults to `300`; `0` disables. |
| `MONITOR_BACKOFF_SECONDS` | no | First reconnect delay, doubling. Defaults to `1`. |
| `MONITOR_BACKOFF_MAX_SECONDS` | no | Backoff cap. Defaults to `30`. |
| `MONITOR_PROVE_AFTER` | no | `--prove-resume`: events to take before severing. Defaults to `3`. |
| `MONITOR_ALLOW_CLI_VERSION` | no | `1` to run against an unpinned CLI. |

`MONITOR_*` rather than `NEXUS_*` on purpose: `NEXUS_*` is the CLI's own
namespace, and a variable that looks like the CLI's but is read by a script
sitting on top of it is a good way to spend an afternoon. The one exception is
`NEXUS_EXCHANGE_API_URL`, honoured as a fallback because it is the
catalog-wide override every other example here reads.

### Exit codes

Because the intended caller is a supervisor — systemd, a container restart
policy — and "it failed" is not enough for any of them to decide whether
restarting will help.

| Code | Meaning |
| --- | --- |
| 0 | Ran and stopped cleanly. Every channel that delivered anything was contiguous, or its hole was explained. |
| 1 | Bad flag, or a configuration value that could not be read. |
| 2 | Preflight refusal: real-funds host, split hosts, missing tool, unpinned CLI, credentials that do not work. |
| 3 | No channel ever acknowledged a subscription. There was nothing to monitor. |
| 4 | **A sequence hole nothing accounts for.** The venue accepted a resume and did not deliver everything it implied it would. This is the failure the app exists to detect. |
| 75 | Another monitor holds the cursor store (sysexits' `EX_TEMPFAIL`). |

## How it works

Seven files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`run.sh`](./run.sh) | Modes, lifecycle, the report, and the verdict. |
| [`lib/cursor.sh`](./lib/cursor.sh) | The durable cursor store and the contiguity check. |
| [`lib/stream.sh`](./lib/stream.sh) | One supervised `nexus ws` per channel, and the frame handling. |
| [`lib/preflight.sh`](./lib/preflight.sh) | Everything checked before the first socket, and the generated CLI config. |
| [`lib/nexus.sh`](./lib/nexus.sh) | The single place the CLI is invoked. |
| [`lib/lock.sh`](./lib/lock.sh) | The single-writer lock over the cursor store. Acquire and release are both rename-aside-then-delete, so an observer never sees a half-removed lock. |
| [`lib/common.sh`](./lib/common.sh) | Logging, exit codes, small guards. |

`decimal.sh` is deliberately absent — this app never does arithmetic on money,
only on sequence numbers. `lock.sh` and `common.sh` are **copied** from
`quote-ladder` rather than imported, per
[CONTRIBUTING § 1](../../CONTRIBUTING.md): a reader should be able to download
this one directory and have it work.

Six decisions are worth copying into whatever you build.

### The cursor is `seq_at_join`, and it does not move on the ack

Two frames carry a sequence, and using the wrong one is the first bug:

```json
{"op": "subscribed", "channel": "fills", "seq_at_join": 8412}
{"op": "event",      "channel": "fills", "seq": 8413, "payload": {…}}
```

**Persist `seq_at_join`, not the first event's `seq`.** The difference shows up
exactly when nothing happens: an account channel can be silent for hours, and
a monitor that waits for an event to learn where it is has no cursor at all if
the socket drops first. `seq_at_join` arrives on every attach, immediately,
whether or not anything is ever published.

**But on a *resume*, do not store it.** This is the most tempting line in the
file: the ack comes back with a bigger number than the cursor, so storing it
looks like progress. It is the opposite. You asked for a replay from `cursor`,
and the venue is about to send `cursor+1 … seq_at_join` — the very events you
reconnected to collect. Writing `seq_at_join` now moves the cursor past them
before they arrive, and a crash mid-replay then resumes *after* the gap it was
replaying. The cursor advances on a delivered event and nothing else, because
a delivered event is the only evidence that an event was folded.

The third case is a sequence that came back **lower** than the stored cursor.
That is an engine epoch bump — [ENG-13641](https://linear.app/nexus-labs/issue/ENG-13641)
records that the epoch-advance path clears the indexer's cursor, sparse set
and gap origin together, so numbering restarts below where you were. Holding
the old cursor waits for events that will never be numbered that high, and the
monitor sits there looking healthy. Nothing replays across an epoch boundary,
so the only honest handling is to refetch over REST, adopt the new sequence,
and record that the run has a hole in it.

### `out_of_sync` is not a reconnect

```json
{"op": "out_of_sync", "channel": "fills", "oldest_seq": 100}
```

Your cursor aged out of the replay buffer, and `oldest_seq` is the earliest
the venue can still serve. There is no value between the two that would work —
so a monitor that resubscribes at the same `--since` is told the same thing
again, forever, while reporting itself healthy and delivering nothing. That
failure mode is the reason this example exists.

The only correct response is the one the spec names: **refetch state over
REST, then resubscribe with a fresh cursor.** "Fresh" means no `--since` at
all; the next ack's `seq_at_join` becomes the new cursor. The events in the
gap are gone — REST re-establishes the *state*, not the history — which is why
the verdict reports this as `recovered` rather than `contiguous`.

### One process per attempt

The CLI reconnects on its own, with backoff and keep-alive. This app kills the
child the moment it reports one. Two reasons, and the first is a live defect:

1. **The token is spent.** `/ws` tokens are single-use and expire after 60
   seconds. At 0.4.0 the CLI mints one *once*, bakes it into the socket URL,
   and hands that URL to the SDK's low-level `connect`, which re-sends the
   same URL — and the same consumed token — on every reconnect. The first
   automatic reconnect is rejected at the upgrade. That is
   [ENG-5291](https://linear.app/nexus-labs/issue/ENG-5291) (cli#76): the
   SDK's `connect_ws` mints a fresh token before every attempt, and the CLI
   does not use it. **A new process mints a new token, so process-level
   reconnection *is* the remint** — which is why this app never bakes a token
   into anything and never handles one itself.
2. **Even fixed, it would resume from the wrong place.** `--since` is read
   from argv once, at launch. A socket that has been up an hour has a cursor
   thousands of sequences ahead of the one it started with; an in-process
   reconnect would re-request all of it, or be told `out_of_sync`. The cursor
   lives on disk, so the only way to reconnect *at* it is to re-read it, which
   means re-launching.

`--since` is also single-valued while each channel's sequence is its own, so
there is **one supervised process per channel** — a constraint the CLI's
surface imposes, and the reason the cursor store is a directory rather than a
file.

### `x-resume-from-sequence` is a different layer

Worth saying plainly, because the name suggests otherwise. `x-resume-from-sequence`
is real, and it is one layer *below* this one: it is the header the **indexer**
sends the **engine** to replay from the engine's event WAL. It does not appear
on the client contract — grep the deployment's own `openapi.json` and it
returns nothing — and no client sends it. The client-facing cursor is `seq` /
`seq_at_join` / `since`, which is what this app uses.

The two meet exactly once. The replay this app requests can only be served out
of a buffer the indexer itself did not lose, so an indexer that never resumes
upstream puts a floor under how lossless any client beneath it can be. Until
[nexus#10356](https://github.com/nexus-xyz/nexus/pull/10356) that was not
hypothetical: the indexer's resume cursor sat at 0 because contiguity was
measured from sequence 1 and a mid-stream join never establishes it, so the
header was never sent and every indexer reconnect was a plain live tail.
`out_of_sync` is the client-visible shadow of that floor.

### Which socket, and why not the other one

Both endpoints are live, and they are different protocols:

```
GET /indexer/ws      401 {"code":"ws_token_missing"} + a valid sec-websocket-accept
GET /indexer/stream  101 Switching Protocols, no token required
```

`/stream` upgrading without a token is not a convenience, it is the tell: token
auth was removed there (ENG-3128) *because* it carries only public market data
and never per-account data. Its protocol is a single untagged
`{"subscribe": ["trades:*"]}` message with **no sequence numbers, no `since`,
and no `out_of_sync`**. So it is not a lighter-weight option for this app — an
account monitor cannot subscribe to an account channel there, and a resumable
monitor has nothing on it to resume from.

### Why this does not just say `--network testnet`

Because that cannot reach this venue at CLI 0.4.0, for two independent reasons:

1. Its REST base is the legacy gateway `https://exchange.nexus.xyz/api/exchange`,
   which answers `500` on every route today (ENG-14039).
2. Its WebSocket origin is **unset**. The SDK reports `None` for testnet on
   purpose — the spec's published origin is a different host from the legacy
   REST base, and pairing them would send a token to a server that never
   issued it — so `nexus ws --network testnet` refuses with "the selected
   network has no WebSocket endpoint" rather than guessing.

The CLI's own answer to both is a **custom network**: a labelled entry carrying
`base_url`, `ws_url` and a declared `funds`. The deprecated `NEXUS_BASE_URL`
override is not a substitute — it redirects REST only, so `nexus ws` would
still refuse, and it leaves `funds` undeclared, which the CLI fails closed on.
This app therefore refuses to run when `NEXUS_BASE_URL` is set at all.

So `run.sh` writes the entry itself, into a throwaway config under its own
state directory, and points the CLI at it with `XDG_CONFIG_HOME`. Three
consequences, all of them the point:

- **Your `~/.config/nexus/config.json` is never read or written.** The example
  cannot break your CLI setup, and uninstalling it is `rm -rf .state`.
- **No credential is written to disk.** The generated file declares the network
  and nothing else; the key comes from the environment, which outranks the file
  and is not namespaced per network.
- **`funds` is declared `play` only after the hostname check that earns it.**

The `ws_url` is written **verbatim, prefix included**. Deriving a bare origin
from the host is a real defect elsewhere in the stack — ENG-14963 found exactly
that in the TypeScript SDK's `customNetwork()`, which drops the `/indexer`
segment — so the value is declared rather than composed, and a test asserts the
prefix survives.

### Why bash 3.2

`quote-ladder` needs bash 4.4 for associative arrays. This one runs on the 3.2
that macOS has shipped since 2007, because a monitor is the thing you leave
running on whatever box you have. The state that would have lived in an
associative array lives in the cursor directory instead — which it had to
anyway, since that is what makes it survive a restart, and since each channel
is supervised by a subshell that cannot write back into its parent's
variables.

## Verifying it without an account

The whole claim of this example — "the resume loses nothing" — is not testable
against a live venue on demand, because it needs the socket to break at a
moment when events are in flight, and waiting for a real disconnect is not a
test. So the venue is stubbed:

```bash
./test/run-tests.sh      # 72 assertions, no network, no account
```

[`test/fake-nexus.sh`](./test/fake-nexus.sh) stands in for the `nexus` binary,
and its `ws` stub is a **replay buffer rather than a script**: `@replay-from`
sends everything strictly after the `--since` it was handed. An app that
resumes from the wrong sequence therefore gets the wrong events and the
assertions catch it — which is the only way a stub can test a resume instead
of testing itself. It also logs the `--since` of every attach, so the suite can
assert on the cursor each reconnect actually used.

Covered: the lossless resume, the ack that must not outrun its own replay, a
cursor surviving across two separate processes, `out_of_sync` clearing the
cursor instead of spinning, an unexplained hole failing the run, a re-delivered
cursor being dropped, an epoch reset, the deliberate severance, an idle channel
refusing to count as a pass, one process per channel, every preflight refusal,
the generated CLI config carrying no credential, and that `.env` is parsed
rather than sourced.

[`test/sample-output.sh`](./test/sample-output.sh) regenerates the block at the
top of this README from the same stub.

## Notes

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
- **The live authenticated path has not been exercised.** No testnet
  credentials were available when this was written and none were generated, so
  every claim about what the venue sends back rests on the deployment's own
  `openapi.json` (fetched live from
  `https://api.testnet.nexus.xyz/indexer/openapi.json`) and on the stubbed
  suite. What *was* verified live, on 2026-09-09: `/indexer` answers `200` and
  the bare host `404`; `/indexer/ws` answers `401 ws_token_missing` with a
  valid `sec-websocket-accept`; `/indexer/stream` answers `101`; the legacy
  `exchange.nexus.xyz/api/exchange` answers `500`; and `api.nexus.xyz` has no
  DNS record. The CLI itself was not installed on that machine either, so the
  `nexus ws` invocations here are written against the 0.4.0 source and its
  `--help`, not against a run of the binary.
- **A monitor is not a reconciler.** It reports what the venue tells it and
  keeps a cursor. It does not maintain a local order book, position table or
  balance sheet from the event stream — that would be a second source of truth
  to get wrong, and `out_of_sync` would make it silently stale. The REST
  refetch on a gap re-reads state rather than replaying into a model.
- **`liquidations` gaps are unrecoverable, and the app says so.** Alerts are
  edge-triggered — one frame per worsening severity transition, nothing while a
  severity holds — subscribing does not replay current state, and there is no
  REST read of them. A transition missed during an outage is simply gone.
- **The verdict is about sequence numbers, not payloads.** `contiguous` means
  no integer is missing between the first and last sequence delivered. It does
  not check that a payload was well-formed or that the venue's numbering is
  honest; a venue that skipped a sequence *and* renumbered would pass.
- **Stdout interleaving is per line.** Each channel's supervisor writes whole
  lines to the shared stdout, which is atomic for lines this short on every
  platform that matters, but the *order* between channels is arrival order and
  nothing more. If you need a total order, sort by channel and sequence
  downstream.
- Not implemented, and out of scope: public channels (they need a market
  threaded through the cursor store, and `trading-terminal` already shows
  them), more than one account, a local projection of the event stream, and
  compaction of the delivered-sequence journal, which grows for the life of a
  run.
