# Track 3 — CLI-driven workflows

Workflows built by scripting
[`nexus-exchange-cli`](https://github.com/nexus-xyz/nexus-exchange-cli) — the kind
of thing you would actually run on a schedule or from a shell.

| Example | What it shows |
| --- | --- |
| [`quote-ladder/`](./quote-ladder) | Keeps a ladder of resting post-only orders on one market. Written as a reconciler — desired set, actual set, diff — so a second run with a still market does nothing, which is what makes it safe on a timer. |

Adding one? See [CONTRIBUTING.md](../CONTRIBUTING.md). One example per directory:
`cli/<example-name>/`.
