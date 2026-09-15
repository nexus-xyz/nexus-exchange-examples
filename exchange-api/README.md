# Track 1 — the Exchange API directly

Whole apps that call the Nexus Exchange REST + WebSocket API without an SDK —
for readers working in a language we do not ship a client for, or who want to see
the wire protocol, signing, and stream handling done by hand.

| Example | What it shows |
| --- | --- |
| [`trading-terminal/`](./trading-terminal) | A terminal trading desk for one market: HMAC request signing by hand, the `op`-envelope WebSocket protocol, exact decimal money arithmetic, and a write path that places one order and guarantees it is cancelled. Zero runtime dependencies. |
| [`order-loader/`](./order-loader) | A bulk order loader: reads a file of orders, refuses what the venue would reject before sending anything, and submits the rest through `POST /orders/batch` in weight-optimal chunks — paced against rate-limit budgets read from `GET /account/rate-limit` rather than hardcoded from the tier table. Dry-runs by default. |

Adding one? See [CONTRIBUTING.md](../CONTRIBUTING.md) and start from
[`_template/`](../_template). One example per directory: `exchange-api/<example-name>/`.
