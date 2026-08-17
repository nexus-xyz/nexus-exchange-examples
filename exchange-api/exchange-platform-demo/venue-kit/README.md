# Venue kit

**Status:** Working code, prototype scope. **Owner:** Daniel Marin.

The connective layer between a branded terminal and the published Nexus Exchange API. Four modules,
58 tests, zero runtime dependencies.

```bash
npm install
npm test         # node --experimental-strip-types --test
npm run typecheck
```

Node 22.6+ — the kit is TypeScript run through Node's native type stripping, so there is no build
step and no bundler.

## What is here

| Module | Does |
| --- | --- |
| `src/decimal.ts` | Exact decimal arithmetic over the API's decimal strings. A fee is a receivable; IEEE-754 is the wrong tool. |
| `src/tenant.ts` · `src/tenants.ts` | `TenantConfig` and the registry. One deploy = one venue = one legal entity. |
| `src/sign.ts` | HMAC request signing, canonical string taken from the indexer that verifies it. |
| `src/builder/fee.ts` | The additive builder fee, the 10 bps cap, and the order-time disclosure. |
| `src/builder/ledger.ts` | Builder-code attribution, emulated — see below. |
| `src/venue.ts` | The proxy: allowlist → sign → forward → attribute. |

## The builder-code emulation, and why it works this way

The offering sells a builder fee. The API cannot carry one.

In `openapi.json` 0.8.1, `OrderRequest` has thirteen fields and not one of them is a client order id,
a tag, or free-form metadata. `Order` echoes back only what the engine assigned. `Fill` carries
`order_id`, `fee`, and no builder axis. There is nowhere on the wire to write *"this flow came from
Acme"* — which means `BUILD-PLAN.md` Phase 1d, "extend `serializeOrderRequest` to emit
`builder_code`", cannot be built as written. The terminal's own test suite reached the same
conclusion independently, in `lib/api/place-order.test.ts`: *"`POST /orders` carries no client order
id in the vendored spec, so the venue cannot recognise a resubmission."*

So attribution moves to the only component that sees both the tenant identity and the outbound
order: the venue's signing proxy. It records `order_id → tenant` at submission, then joins that
against `GET /fills` — which does carry `order_id` — to derive filled notional per builder code, and
from that the fee the venue would have earned.

**What this buys.** It is exact for every order the venue submitted. It needs no backend change. And
it is the same join the real feature performs once `builder_code` exists on the wire, so the
dashboard built on it survives the cutover — only the source of the attribution changes.

**What it costs, stated plainly.** It is venue-side bookkeeping, not venue-authoritative truth. Lose
the ledger and attribution is gone, because it cannot be reconstructed from the exchange. And
nothing here charges anybody: the fee is *accrued*, never collected, no USDX moves, and the 10 bps
cap is a venue-side clamp rather than an enforced invariant. Every rollup carries
`attributionAuthoritative: false` so a caller cannot render the number as authoritative without
first deleting the field that says it is not.

Two details the join gets right that a naive version does not:

- **Amends.** `PATCH /orders/{id}` is cancel-replace — it retires an id and returns a new one,
  carrying filled quantity across. `recordAmend` links the chain so an amended order does not drop
  out of attribution mid-life.
- **Foreign flow.** The same account can trade through several frontends. Fills whose order this
  venue did not submit are skipped, never claimed — over-attribution is the failure the real feature
  must avoid too.

## The proxy is the branded API, in miniature

`src/venue.ts` exists because the HMAC secret cannot ship to a static bundle. That server hop then
turns out to be the only place attribution can live, and the shape a per-partner deployment on
`api.acme.xyz` would take. Phase 1 and Phase 5 are the same component at different scales.

Its routes are **allowlisted, not passed through**. The proxy signs with a key that can trade and
move funds; a blind pass-through would hand any caller `POST /withdrawals` and `POST /keys` under the
venue's own credential. Anything outside the set is refused before a signature exists.

## What this kit does not do

Deliberately out of scope, so nobody builds against a fiction:

- **No charging.** Server-side charge, cap enforcement, and crediting are greenfield in the engine
  and settlement path.
- **No market data.** Use `@nexus-xyz/exchange-ts` for public reads and the WebSocket stream; this
  kit only fronts the signed routes.
- **No key minting.** `POST /auth/login` and `POST /keys` are off the allowlist. Provisioning a
  venue key is an operator step, not a browser flow.
- **No persistence.** `AttributionLedger` is in-memory. A real venue swaps the store without
  touching the join.
