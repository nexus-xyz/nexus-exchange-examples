# Contributing

Thanks for helping build the Nexus Exchange examples catalog. This document
covers the standards every example must meet, where it goes, and how a PR is
reviewed.

## Before you build: propose it

**New examples start as an issue, not a pull request.**

- **Fixing or improving an existing example** — open a PR directly. No proposal
  needed.
- **Adding a new example** — open a
  [**Propose an example**](https://github.com/nexus-xyz/nexus-exchange-examples/issues/new?template=example_proposal.yml)
  issue first. It's a short form: what the app does, which track, and who's
  building it.

We'll confirm the app fits the catalog and isn't already in flight, then you send
the PR. The point is to spare you writing a whole app we then can't merge — not
to add ceremony. Same form works if you'd like to *request* an example without
building it yourself.

## Standards every example must meet

These are non-negotiable, and a reviewer will check each one.

### 1. Its own self-contained directory

One example per directory. It builds and runs from that directory alone, with no
shared root manifest, no workspace linking, and no reaching into a sibling
example. Copy a helper rather than importing one from next door — a reader should
be able to download one directory and have it work.

### 2. Its own README, runnable in under five minutes

Every example has a `README.md` covering, at minimum:

- **What it does** and what a reader learns from it.
- **Prerequisites** — the toolchain and versions needed (e.g. Node 20+, Rust 1.80+).
- **One command to run it.** Not a sequence of six. Setup may be a couple of
  steps (`npm install`, copy `.env`), but running it is a single command.
- **The pinned SDK/CLI version** it targets, stated in prose so it's visible
  without reading the manifest.
- **Whether it needs credentials**, and which environment variables.

Start from [`_template/EXAMPLE_README.md`](./_template/EXAMPLE_README.md), which
has these as headings already.

The five-minute bar is real: from `cd` to running output, on a machine that has
the toolchain but has never seen this repo.

### 3. A pinned SDK/CLI version

Pin exact versions, not ranges — `"@nexus-xyz/exchange-ts": "0.2.0"`, not
`"^0.2.0"`. A reader running the example a year from now should get the behaviour
the README describes, not a silently-upgraded SDK and a broken app. Dependabot
proposes bumps per example, and they're reviewed like any other change.

### 4. Testnet, and no credentials beyond a user-supplied API key

- Examples target **testnet** (play funds) and must never be pointed at real
  funds. Name the network explicitly rather than relying on the default — e.g.
  `network: Network.Testnet` — so a reader never has to guess whose money an
  example moves, and say in your README which deployment it talks to.
  > **Worth knowing:** accept an API base URL override from
  > `NEXUS_EXCHANGE_API_URL`, as [`_template/stub-ts`](./_template/stub-ts) does.
  > The testnet default host does not serve `/api/v1` from every network, so
  > without an escape hatch a reader behind the wrong DNS gets a bare 404 and no
  > way forward.
- Read credentials from the **environment**, never from a committed file. Ship a
  `.env.example` documenting the variables; `.env` itself is gitignored.
- Never commit a key, secret, token, or seed phrase. Not even an expired or
  testnet one.
- Don't require any credential the reader can't create themselves in the
  Exchange app. No shared team keys, no service accounts.
- Prefer public market data where the example can make its point without
  credentials at all — the best examples run with no setup.

### 5. It builds in CI

CI builds or typechecks **every** example on every PR, so the catalog can't rot
silently. If your example doesn't build, the PR doesn't merge. See
[How CI gates your PR](#how-ci-gates-your-pr).

## Where your example goes

Examples are grouped by **track** — what the app is built on:

| Track | Directory | For |
| --- | --- | --- |
| 1 | `exchange-api/` | Apps calling the REST + WebSocket API directly, no SDK |
| 2 | `sdk-rust/`, `sdk-ts/`, `sdk-python/`, `sdk-mcp/` | Apps built on one of the SDKs |
| 3 | `cli/` | Workflows scripting `nexus-exchange-cli` |
| 4 | `analytics/` | Market-data and history tools — reporting, backtesting, analysis |

The path is always `<track>/<example-name>/` — exactly one level inside the
track. No deeper nesting, no examples at the repo root.

**If an example could sit in two tracks, its primary teaching intent wins.** A
funding-history report written in Python teaches analytics, not the Python SDK,
so it goes in `analytics/`, not `sdk-python/`. A trading dashboard that happens
to chart some history is still a trading app. When it's genuinely 50/50, say so
in your proposal issue and we'll pick one — being in the "wrong" directory is a
much smaller problem than the same example existing twice.

### Naming

Lowercase `kebab-case`, and name it after **what the app is**, not what it's
built with — the track directory already says that. `order-book-viewer`, not
`ts-order-book-example`. Skip `nexus-`, `example-`, and `demo-` prefixes; the
whole repo is Nexus examples.

## Getting started

```bash
git clone https://github.com/nexus-xyz/nexus-exchange-examples.git
cd nexus-exchange-examples

# Copy the scaffold into your track. The TS stub is a runnable starting point:
cp -r _template/stub-ts sdk-ts/my-example

# Or, for another language, start from the README template alone:
mkdir -p analytics/my-example
cp _template/EXAMPLE_README.md analytics/my-example/README.md
cp _template/.env.example      analytics/my-example/.env.example
```

[`_template/stub-ts`](./_template/stub-ts) is a working app — install, run, and
you'll see live testnet markets before you've written a line. See
[`_template/README.md`](./_template/README.md) for what to change after copying.

## How CI gates your PR

CI discovers examples from the directory convention above — every directory one
level inside a track — and builds or typechecks each one according to its
language, so adding an example needs no workflow edit. A PR merges only when
every example still builds, including yours.

CI runs offline: it builds and typechecks, and does not place orders or require
credentials. If your example includes a live smoke check against testnet, it must
degrade gracefully when no credentials are present — skip, don't fail.

> **Note:** CI is being stood up now (tracked internally as ENG-9226). Until it
> lands, reviewers verify builds by hand — so please state in your PR that you
> ran the example end-to-end from a clean clone.

## Review

- [`.github/CODEOWNERS`](./.github/CODEOWNERS) auto-requests the Nexus Interfaces
  team on every PR. One approval from a code owner is required, plus green CI.
- `main` requires linear history; PRs are squash-merged.
- Reviewers read your example's README **as a reader would** and try to run it
  from a clean clone. If the five-minute path doesn't work, that's the review
  comment you'll get first.

Keep PRs focused: one example, or one fix, per PR.

## License

Contributions are dual-licensed under [MIT](./LICENSE-MIT) or
[Apache-2.0](./LICENSE-APACHE), matching the repo. By opening a PR you agree your
contribution is licensed under both.
