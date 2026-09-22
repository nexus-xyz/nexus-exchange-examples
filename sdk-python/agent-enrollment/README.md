# agent-enrollment

Delegating trading to a scoped, expiring **agent key**, built on the
**Python SDK**.

An agent key is an Ethereum-derived keypair that signs trading requests on a
wallet's behalf. The owning wallet authorizes it once, with an EIP-712 signature
made on the owner's machine; the bot then runs holding only the agent key. The
wallet's key never reaches the bot, and the delegation expires on its own.

This app enrolls one, lists it, proves the venue accepts it, and revokes it —
so you can see the whole lifecycle, and what the agent can and cannot do, in one
run.

```text
agent-enrollment on https://api.testnet.nexus.xyz/indexer (play funds)
  will enroll an agent key, prove it, and revoke it before exiting
  EIP-712 domain: name='Nexus Exchange' version='1' chainId=11155111
    read from https://api.testnet.nexus.xyz/indexer/metadata — not guessed, not defaulted
  owner wallet:   0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
  agent key:      0x23B01Ff551B0dd1B727eec4BF028CD0684B3b2F3 (generated here)
  expires:        2026-09-19T14:46:11Z (1d) — nonce 1789742771814
  signature:      65 bytes, withheld — on this endpoint it is the credential
before:
  delegated now: no agent keys registered
register: POST /agents/register — unauthenticated; the signature is the credential
  registered 0x23b01ff...4b3b2f3 until 2026-09-19T14:46:11Z
after:
  delegated now: 1 agent key(s)
    0x23b01ff...4b3b2f3 expires 2026-09-19T14:46:11Z label=agent-enrollment-example
  the venue accepted a signature from the agent key alone (0x23B01Ff...4B3b2F3)
    and issued a session token for it — withheld, it is a bearer credential
revoke: DELETE /agents/0x23b01ff...4b3b2f3
  revoked
  delegated now: no agent keys registered
```

## What it does, and what you learn from it

This is the missing piece under every other write example in this catalog. A
[`risk-guard`](../risk-guard), an [`order-loader`](../../exchange-api/order-loader)
or a [`quote-ladder`](../../cli/quote-ladder) left running unattended is holding
a credential that can trade, and nothing here showed how to give a bot one that
is **scoped and expiring** rather than handing over the wallet.

Four calls, end to end:

| Call | Authenticated by |
| --- | --- |
| `GET /agents` | your API key (HMAC) |
| `POST /agents/register` | **nothing** — the EIP-712 signature in the body *is* the credential |
| `GET /agents` | your API key |
| `DELETE /agents/{address}` | your API key |

The registration is the one worth stopping on. It carries no session token and no
API key: the server recovers the owner's address from the signature, so the
signature is the authorization. That makes the signed bytes the whole security
surface — and one field inside them is the thing this example is really about.

### Read the signing domain. Never guess it.

The EIP-712 domain is `{ name: 'Nexus Exchange', version: '1', chainId: <per-network> }`
over `RegisterAgent(address agent, uint64 expiresAt, uint64 nonce)`. The `name`
and `version` are contract-level constants, identical on every deployment — which
is why the SDK will not let you override them. `chainId` is the one field that is
per-network and **server-authoritative**, and it is the entire reason a
registration signed for one network is invalid on another.

So [`domain.py`](./domain.py) reads `signing_domain.chain_id` from `GET /metadata`
**on the host this run will register with**, and refuses to sign if it cannot get
it. Refuses — not falls back, not defaults. There are two ways a wrong domain
goes wrong and only one of them is loud:

- a **wrong** chain id fails verification, which is annoying and self-announcing;
- a chain id belonging to **another network** verifies — *somewhere else*. You
  get a valid delegation on a network you did not intend, out of an operation you
  believed had failed.

The second is what the refusal is for, and it is real code rather than a comment:
run `python enroll.py --dry-run` against a host that will not serve `/metadata`
and it exits `69` having signed nothing.

Three corollaries, each of which has its own test:

- **There is no fallback map to fall back to.** The SDK ships the spec's
  `x-nexus-networks` map (`nexus_exchange.networks`), and every entry in it
  carries `chain_id=None` deliberately: the static map does not publish the value,
  and `None` means *unknown*. `domain.fallback_chain_id` says so in code so a
  release that changes it fails a test rather than quietly baking a chain id into
  a client nobody re-reads when a network moves.
- **Mainnet is Ethereum Mainnet**, reached via the USDX bridge — it is not a
  Nexus L1 chain, so a Nexus L1 chain id is never correct there. Deriving a chain
  id from a network's name is exactly the reasoning this refusal exists to stop.
- **Never replay a registration across networks.** The chain id is inside the
  digest, so the same agent, expiry and nonce signed for a different network are
  different bytes. A registration is scoped to one network by construction;
  carrying one across is at best a rejection and at worst a delegation you did
  not mean to make. Credentials in general never cross networks here — session
  tokens, API keys and agent keys are all minted per network.

There is a smaller trap underneath that one. The chain id has to come from the
host the registration is *sent* to, and `nexus_exchange.Client` does not expose
the base it resolved. `client.network.base_url` is not it: construct
`Client(Network.TESTNET, base_url=X)` and requests go to `X` while the config
still reports testnet's own base. An app reading the chain id from that field
would sign under one host's domain and register on another's — silently, and only
when an override was in play. So the base URL is decided once in
[`config.py`](./config.py) and handed to both.

### Why the expiry is the point

`expires_at` is not bookkeeping. An agent key is a standing authorization to
trade, and the expiry is the only thing that bounds it without anyone having to
remember anything. Revocation depends on someone noticing; an expiry does not.

So the default here is **one day** — the shortest the venue accepts, since it
expects an expiry in `[now+1d, now+90d]`. That bound is also enforced locally,
*before* signing, because a rejected registration is still a signed registration
and a signed registration is a bearer credential whether or not anyone accepted
it.

An unbounded delegation is the wrong default for the same reason a password with
no rotation is: the failure it causes is silent and arbitrarily far in the
future. A bot that has been compromised and a bot that is merely finished look
identical from the venue's side, and only the expiry distinguishes them without a
human in the loop. Pick the shortest interval your deployment can renew within,
not the longest one that spares you the renewal.

### Why it always revokes

The registration is undone in a `finally`, so the middle of this script failing
does not leave a live delegated key behind — an example that did would be
teaching the opposite of its own lesson. Two things follow:

- **Shutdown signals are deferred** across the window where a key exists. A
  Ctrl-C between register and revoke is the one keystroke that turns this example
  into the thing it warns about, so the handler records the signal, the revoke
  finishes, and the process then exits `130`. A handler that *raises* — which the
  default `KeyboardInterrupt` does — would be the obvious version and the wrong
  one: under [PEP 475](https://peps.python.org/pep-0475/) the interpreter runs
  the handler before retrying a syscall a signal interrupted, so it can tear down
  the in-flight request, and the request it is most likely to tear down is the
  revoke. Same rule as [`risk-guard`](../risk-guard): never let a signal abort the
  undo.
- **A failed revoke is loud** — exit `75` (`EX_TEMPFAIL`, "the user is invited to
  retry", which is exactly the instruction) and the address printed with it.
  "Registered but not revoked" is the one outcome of this program that leaves
  state on someone's account, and nobody should have to notice it for themselves.

### What the proof step does and does not show

After registering, the app signs in with the **agent key alone** and checks that
the address the venue recovered is the agent's. That is a genuine end-to-end
check: those bytes were produced by the agent key, on this machine, with the
wallet key nowhere in the request, and the venue read them the same way.

Being precise, because overclaiming here would be worse than skipping it: that
proves the agent key is a working identity at this venue. What proves the
*delegation* is `GET /agents` listing it against this wallet, which is the step
either side of it. The stronger proof — placing an order as the agent — needs the
session token to be usable on a client, and `nexus-exchange` 0.4.0 has no way to
pass one: `Client` takes HMAC credentials only, and `sign_in` hands the token back
for a future session-authenticated client that does not exist yet.

## Prerequisites

- Python 3.12+. (The SDK requires 3.10+; CI installs and typechecks against 3.12.)
- A **testnet** wallet private key, for the wallet doing the delegating. Generate
  a throwaway one for this rather than pasting a key you use anywhere else.
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).
  Listing and revoking are signed calls. `--dry-run` needs neither.

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then fill it in and export it
```

## Run

```bash
python enroll.py
```

That is the whole lifecycle: enroll, list, prove, revoke. `--dry-run` reads the
signing domain and signs the registration locally without sending anything, and
needs no API credentials:

```bash
python enroll.py --dry-run
```

`--dry-run` is the whole command line besides `--help`. Anything else is
**refused** rather than ignored, because every near-miss — `--dryrun`, `-dry-run`,
`--dry-run=true` — would otherwise leave you believing nothing would be sent
while the app registered a key against your account.

### Tests

```bash
python -m unittest -q
```

40 tests, no network and no credentials. The refusal rules and the config parsers
are pure and are covered exhaustively, because the refusals *are* the example and
a version bump must not be able to remove one quietly.

The EIP-712 digest is pinned by a **known answer**: the domain separator and the
struct hash are recomputed here from the spec text, independently of the SDK, and
the signature is recovered back to the signing address. A test that only asserted
"65 bytes came back" would pass against a signer using the wrong domain, which is
the single failure this example is about. A second test verifies the same
signature against another chain id's digest and shows it recovers to a *different*
address — which is what "does not verify on another network" actually means.

The rest run the real SDK and real `httpx` against a **real HTTP server on the
loopback interface** rather than a mock. A mock of an SDK proves the mock matches
the test's idea of it; a socket proves the SDK composes the URL, signs the request
and decodes the body the way this app assumes.

CI runs them: the Python recipe ends with `unittest discover`.

## Configuration

Everything is read from the environment; nothing is read from a committed file.
See [`.env.example`](./.env.example).

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_WALLET_PRIVATE_KEY` | yes | The delegating wallet's key. Signs the registration **locally**; never sent, never printed |
| `NEXUS_EXCHANGE_API_KEY` | unless `--dry-run` | Testnet API key, for the signed list and revoke |
| `NEXUS_EXCHANGE_API_SECRET` | unless `--dry-run` | Paired secret, 32-byte hex |
| `NEXUS_AGENT_PRIVATE_KEY` | no | The agent's key. Generated from the OS CSPRNG when unset |
| `NEXUS_AGENT_TTL_DAYS` | no | Delegation lifetime in whole days, 1–90, default 1 |
| `NEXUS_AGENT_LABEL` | no | Label echoed back by `GET /agents`, default `agent-enrollment-example` |
| `NEXUS_EXCHANGE_API_URL` | no | Point at another deployment — used for `/metadata` and every request alike |

Two things about how these are parsed are worth copying.

**Private keys are never echoed.** Every other parser here quotes what it was
given, because seeing what you typed is how you find the typo. A key is the one
input where that trade runs the other way: an error message is the most-copied
string a program produces, so the key parsers report the expected shape and
nothing about the bytes — not even a length, which is itself a fact about a
secret.

**Everything else is refused rather than guessed at.** `NEXUS_AGENT_TTL_DAYS`
takes plain ASCII digits only: `1_0`, `1e1`, `7.0` and `١٠` are all things `int()`
accepts with a plausible-looking reading, and this value is how long someone else
can trade your account. Same standard, and the same `[0-9]` rather than `\d`, as
[`risk-guard`](../risk-guard).

Delegating a wallet to itself is refused too. The two variables differ by one
word, and a self-delegation gives up the entire property an agent key exists for
while looking exactly like a registration that worked.

## Which deployment it talks to

**Testnet — play funds.** `Network.TESTNET` is named explicitly in `enroll.py`
rather than left to the default, so nobody has to guess whose money this
delegates authority over, and the base is passed alongside it.

Both halves are load-bearing. Naming the network is what keeps `funds=PLAY`
truthful. Passing the base is what makes it *reachable*: `nexus-exchange` 0.4.0
resolves `Network.TESTNET` to the legacy `https://exchange.nexus.xyz/api/exchange`
gateway, and that gateway now answers 500 on every route. The durable per-network
base — `https://api.testnet.nexus.xyz/indexer`, the `/indexer` prefix included,
since the bare host 404s — is what the rest of this catalog moved to (ENG-14959,
and [`analytics/market-report`](../../analytics/market-report)). Naming a network
*and* overriding the URL keeps that network's funds semantics, which is the SDK's
documented behaviour and the right one here: the host being supplied is testnet's
own, not something a caller handed us.

`NEXUS_EXCHANGE_API_URL` is the case where that stops being true, so it takes the
other path — `NetworkConfig.custom(..., funds=Funds.UNKNOWN)`, and the first line
of output says `funds not declared`. Keeping `Network.TESTNET` there would print
"play funds" over a host this app knows nothing about, which is the one lie a tool
that delegates trading authority must not tell. It is spelled out with
`NetworkConfig.custom` rather than a bare `base_url=` because the bare selector is
deprecated (ENG-10955), and because it makes the funds classification something
this app states rather than something it inherits.

`Network.MAINNET` needs no guard of our own: the SDK refuses to resolve a base for
it, locally, before any bytes leave the process. There is a `Funds.REAL` refusal
in `run` anyway — unreachable by any path this app offers, and kept because an
example whose subject is delegating trading authority is the wrong place to leave
the real-funds branch to an argument about why it cannot be taken.

## Pinned versions

Pinned to **`nexus-exchange` 0.4.0** (the Python SDK), with `httpx` 0.28.1 and
`mypy` 2.3.1.

`httpx` is a direct dependency here, unlike in the sibling examples. The SDK ships
no reader for `GET /metadata`, which is where the chain id lives, so this example
makes that one request itself — with the SDK's own transport rather than a new
dependency or a reach into `Client._request`.

There is no lockfile format to commit here, so `requirements.txt` is one: the
SDK's transitive tree is pinned by `==` too, at the versions this example was
verified against. A pin on the direct dependency alone is not reproducible — the
tree underneath it would still float, and a reader a year from now would get
different bytes than this README describes.

## Notes

- It is an example, not production-hardened code. It enrolls one key, proves it,
  and revokes it; it keeps no state across runs and has no renewal loop.
- **To actually keep a key**, lift `plan()` and the register call and drop the
  `finally`. That is deliberately not a flag: this app always revokes, because an
  example that could leave a live delegated key behind is one that eventually
  does.
- Exit codes follow `sysexits.h`: `0` clean, `69` `EX_UNAVAILABLE` for a signing
  domain that could not be read (nothing signed, nothing sent), `75`
  `EX_TEMPFAIL` for registered-but-not-revoked, `77` `EX_NOPERM` for credentials,
  `65` `EX_DATAERR` for another terminal failure, `1` for a configuration error.
  A deferred signal exits the shell's way, `128 + signum` — `130` for Ctrl-C —
  after the revoke has run.
- The registration signature is never printed. `POST /agents/register` is
  unauthenticated, so those 65 bytes *are* the credential: anyone holding them can
  register that agent key against that wallet until the nonce is spent. The rest
  of the body is printed, since seeing what you are about to send is the point of
  a dry run.
- The nonce is the current Unix-ms timestamp, which the spec suggests as a safe
  starting value: monotonic across runs on a sane clock, and needing no state kept
  between them.
- **Not verified: a live run against the real venue.** At the time of writing
  `https://api.testnet.nexus.xyz/indexer` answers `503 no healthy upstream` on
  every route, so the four venue calls have been exercised against a local server
  that implements them, not against testnet. What *was* verified live is the
  refusal: pointed at the real host, `--dry-run` reports the 503 and exits `69`
  without signing. Flagged rather than left implicit.
- Not implemented, and out of scope: renewing a delegation before it lapses,
  running a bot on the resulting key (the SDK cannot carry a session token yet —
  see "What the proof step does and does not show"), and enrolling more than one
  key at a time.
