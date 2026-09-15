# Track 4 — market-data and history tools

Reporting, backtesting, and analysis tools built on the market-data and history
endpoints. Reads, not order placement.

Examples land here based on **what they teach**, not what they are written with: a
funding-history report in Python belongs here, not in `sdk-python/`. See the
[tie-break rule](../CONTRIBUTING.md#where-your-example-goes).

| Example | What it shows |
| --- | --- |
| [`market-report/`](./market-report) | A venue-wide report over candles, funding and the venue's own event stats — terminal, CSV and a self-contained HTML page. Mostly a lesson in validating a venue's history before computing on it: this API answers a request for daily candles with minute candles, and says nothing. |
| [`funding-carry/`](./funding-carry) | Which market pays the best carry, and how noisy that carry has been. A lesson in stating a quantitative convention: the settlement interval is derived from the data rather than assumed, the annualisation is spelled out, and a market with too few settled windows is listed unranked instead of given a confident-looking number. The two funding endpoints return different schemas, and its two parsers refuse each other's shapes. |

Adding one? See [CONTRIBUTING.md](../CONTRIBUTING.md). One example per directory:
`analytics/<example-name>/`.
