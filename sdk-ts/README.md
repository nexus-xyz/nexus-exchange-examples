# Track 2 — TypeScript SDK

Whole apps built on [`nexus-exchange-ts`](https://github.com/nexus-xyz/nexus-exchange-ts).

Single-call API demos belong in that repo's own `examples/` directory, not here —
see the [scope rule](../README.md#scope-whole-apps-here-api-demos-with-their-client).

| Example | What it does |
| --- | --- |
| [`risk-guard`](./risk-guard) | Watches one account against exposure, loss and margin limits, and cancels resting orders when one is breached. |

Adding one? Copy the runnable stub to start:
`cp -r _template/stub-ts sdk-ts/<example-name>`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
