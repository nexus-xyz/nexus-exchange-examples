# Track 2 — TypeScript SDK

Whole apps built on [`nexus-exchange-ts`](https://github.com/nexus-xyz/nexus-exchange-ts).

Single-call API demos belong in that repo's own `examples/` directory, not here —
see the [scope rule](../README.md#scope-whole-apps-here-api-demos-with-their-client).

| Example | What it does |
| --- | --- |
| [`risk-guard`](./risk-guard) | Watches one account against exposure, loss and margin limits, and cancels resting orders when one is breached. |
| [`dead-mans-switch`](./dead-mans-switch) | Arms cancel-on-disconnect, holds the WebSocket the venue keys it off, rests one order, then SIGKILLs its own session so you can watch the exchange cancel for you. |
| [`bracket-orders`](./bracket-orders) | Places an entry plus reduce-only take-profit and stop-loss exits sized to what filled, keeps them one-cancels-other off the WebSocket with every decision taken from a REST read, and leaves the position protected on Ctrl-C. |
| [`twap-executor`](./twap-executor) | Works one parent order as timed IOC child orders that never cross your limit, paced on spec weights against budgets read from the venue, and resumable after a crash through derived client ids and a write-ahead journal. |

Adding one? Copy the runnable stub to start:
`cp -r _template/stub-ts sdk-ts/<example-name>`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
