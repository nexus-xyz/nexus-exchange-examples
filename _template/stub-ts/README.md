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

This example pins **`@nexus-xyz/exchange-ts` `0.2.0`** exactly (no `^`), plus
`tsx` `4.23.8` and `typescript` `7.0.2` for running and typechecking. It targets
**testnet** — play funds, credited by the faucet, with no real-world value.

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
| `NEXUS_EXCHANGE_API_URL` | no | API base URL, e.g. `https://<host>/api/v1`. Overrides the testnet default host — see below. |
| `NEXUS_EXCHANGE_API_KEY` | no | API key. Without it, only public market data is fetched. |
| `NEXUS_EXCHANGE_API_SECRET` | no | API secret (32-byte hex) paired with the key. |

### About the host

The stub asks for `Network.Testnet` explicitly, which resolves to
`https://exchange.nexus.xyz/api/v1`. That host **did not serve `/api/v1` from the
machine this stub was written on** — every market-data route returned the web
app's 404 page — so if you get a 404 you are probably not doing anything wrong.

Set `NEXUS_EXCHANGE_API_URL` to a base URL that works for you and it takes
precedence over the network default. With no reachable host the stub prints that
instruction and exits 1 rather than dumping a stack trace.

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
