# Track 4 — market-data and history tools

Reporting, backtesting, and analysis tools built on the market-data and history
endpoints. Reads, not order placement.

Examples land here based on **what they teach**, not what they are written with: a
funding-history report in Python belongs here, not in `sdk-python/`. See the
[tie-break rule](../CONTRIBUTING.md#where-your-example-goes).

| Example | What it shows |
| --- | --- |
| [`market-report/`](./market-report) | A venue-wide report over candles, funding and the venue's own event stats — terminal, CSV and a self-contained HTML page. Mostly a lesson in validating a venue's history before computing on it: this API answers a request for daily candles with minute candles, and says nothing. |

Adding one? See [CONTRIBUTING.md](../CONTRIBUTING.md). One example per directory:
`analytics/<example-name>/`.
