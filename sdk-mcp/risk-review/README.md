# risk-review

An agent-shaped risk review of one Nexus Exchange account, over the **MCP tool
surface**.

It performs the same check as the `risk-guard` examples under
[`sdk-rust/`](../../sdk-rust) and [`sdk-ts/`](../../sdk-ts) — total notional,
unrealized loss, available margin, against limits you set — but reaches the
exchange through MCP tools rather than a typed SDK. It is read-only: it reports,
and changes nothing.

```text
risk-review on the testnet deployment (play funds)
tool surface: 63 tools offered, 16 of them mutating — this review uses 3,
all read-only (get_balance, get_positions, get_open_orders)

positions: 2    resting orders: 3
ok max-notional: notional 812.40 vs limit 1000
!! max-loss: unrealized -61.40 (loss 61.40) vs limit 50

BREACHED — at least one limit is over.
  3 resting order(s) would be worth cancelling. This app does not cancel —
  see sdk-rust/risk-guard for the armed version.
```

## What you learn from it

With an SDK, an app can only call the functions someone wrote into it. With MCP,
the app — or the model driving it — can call **anything the server offers**, and
this server offers 63 tools, 16 of which move money or change account settings:
`place_order`, `amend_order`, `deposit_collateral`, `claim_credit`,
`submit_deposit`, `set_tier`.

So the interesting engineering in an MCP app is not "how do I call a tool", which
is one line. It is **how do I bound what may be called at all**.

**An agent's blast radius is its tool list.** This review needs three read calls.
`src/mcp.ts` declares them in one `ALLOWED_TOOLS` array and refuses anything else
at the single point where the transport is reachable — so there is no second path
to keep in sync, and widening the blast radius is a visible edit rather than a
quiet capability. The check is a runtime one on purpose: tool names are strings
arriving from a subprocess, and a type cannot hold that line.

**Verify the tool contract before trusting it.** The review asserts its three
tools exist during startup, so a server that renamed one fails immediately with
the name in the message rather than deep inside the run.

**Build the subprocess environment explicitly.** Handing `process.env` to a child
gives it every secret in your shell — cloud tokens, other exchanges' keys — for
no reason. Only the variables the server documents are forwarded, and
`NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` is conspicuously never set, which is why the
server registers 63 tools rather than its full 66: unset means the operator-only
tools do not exist on the surface at all, which is stronger than not calling them.

**Reap the child.** A stdio MCP server is a real subprocess. Every exit path —
success, a failed handshake, a bad limit, a thrown parse — goes through one
`finally`, so a run cannot leave an orphaned server behind. That is the whole
concurrency story: one call at a time, one child, always reaped.

**A limit has three outcomes, not two.** Position risk fields are nullable and
carry a paired reason (`notional_value` / `notional_value_error`). Reading a
missing notional as zero would report "under the limit" at the exact moment the
app has no idea what the exposure is. So `src/risk.ts` reports `within`,
`breached` or `unknown`, and `unknown` never counts as safe.

**But `unknown` is not a licence to stop reasoning.** `notional_value` is
`|size| × mark price`, so it is never negative and a partial sum is a *lower
bound* on the true total. A bound already over the limit is a **proven** breach —
nothing missing can bring it back under — so it is reported as `breached`, with
the wording saying "at least". `unknown` is kept for the bound that could still
land either side. The same argument covers a flat position: at `size == 0` the
notional is provably zero whatever the mark price is, so it is skipped rather
than counted as missing, which stops one stale dust position pinning
`max-notional` to `unknown` forever. Refusing to act on a fact the app already
has is the mirror image of the bug the third outcome exists to prevent.

There is no model in the loop, on purpose: an LLM in the middle would make the
output non-reproducible, need a second API key, and obscure the part worth
reading. See [Using it from Claude](#using-it-from-claude) for the actual agent
experience once you have seen what the surface can reach.

## Prerequisites

- Node 22+ (the MCP server requires Node 20+).
- Testnet API credentials, created in the [Exchange app](https://exchange.nexus.xyz).

## Running it

```bash
npm install
cp .env.example .env      # then add your key, secret and at least one limit
npm start
```

Exit code is `0` when every limit is within range, `2` on a breach, and `1` on a
configuration or protocol error — so it is usable from cron without parsing
stdout.

## Which deployment it talks to

**Testnet — play funds.** The network is named explicitly rather than left to a
default, and the review's first line says which target and what its funds are, so
nobody has to guess whose money is being read.

`NEXUS_EXCHANGE_API_URL` points the server at another deployment. Pass the
**deployment base** (`https://<host>/api/exchange` on a gatewayed host, or a bare
origin for an indexer serving at its root); the server composes both REST
surfaces under it and adds `/api/v1` itself.

That last sentence is the whole reason this example needs
`@nexus-xyz/exchange-mcp` **0.3.0 or newer**, and it is worth knowing if you
build on an older pin. Through 0.2.0 the server composed `/api/v1/*` against the
bare host root, which on the public deployment serves the marketing frontend:

```
GET https://exchange.nexus.xyz/api/v1/account               -> 404 text/html        (Next.js frontend)
GET https://exchange.nexus.xyz/api/exchange/api/v1/account  -> 401 application/json (auth reached)
```

Every authenticated tool — including the three this review uses — was therefore
unreachable, while the 28 gateway-surface tools composed correctly and worked.
That split is what made it survive: `get_service_status` answered while
`get_balance` returned a web page.
[nexus-exchange-mcp#69](https://github.com/nexus-xyz/nexus-exchange-mcp/pull/69)
fixed it by hanging **both** surfaces off one deployment base — the base names
the deployment, the path names the surface — the same model
[`nexus-exchange-ts#65`](https://github.com/nexus-xyz/nexus-exchange-ts/pull/65)
adopted for the TypeScript SDK. Signing was never affected: the HMAC covers the
logical path (`/api/v1/account`), never the deployment prefix, because the
gateway strips its own prefix before the indexer verifies.

## Using it from Claude

The same server this app drives can be handed to Claude directly. Point an MCP
client at the copy in this example's `node_modules`, so you get the pinned
version rather than whatever is installed globally:

```json
{
  "mcpServers": {
    "nexus-exchange": {
      "command": "node",
      "args": ["./node_modules/@nexus-xyz/exchange-mcp/dist/index.js"],
      "env": {
        "NEXUS_EXCHANGE_NETWORK": "testnet",
        "NEXUS_EXCHANGE_API_KEY": "...",
        "NEXUS_EXCHANGE_API_SECRET": "..."
      }
    }
  }
}
```

Worth knowing before you do: an agent given this server has all 63 tools,
including the 16 that move money. This example's allowlist is a property of *this
app*, not of the server — a model talking to the server directly is not bounded
by it.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | yes | Testnet API key |
| `NEXUS_EXCHANGE_API_SECRET` | yes | Paired secret, 32-byte hex |
| `NEXUS_EXCHANGE_API_URL` | no | Point the server at another deployment — the deployment base, not the `/api/v1` path ([details](#which-deployment-it-talks-to)) |
| `NEXUS_GUARD_MAX_NOTIONAL` | one of these | Cap on total position notional |
| `NEXUS_GUARD_MAX_LOSS` | one of these | Cap on total unrealized loss, as a positive number |
| `NEXUS_GUARD_MIN_AVAILABLE_MARGIN` | one of these | Floor on available margin |

At least one limit must be set. Limits are parsed as exact decimals and must be
greater than zero; plain decimals only, so `1e5`, `NaN` and `1,000` are refused
rather than guessed at.

## Pinned versions

Pinned to **`@nexus-xyz/exchange-mcp` 0.3.0** and
**`@modelcontextprotocol/sdk` 1.30.0**, exact versions with `package-lock.json`
committed.

0.3.0 is a floor, not just a pin: on 0.2.0 every authenticated tool this review
calls returned the marketing site's 404 rather than data. Do not pin this example
back — see [Which deployment it talks to](#which-deployment-it-talks-to).

## Notes

- It is an example, not production-hardened code. It reviews one account, keeps
  no state between runs, and has no alerting beyond stdout and the exit code.
- **Not verified: a signed call with real credentials.** The routing is
  confirmed — unauthenticated, `…/api/exchange/api/v1/account` answers `401`
  `application/json`, where 0.2.0 got a `404` HTML page from the marketing app —
  but confirming that a *valid* HMAC is accepted needs testnet keys, which this
  example was written without. It is worth stating rather than implying, because
  an invalid signature is answered by an edge proxy with an HTML `403`, and at
  that layer a rejected signature and a routing fault look identical. The
  upstream fix shipped with the same caveat.
- Money is never a float. Values arrive as decimal strings and are parsed by
  `src/decimal.ts` onto `BigInt`; a limit check is a comparison against a sum,
  which is exactly where binary floating point would decide the wrong way.
- A limit has three outcomes, not two: `unknown` never counts as safe, and a
  failed read is never allowed to read as "no exposure". `unknown` is also not a
  licence to stop reasoning — a partial notional sum is a lower bound, so a bound
  already over the limit reports `breached`, not `unknown`.
- The tool counts in this README (63 offered, 16 mutating) are prose, not
  assertions in code, so a server release that adds a tool makes them stale
  silently. They are re-checked on every version bump.
