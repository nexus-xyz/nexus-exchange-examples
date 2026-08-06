<!--
README template for a new example. Copy this to your example directory as
README.md and fill in every section; delete these HTML comments as you go.

The bar: a reader who has the toolchain but has never seen this repo gets from
`cd` to running output in under five minutes, following only what's below.
-->

# <example-name>

<!--
One or two sentences: what the app is, and what a reader learns from it. Lead
with the app, not the API surface.

Good:  "A terminal order book viewer that streams live depth for one market, so
        you can see how to keep a local book in sync from the WebSocket feed."
Weak:  "Demonstrates the fetchOrderBook and subscribe methods."
-->

## What it does

<!-- A short bullet list, or a screenshot / sample output block. Sample output is
     worth a lot here — it tells a reader what success looks like. -->

-

## Prerequisites

<!-- Toolchain and minimum versions. Be specific: "Node 22+", not "Node". State
     the version you actually tested on, not the oldest one you assume works. -->

- Node 22 or later
- A Nexus Exchange **testnet** API key — <!-- delete this line if not needed -->
  create one in the [Exchange app](https://exchange.nexus.xyz)

## Pinned versions

<!--
State the pinned SDK/CLI version in prose, so it's visible without opening a
manifest. Pin exact versions, never ranges.
-->

This example pins **`@nexus-xyz/exchange-ts` `<version>`** and targets the
Exchange API on **testnet**.

## Setup

```bash
npm install
cp .env.example .env   # then add your API key  <!-- delete if no credentials -->
```

## Run

<!-- ONE command. If running it takes more than one command, move the rest into
     Setup above. -->

```bash
npm start
```

## Configuration

<!--
Every environment variable you read, what it's for, and whether it's required.
Delete this section if the example needs no configuration.
-->

| Variable | Required | What it's for |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_KEY` | no | API key. Without it, only public market data is available. |
| `NEXUS_EXCHANGE_API_SECRET` | no | API secret (32-byte hex) paired with the key. |

## How it works

<!--
Optional but valuable: the two or three things a reader should understand — the
non-obvious decision, the pattern worth copying, the trap you avoided. This is
where an example earns its place over API reference docs.
-->

## Notes

<!-- Limitations, deliberate simplifications, what you'd do differently in
     production. Being honest here is more useful than pretending the example is
     production-grade. -->

- Runs against **testnet** (play funds). It is an example, not
  production-hardened code.
