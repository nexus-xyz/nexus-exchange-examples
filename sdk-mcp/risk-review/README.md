# risk-review

An agent-shaped risk review of one Nexus Exchange account, over the **MCP tool
surface**.

It performs the same check as the `risk-guard` examples under
[`sdk-rust/`](../../sdk-rust) and [`sdk-ts/`](../../sdk-ts) — total notional,
unrealized loss, available margin, against limits you set — but reaches the
exchange through MCP tools rather than a typed SDK. It is read-only: it reports,
and changes nothing.

> [!IMPORTANT]
> **This example does not run yet.** The three account tools it needs are
> unreachable on `@nexus-xyz/exchange-mcp` 0.2.0. The fix is
> [nexus-exchange-mcp#69](https://github.com/nexus-xyz/nexus-exchange-mcp/pull/69),
> which is **not merged and not released** — see
> [Blocked on the MCP server](#blocked-on-the-mcp-server). Everything up to the
> API call works today.

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

## Blocked on the MCP server

**The three account tools this review needs cannot reach the live testnet
deployment on `@nexus-xyz/exchange-mcp` 0.2.0.** The server composes `/api/v1/*`
against the bare host root, which serves the marketing frontend:

```
GET https://exchange.nexus.xyz/api/v1/markets/summary               -> 404 text/html
GET https://exchange.nexus.xyz/api/exchange/api/v1/markets/summary  -> 200 application/json
```

`deriveBases()` strips a trailing `/api/exchange` from `NEXUS_EXCHANGE_API_URL`
before building v1 URLs, so no value of that variable reaches the working path
either. The split is visible from outside: gateway-surface tools such as
`get_service_status` succeed while `list_markets` and `get_tickers` 404.

The fix is
[**nexus-exchange-mcp#69**](https://github.com/nexus-xyz/nexus-exchange-mcp/pull/69)
— "compose the v1 surface under the deployment base, not the host root", the same
model [`nexus-exchange-ts#65`](https://github.com/nexus-xyz/nexus-exchange-ts/pull/65)
adopted for the TypeScript SDK. As of this writing it is **open, not merged, and
therefore not released**.

Two things have to happen before this example runs:

1. **#69 merges**, and
2. **a version carrying it is published to npm.** A merged fix is not an
   installable one — this example pins an exact version from the registry, and
   `npm ci` installs from the lockfile. There is no git-install fallback either:
   the package builds via `prepack`, not `prepare`, and ships only `dist`, so a
   git dependency resolves to an empty package.

### When that release lands, this example must be updated

Not just re-pinned — **#69 is a breaking change** (`fix!:`), so treat this as a
real update rather than a version bump:

- [ ] Bump `@nexus-xyz/exchange-mcp` in `package.json` to the released version
      and re-commit `package-lock.json`.
- [ ] Update the pinned version stated in prose under
      [Pinned versions](#pinned-versions) — CONTRIBUTING requires the README's
      prose and the manifest to agree, and a bumped manifest with a stale README
      is the pin quietly telling the reader something untrue.
- [ ] Re-read #69's final diff for anything that moved: it rewrites
      `src/config.ts`, and if `NEXUS_EXCHANGE_API_URL` or
      `NEXUS_EXCHANGE_GATEWAY_PATH` semantics changed, `src/mcp.ts` builds the
      server's environment explicitly and must change with them.
- [ ] Re-check the tool counts quoted in this README and in `src/mcp.ts` (63
      offered / 16 mutating). They are asserted in prose, not in code, so a
      server that adds a tool makes them wrong silently.
- [ ] Run it end to end against live testnet with real credentials and confirm a
      real breach — #69 itself notes no signed call has been verified with real
      keys, so this example would be the first thing to confirm it.
- [ ] Delete this section and the `[!IMPORTANT]` note at the top.

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
| `NEXUS_EXCHANGE_API_URL` | no | Point the server at another deployment |
| `NEXUS_GUARD_MAX_NOTIONAL` | one of these | Cap on total position notional |
| `NEXUS_GUARD_MAX_LOSS` | one of these | Cap on total unrealized loss, as a positive number |
| `NEXUS_GUARD_MIN_AVAILABLE_MARGIN` | one of these | Floor on available margin |

At least one limit must be set. Limits are parsed as exact decimals and must be
greater than zero; plain decimals only, so `1e5`, `NaN` and `1,000` are refused
rather than guessed at.

## Pinned versions

Pinned to **`@nexus-xyz/exchange-mcp` 0.2.0** and
**`@modelcontextprotocol/sdk` 1.30.0**, exact versions with `package-lock.json`
committed. The exchange-mcp pin is the one that changes when #69 ships — see
[above](#when-that-release-lands-this-example-must-be-updated).
