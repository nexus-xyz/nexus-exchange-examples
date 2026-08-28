# Nexus Exchange Examples

Small, complete, runnable apps built on the [Nexus Exchange](https://exchange.nexus.xyz)
API, SDKs, and CLI — in the spirit of [vercel/examples](https://github.com/vercel/examples).
Every directory is one self-contained app: clone it, point it at testnet with
your own API key, and have it running in a few minutes.

## Running any example

Every example follows the same shape, so the steps are always these:

1. **Pick one** from the [index](#examples) below and `cd` into its directory.
2. **Read its README.** It lists the prerequisites, the one command to run, and
   the exact SDK/CLI version it pins.
3. **Copy `.env.example` to `.env`** and add your own testnet API key, if the
   example needs credentials — many only read public market data and need none.
4. **Run the single command** its README gives you.

Every example targets **testnet** (play funds), needs no credentials beyond your
own API key, and is built or typechecked in CI on every PR — so what you clone
is what the README describes.

Get testnet API credentials from the [Nexus Exchange](https://exchange.nexus.xyz)
app; each example's README says whether it needs them.

## Scope: whole apps here, API demos with their client

This repo owns **whole apps** — something you can run and use, like a trading
frontend, an analytics tool, or a CLI workflow.

**Minimal API-surface demos stay with their client**, in the `examples/`
directory of the SDK or tool they demonstrate:
[rs](https://github.com/nexus-xyz/nexus-exchange-rs/tree/main/examples) ·
[ts](https://github.com/nexus-xyz/nexus-exchange-ts/tree/main/examples) ·
[py](https://github.com/nexus-xyz/nexus-exchange-py/tree/main/examples) ·
[cli](https://github.com/nexus-xyz/nexus-exchange-cli/tree/main/examples) ·
[mcp](https://github.com/nexus-xyz/nexus-exchange-mcp/tree/main/examples).

The dividing line: those answer *"how do I call this endpoint?"* — one file, one
call, no app around it. This repo answers *"what does a real app on the Exchange
look like?"* If your example is a single script demonstrating one method, it
belongs with its client, not here.

## Examples

Examples are grouped by **track** — what the app is built on.

### Track 1 — [`exchange-api/`](./exchange-api) · the Exchange API directly (REST + WebSocket)

Apps that talk to the API without an SDK, for readers working in a language we
don't ship a client for.

| Example | What it shows |
| --- | --- |
| [`trading-terminal/`](./exchange-api/trading-terminal) | A terminal trading desk for one market: HMAC request signing by hand, the `op`-envelope WebSocket protocol, exact decimal money arithmetic, and a write path that places one order and guarantees it is cancelled. Zero runtime dependencies. |

### Track 2 — one whole app per SDK

| SDK | Directory | Examples |
| --- | --- | --- |
| Rust | [`sdk-rust/`](./sdk-rust) | _None yet._ |
| TypeScript | [`sdk-ts/`](./sdk-ts) | [`risk-guard/`](./sdk-ts/risk-guard) — watches one account against exposure, loss and margin limits, and cancels resting orders when one is breached |
| Python | [`sdk-python/`](./sdk-python) | [`risk-guard/`](./sdk-python/risk-guard) — watches one account against exposure, loss and margin limits, and cancels resting orders when one is breached |
| MCP | [`sdk-mcp/`](./sdk-mcp) | [`risk-review/`](./sdk-mcp/risk-review) — reviews one account over the MCP tool surface, with an explicit read-only allowlist |

### Track 3 — [`cli/`](./cli) · CLI-driven workflows

Apps built by scripting [`nexus-exchange-cli`](https://github.com/nexus-xyz/nexus-exchange-cli).

| Example | What it shows |
| --- | --- |
| [`quote-ladder/`](./cli/quote-ladder) | A ladder of resting post-only orders, kept on one market by a script you can put in a crontab: a reconciler over the CLI, idempotent through derived client order ids, with exact decimal money arithmetic in bash and a single-writer lock. |

### Track 4 — [`analytics/`](./analytics) · market-data and history tools

Tools built on the market-data and history endpoints — reporting, backtesting,
and analysis rather than order placement.

| Example | What it shows |
| --- | --- |
| [`market-report/`](./analytics/market-report) | A venue-wide market report — candles, funding, volume and the venue's own event stats — written to a terminal table, a CSV and a self-contained HTML page. No credentials, no dependencies, and mostly about the data validation an analytics tool needs before it computes anything. |

### Track 5 — builder codes

A trading frontend using builder codes. Not started; the underlying feature
isn't ready yet.

## Repository layout

```
/
├── README.md              you are here — the catalog index
├── CONTRIBUTING.md        standards every example must meet
├── _template/             copy-to-start scaffold (with a runnable TS stub)
├── exchange-api/          track 1
├── sdk-rust/              track 2
├── sdk-ts/
├── sdk-python/
├── sdk-mcp/
├── cli/                   track 3
├── analytics/             track 4
└── .github/workflows/     CI — builds/typechecks every example
```

One example per directory, exactly one level inside its track:
`<track>/<example-name>/`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full
convention.

## Contributing

Contributions are welcome, with one wrinkle worth knowing before you start:

- **Fixing or improving an existing example** — open a pull request directly.
- **Adding a new example** — open a
  [**Propose an example**](https://github.com/nexus-xyz/nexus-exchange-examples/issues/new?template=example_proposal.yml)
  issue first, before you build it. It's a short form. We'll confirm the app fits
  the catalog and isn't already in flight, then you send the PR. This exists so
  nobody writes a whole app that we then can't merge — not to discourage the PR.

You can also use that same form to **request** an example you'd like to see
without building it yourself.

Start from [`_template/`](./_template), and read
[CONTRIBUTING.md](./CONTRIBUTING.md) for the standards and the review process.

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the Nexus Exchange SDKs.
