# stub-ts

A minimal, working TypeScript app on the Nexus Exchange — the copy-to-start point
for a TS example. It reads public market data, then makes one authenticated call
if you've supplied credentials.

This is the shape every example in the catalog follows, and it doubles as a
filled-in reference for [`../EXAMPLE_README.md`](../EXAMPLE_README.md). Rewrite
this file for your app after copying.

## What it does

- Fetches every market summary and prints how many there are.
- Prints last and mark price for the first market, plus top of book.
- If `NEXUS_EXCHANGE_API_KEY` / `NEXUS_EXCHANGE_API_SECRET` are set, fetches the
  account and prints equity, balance, and open-position count. Skips it cleanly
  when they aren't.

## Prerequisites

- Node 20 or later
- Optionally, Nexus Exchange API credentials — create them in the
  [Exchange app](https://exchange.nexus.xyz). The public market-data output works
  without any.

## Pinned versions

This example pins **`@nexus-xyz/exchange-ts` `0.1.0`** exactly (no `^`), plus
`tsx` `4.23.8` and `typescript` `7.0.2` for running and typechecking.

## Setup

```bash
npm install
cp .env.example .env   # optional — only for the authenticated call
```

## Run

```bash
npm start
```

## Configuration

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_URL` | see below | API base URL, e.g. `https://<host>/api/v1`. Overrides the SDK's default host. |
| `NEXUS_EXCHANGE_API_KEY` | no | API key. Without it, only public market data is fetched. |
| `NEXUS_EXCHANGE_API_SECRET` | no | API secret (32-byte hex) paired with the key. |

### About the host

The pinned SDK 0.1.0 knows three networks — `Stable`, `Beta`, `Local` — and
defaults to `Stable` (`https://exchange.nexus.xyz/api/v1`). At the time of
writing that host does not serve `/api/v1`, so **set `NEXUS_EXCHANGE_API_URL` to
the API base you've been given**; without a reachable host the stub prints that
instruction and exits 1 rather than dumping a stack trace.

Note also that 0.1.0 has no `Network.Testnet` member — the testnet/mainnet
network axis landed in the SDK after this release. When your example needs to
name a network, pin an SDK version that has it and say so here.

## How it works

Three things worth copying:

- **Credentials are optional and read from the environment.** The example does
  something useful with none, which means a reader gets output before doing any
  setup, and CI can build and run it without secrets.
- **The host is configurable.** Nothing is hardcoded to one deployment.
- **Failures explain themselves.** `ApiError` and `TransportError` are caught and
  turned into an instruction, because "which host?" is the first-run problem
  every reader hits.

## Notes

- It is an example, not production-hardened code: no reconnect logic, no rate-limit
  handling beyond the SDK's own retries, no persistence.
- It places no orders and makes no state-changing calls — reads only.
