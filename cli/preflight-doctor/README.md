# preflight-doctor

The command you run before anything else, when you cannot reach the Exchange
and the only thing you have to go on is a `401`.

It answers one question in as many pieces as it takes: **which of the things
between your shell and the venue is the broken one.** Is the host deployed at
all? Is your base URL carrying the path prefix the venue serves under? Is your
WebSocket URL derived from the right place? Is your clock close enough to sign
a request? And only once all of that is settled: are your credentials actually
the problem?

That order is the whole design. Every support question in this area arrives as
the same opaque `401`, and the causes are deliberately indistinguishable from
the status alone — a wrong-network key, a revoked key, a drifted clock and a
signature computed over the old path all return it. You cannot tell them apart
by looking harder at the `401`. You tell them apart by ruling things out from
the bottom up, which is what this does.

It is **read-only**: it places no orders, cancels nothing, and changes no
account setting on any path. And it **never "fixes" anything by trying another
host** — see [Two things it refuses to do](#two-things-it-refuses-to-do).

## What it does

```
$ ./run.sh
preflight-doctor  api.testnet.nexus.xyz  (testnet)
──────────────────────────────────────────────────────────────────────────────
network     testnet — play funds
rest base   https://api.testnet.nexus.xyz/indexer
  from      the testnet default
  prefix    /indexer
ws base     wss://api.testnet.nexus.xyz/indexer
  from      the testnet default
cli         nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)
request id  b4186f33a6bb6b69ab3c52c57d8ae7ba
checked     2026-09-10T04:07:19Z
──────────────────────────────────────────────────────────────────────────────
PASS  env         credentials present in the CLI's namespace — NEXUS_API_KEY set
                  (20 characters, base64url-safe), NEXUS_API_SECRET set (64 characters, hex)
                  → nothing to do.
PASS  override    no NEXUS_BASE_URL is set, so the CLI will use its own --network default
                  → nothing to do.
PASS  cli         nexus 0.4.0, the pinned release
                  → nothing to do.
PASS  dns         api.testnet.nexus.xyz resolves to 2 address(es): 104.21.73.174 172.67.146.161
                  → nothing to do.
PASS  reach       https://api.testnet.nexus.xyz/indexer serves /markets/summary — HTTP 200 from the venue
                  → nothing to do. This base URL is correct.
PASS  routing     authentication runs ahead of routing here: a path that does not exist
                  also answers HTTP 401
                  → so a 401 proves your prefix is right and says nothing about whether
                    your path exists. Only a 404 means a wrong prefix.
WARN  legacy      the legacy base https://exchange.nexus.xyz/api/exchange answers HTTP 500
                  — it proxies to a decommissioned service
                  → this is the default every published SDK and the CLI still ship, so an
                    unconfigured client is pointed at a dead host. Set
                    NEXUS_EXCHANGE_API_URL=https://api.testnet.nexus.xyz/indexer, and
                    NEXUS_BASE_URL=… for the CLI.
PASS  clock       this host's clock is within 2s of the venue's
                  → so a signed-request rejection is not clock skew. One cause eliminated.
PASS  version     venue API 0.9.38, minimum supported 0.0.0
                  → nothing to do. This is a compatibility signal, not a security control.
WARN  lag         the indexer is 12212s behind the engine (x-indexer-lag-ms: 12212487)
                  → reads will answer, and they will be stale by about that much.
WARN  health      the venue reports status 'down' — degraded services: bots
                  → reachable but not healthy. This is the venue's own assessment of
                    itself, not a problem with your configuration.
PASS  ws          wss://api.testnet.nexus.xyz/indexer — /stream upgraded (HTTP 101);
                  /ws is served and token-gated (HTTP 401 with a valid sec-websocket-accept)
                  → a token-gated 401 here is the healthy answer for /ws.
PASS  credentials the CLI authenticated against testnet and read your open orders
                  → nothing to do.
──────────────────────────────────────────────────────────────────────────────
9 passed, 3 warning(s), 0 failed, 0 skipped.
```

Every check produces a verdict **and a next step**. A check that can say "this
is wrong" but not "so do this" generates support tickets rather than closing
them, so the next step is not optional.

`--json` prints the same verdicts as a JSON object for a CI step; `--quiet`
prints the summary line only.

## Prerequisites

- **`curl`**, and the usual `date`, `sed` and `grep`. That is the whole hard
  requirement — the transport checks work with nothing else.
- **bash 4.4 or newer.** Checked at startup. macOS still ships bash 3.2 —
  `brew install bash` and re-run.
- **Optional: `dig`**, for the DNS response code. Without it the check falls
  back to `host`, and then to curl's own exit code.
- **Optional: `jq`**, for the venue's published version window and its health
  snapshot. Those two checks report `skip` without it; nothing else changes.
- **Optional: `nexus-exchange-cli` 0.4.0**, for the credential check only.
  Install it with `curl https://cli.nexus.xyz | sh`, or see the
  [CLI README](https://github.com/nexus-xyz/nexus-exchange-cli#install).
- **Optional: Nexus Exchange testnet API credentials.** Only the credential
  check needs them; mint a pair with `nexus keys create`, or run `nexus setup`.

Everything optional degrades to a `skip`, which is reported as "not checked" —
deliberately distinguishable from "fine".

## Pinned versions

This example pins **`nexus-exchange-cli` 0.4.0**, which reports API spec
**v0.8.1** — the same pin as [`quote-ladder`](../quote-ladder), because two
examples in one track disagreeing about the CLI version is a support question
of its own. There is no lockfile to commit: the CLI ships as a prebuilt binary
rather than a package, so the pin is enforced at runtime instead, by comparing
`nexus --version` on every run.

Unlike `quote-ladder`, a version mismatch here is a **warning, not a refusal**.
A tool that places orders should refuse to run against an unverified command
surface. A tool whose entire job is to explain why nothing works must not be
the twelfth thing that does not work.

It targets **testnet** (play funds) by default. `mainnet` is *allowed* — this
tool is read-only, and "why can I not reach mainnet?" is a question it exists
to answer.

## Setup

```bash
cp .env.example .env   # optional — every transport check runs without it
```

## Run

```bash
./run.sh
```

## Configuration

Environment only — nothing is passed on the command line, because arguments are
visible in the process list. `.env` is read if present, and the real
environment always wins over it.

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_API_KEY` | no | API key id, for the credential check. **Not** `NEXUS_EXCHANGE_API_KEY` — that is the SDKs' name, and the CLI does not read it. There is a check for exactly this mix-up. |
| `NEXUS_API_SECRET` | no | API secret (hex) paired with the key. |
| `NEXUS_EXCHANGE_API_URL` | no | API base URL, overriding the per-network default. **Include the path prefix** — see below. |
| `NEXUS_EXCHANGE_WS_URL` | no | WebSocket base. Defaults to the REST base with the scheme swapped. |
| `DOCTOR_NETWORK` | no | `testnet` (default), `mainnet`, or `local`. |
| `DOCTOR_TIMEOUT_SECONDS` | no | Per-request ceiling. Defaults to `15`. |
| `DOCTOR_WS_TIMEOUT_SECONDS` | no | Ceiling for the upgrade probe. Defaults to `8`. |
| `DOCTOR_CLOCK_SKEW_WARN` | no | Seconds of drift before the clock check warns. Defaults to `5`. |
| `DOCTOR_LAG_WARN_SECONDS` | no | Indexer lag before the lag check warns. Defaults to `60`. |
| `DOCTOR_SKIP_CREDENTIALS` | no | `1` to skip the credential check even with credentials set. |

`DOCTOR_*` rather than `NEXUS_*` on purpose: `NEXUS_*` is the CLI's own
namespace, and a variable that looks like the CLI's but is read by a script
sitting on top of it is a good way to spend an afternoon.

### Exit codes

Because the intended caller is a support script or a CI step, and "it failed"
is not enough for either to decide what to do next.

| Code | Meaning |
| --- | --- |
| 0 | Every check passed. |
| 1 | Bad flag, or a configuration value that could not be read. |
| 2 | At least one check **failed**: the venue is not reachable as configured. |
| 3 | Nothing failed, but at least one **warning** will bite you later. |

## What the verdicts mean

The classifier in [`lib/net.sh`](./lib/net.sh) is the content of this example.
Everything else is scaffolding around one mapping, and the mapping has to be
right — a doctor that misreports the cause is worse than none, because it sends
you off to re-mint a key that was never the problem.

Measured against `api.testnet.nexus.xyz` on 2026-09-09:

| You see | It means | It does **not** mean |
| --- | --- | --- |
| `404` | **The path prefix is wrong.** The only status that means this. | — |
| `401` / `403` | Routing is right; the request reached the venue. | That your path exists, or that your key is bad |
| `503` | Routing is right; the backend behind it is down. | That anything of yours is misconfigured |
| `500` | The host answered and its upstream did not. | — |
| `426` | Your client is older than the venue's minimum. | — |
| `429` | You are being throttled. | That anything is misconfigured |
| nothing | Below HTTP: DNS, TLS, a proxy, a firewall. | — |

### Only a `404` means a wrong prefix

The single most useful thing this tool does is separate *"I am asking the wrong
URL"* from *"I reached the venue and it refused me"*. Two things make that
harder than reading the status code, and both are counter-intuitive.

**Authentication runs ahead of routing.** Under the `/indexer` prefix a path
that does not exist answers `401`, exactly as a real authenticated path does:

```
GET /indexer/account/summary            -> 401 {"code":"UNAUTHORIZED"}
GET /indexer/definitely-not-a-real-path -> 401 {"code":"UNAUTHORIZED"}
```

So a `401` proves your prefix is right and proves **nothing else**. It is not
evidence that the path you asked for exists. The doctor does not assume this —
it probes a path it knows is absent and reports what it finds, so if the
deployment ever changes, the report changes with it.

**A `503` proves your routing is correct.** This is the reverse of the natural
reading. The gateway matched your prefix, tried to forward, and found no
healthy backend — which is a statement about the venue, not about you.

Both of those were confirmed live while this example was being written: the
testnet indexer went down mid-session, and for about an hour every path under
`/indexer` answered `503 no healthy upstream` while the bare host still answered
`404 fault filter abort`. Both come from the same Envoy, both arrive with no
`x-request-id`, and **the status is the only thing that separates them.** That
is why the status code is the rule here and everything else is corroboration.

### The prefix is load-bearing

```
https://api.testnet.nexus.xyz/indexer/markets/summary          -> 200
https://api.testnet.nexus.xyz/indexer/api/v1/markets/summary   -> 200
https://api.testnet.nexus.xyz/markets/summary                  -> 404
https://api.testnet.nexus.xyz/                                 -> 404
```

The indexer is mounted under a `/indexer` path prefix on the shared per-env
hostname and strips it before forwarding, so the app still sees bare spec
paths. Drop it and you get a bare `404` with nothing to go on.

### The base your SDK ships is dead

Every published SDK and the CLI still default to
`https://exchange.nexus.xyz/api/exchange`. That host **500s on every route** —
it proxies to a decommissioned service. So the doctor probes it on every run
whatever network you selected, because a reader whose own base works can still
have a broken client, and this is the check that says so.

That is also why this example accepts `NEXUS_EXCHANGE_API_URL`: until the SDKs
cut over, an override is the only way to point an installed client at a host
that answers.

### WebSocket needs its own check

A correct REST base does not imply a working stream. The TypeScript SDK derived
its WS URL from the bare *origin*, which drops the `/indexer` prefix — REST
keeps working and the stream 404s on connect. Nothing in a REST check catches
that, so the WS bases are probed separately:

```
wss://api.testnet.nexus.xyz/indexer/stream -> 101 Switching Protocols
wss://api.testnet.nexus.xyz/indexer/ws     -> 401, with a valid sec-websocket-accept
wss://api.testnet.nexus.xyz/stream         -> 404
wss://api.testnet.nexus.xyz/ws             -> 404
```

The `401` on `/ws` is the *healthy* answer: the `sec-websocket-accept` header
means the gateway ran the upgrade and the venue then asked for a token
(`{"code":"ws_token_missing"}`). Route real, token missing. Compare the bare
host, which is a flat `404`.

No WebSocket client is needed and none is used — the handshake is an ordinary
HTTP/1.1 request with four headers, and its *response* is the whole answer.

Two SDK-level notes the report repeats where relevant: the TypeScript fix is in
`nexus-exchange-ts#78` and may not be released; and the Rust SDK's
`Network::Testnet.ws_base()` is still `None` in 0.11.0, so a Rust user's WS is
disabled at the SDK level rather than the network one. Those are different
problems with the same symptom.

### Mainnet is not deployed

`api.nexus.xyz` resolves to **no address at all** — confirmed against `1.1.1.1`,
`8.8.8.8` and Cloudflare DoH on 2026-09-09. The doctor says so plainly instead
of timing out.

It is careful about *how* it says it. Under this zone a host with no address and
a host that was never created answer identically — `NOERROR` with an empty
answer section — so the two cannot be told apart from a resolver. The report
says "resolves to no address", which is what was actually observed, rather than
claiming the record does not exist.

### The one `401` cause it can eliminate

Four things produce an identical opaque `401`: a wrong-network key, a revoked
key, a signature over a different path, and a stale request timestamp. Only the
last one is falsifiable from outside the venue, so the doctor compares this
host's clock against the `Date` header on a response it already made. When that
passes, the credential check says so and drops it from the list of suspects.

The other three it reports as an ambiguity rather than picking a favourite. A
wrong-network key is *deliberately* indistinguishable from one that never
existed — same status, no hint that the key is live elsewhere — so guessing here
is how a reader ends up deleting a key that worked.

## Redaction: the output is safe to paste

This tool exists to be run when something is broken, and its output exists to be
pasted into a bug report. So the output has to be safe to paste **on every path,
including the failing ones**. A doctor that echoes a rejected API secret into a
terminal has turned a configuration problem into a credential leak, and nobody
notices until it is in someone else's issue tracker.

Two layers, because either alone has a hole:

1. **Nothing formats a credential into a line.** A key is reported as a shape —
   `set (64 characters, hex)` — never as a value, and deliberately not even as a
   prefix. The temptation is to print the first four characters "so you can tell
   which key it is", and it is worth resisting: a key id prefix identifies an
   account in a support channel, and a reader who needs to tell two keys apart
   can compare lengths.
2. **Every byte of foreign text is filtered.** curl's stderr, the CLI's stderr,
   anything off the wire goes through `redact` before printing. That is the
   layer covering the paths nobody thought about — an error that quotes the
   request it tried to sign, a stack trace, a verbose dump. Layer 1 is the
   design; layer 2 makes it true anyway.

`redact` **over-redacts on purpose**: it replaces the registered secrets, then
any long high-entropy run that looks like one. It will sometimes eat something
harmless, and that is the right direction to be wrong in. Where an identifier is
genuinely worth quoting in a bug report — the `x-request-id` — the tool extracts
it deliberately and prints it in the header, rather than hoping it survives the
filter.

Credentials reach the CLI through the environment and are never passed as
arguments, because arguments are visible in the process list. `.env` is
**parsed, never sourced** — `source .env` is a code-execution primitive, and the
one file whose purpose is to hold a credential is the last one to hand to a
shell. Even the warning about an unparsable `.env` line prints the line *number*
and not the line, since a mangled `.env` line is as likely as not to be a
mangled secret.

## Two things it refuses to do

**It never fails over to another host.** That is the one "recovery" that must
never be automated: it points a client that believed it was on play funds at
real ones. The doctor probes several hosts and *reports* them all — the base you
configured, the legacy base your SDK ships — and leaves the choice with you. It
never retries a failing request somewhere else and calls it fixed.

**It never writes.** No orders, no cancels, no account settings. The one
authenticated call it makes is `nexus orders`, a read.

## How it works

Five files, each about one problem. The comments in them are the real
documentation; this is the map.

| File | What it owns |
| --- | --- |
| [`run.sh`](./run.sh) | Modes, check order, and the report. |
| [`lib/common.sh`](./lib/common.sh) | Exit codes, logging, redaction, the verdict table. |
| [`lib/config.sh`](./lib/config.sh) | Which host, which prefix, and where that came from. |
| [`lib/net.sh`](./lib/net.sh) | The probes, and the classifier. The content of the example. |
| [`lib/checks.sh`](./lib/checks.sh) | One function per check, each producing one verdict. |

Three decisions worth copying into whatever you build.

### A skip is not a pass

"Not checked" and "fine" are different answers, and collapsing them is how a
diagnostic lies. Every check whose prerequisite is missing records `skip` and
names the prerequisite. A reader with no CLI installed sees `skip credentials`,
not silence and not a green tick.

### Each check names the thing it cannot distinguish

Where a signal is genuinely ambiguous, the report says so instead of picking the
most likely cause. The credential check lists its three remaining suspects. The
DNS check says "resolves to no address" rather than "the record does not exist".
The routing check reports what a `401` means *on this deployment today*, having
just probed it, rather than asserting it from a comment written months ago.

### The transport checks do not need the thing being diagnosed

Everything except the credential check runs with no CLI, no credentials and no
`jq`. A diagnostic that cannot run until the thing it diagnoses is working is
not a diagnostic — and "my CLI will not start" is exactly when you most need to
know whether the venue is up.

## Verifying it without an account

```bash
./test/run-tests.sh      # 53 assertions, no network, no account
```

The suite covers the classifier's full status mapping, the redactor on each path
a secret could take, the verdict table's precedence, and two `set -euo pipefail`
regressions that both shipped as bugs during development — each of which made
the tool **exit 1 having printed nothing at all**, which is the worst possible
failure for a diagnostic:

- `(( 0 >= 8 ))` is false and therefore *exits 1*. As the last statement of a
  loop it made `redact_register` return 1, killing the run at the call site —
  and registering no secrets is the normal case for a reader running the public
  checks.
- A `grep` that matches nothing exits 1, `pipefail` promotes that to the whole
  pipeline, and the command substitution inherits it. An absent header is normal,
  so `header_value` had to survive one.

A third bug worth knowing if you write shell for two platforms: `sed 's/…/\L\1/'`
is a GNU extension that BSD sed does not implement. On macOS it silently
produced nothing, and every header-derived check — request id, clock,
rate-limit, indexer lag — degraded to "not available" with no error anywhere.

## Notes

- Runs against **testnet** (play funds) by default. It is an example, not
  production-hardened code.
- **The credential check has not been run against a live account.** It needs a
  funded testnet account, which needs a wallet-signed `nexus keys create`. Every
  transport check here was run end to end against live testnet, including
  against a real outage. The credential path's *logic* is covered by the offline
  suite; what a stub cannot confirm is the exact wording the CLI uses when a key
  is rejected.
- **It diagnoses, it does not repair.** Every next step is something for you to
  do, deliberately. The one class of automated repair that would be tempting —
  switching hosts until one answers — is the one that must never be automated.
- **The version check is advisory.** The `x-nexus-api-version` header is
  unauthenticated, so it is a compatibility signal and not a security control.
  Measured 2026-09-09, sending `0.0.1` and `99.0.0` both returned `200`: the
  venue publishes its window and does not currently enforce it.
- **A verdict is a snapshot.** Every measured claim in this README carries the
  date it was measured. The venue's health, the indexer's lag and the state of
  the legacy base all move; the classifier is what should not.
- Not implemented, and out of scope: probing more than one network per run,
  checking a custom stage declared under `custom_networks`, testing rate-limit
  tier headroom by consuming it, and anything at all that writes.
