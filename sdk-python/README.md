# Track 2 — Python SDK

Whole apps built on [`nexus-exchange-py`](https://github.com/nexus-xyz/nexus-exchange-py).

Single-call API demos belong in that repo's own `examples/` directory, not here —
see the [scope rule](../README.md#scope-whole-apps-here-api-demos-with-their-client).

| Example | What it does |
| --- | --- |
| [`risk-guard`](./risk-guard) | Watches one account against exposure, loss and margin limits, and cancels resting orders when one is breached. |
| [`agent-enrollment`](./agent-enrollment) | Delegates trading to a scoped, expiring agent key — enrolls it, lists it, proves it, revokes it — reading the EIP-712 signing domain from the venue and refusing to sign without it. |

Adding one? See [CONTRIBUTING.md](../CONTRIBUTING.md). One example per directory:
`sdk-python/<example-name>/`.
