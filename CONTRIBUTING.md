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
- **Prerequisites** — the toolchain and versions needed (e.g. Node 22+, Rust 1.80+).
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
the README describes, not a silently-upgraded SDK and a broken app.

**Commit your lockfile** too — `package-lock.json`, `Cargo.lock`, or a
`requirements.txt` with every dependency pinned by `==`. A pin on your direct
dependency isn't reproducible on its own: without a lockfile the transitive tree
still floats. It's also what gives Dependabot something to bump per example, and
those bumps are reviewed like any other change. CI installs from the lockfile
(`npm ci`, `cargo build --locked`, `pip install -r requirements.txt`), so a
missing one fails the build.

When you review a Dependabot bump, update the version your README states in prose
in the same PR — a bumped manifest with a stale README is the pin quietly telling
the reader something untrue.

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
silently. If your example doesn't build, it doesn't merge — `CI` is a required
status check on `main`.

Your example has to give CI something to check it with, which is a per-language
requirement:

| Language | Must ship | CI runs |
| --- | --- | --- |
| Node / TypeScript | `package-lock.json`, and a `typecheck` or `build` script | `npm ci`, then those scripts |
| Rust | `Cargo.lock` | `cargo build --locked --all-targets` |
| Python | `requirements.txt`, everything pinned by `==`, including `mypy` | `pip install -r requirements.txt`, `compileall`, `mypy .` |
| Shell (CLI workflows) | at least one `*.sh`, and a README | `bash -n` and `shellcheck` on every script |

Your example's **language comes from its manifest, not its track.** An MCP
example is a Node or Python project and is checked as one — `sdk-mcp/` says what
the app is built on, not what toolchain builds it.

See [How CI gates your PR](#how-ci-gates-your-pr).

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

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) discovers examples from
the directory convention above — every directory one level inside a track, plus
[`_template/stub-ts`](./_template/stub-ts), which is checked like an example
because it's what every TS example is copied from — and builds or typechecks each
one according to its language. Adding an example needs no workflow edit. Your PR
merges only when every example still builds, including yours: `CI` is a required
status check on `main`.

You can run the discovery step exactly as CI does:

```bash
python3 .github/scripts/discover-examples.py
```

**Discovery fails rather than skipping anything it doesn't recognise.** A
directory CI silently ignores is worse than no CI at all, because its existence
gets read as coverage. It fails on a directory that says nothing about how to
check it, a name that isn't `kebab-case`, manifests for two languages in one
directory, and an example placed anywhere but one level inside a track.

It fails just as hard on a gate that would pass while checking nothing: a missing
lockfile, a Node example with no `typecheck` or `build` script, a Python example
that doesn't pin `mypy`. Each of those would go green having verified nothing —
the failure mode this whole workflow exists to prevent, so it isn't allowed to
happen to the workflow itself.

Each language job caches its toolchain (npm, cargo, pip), so a PR that touches one
example doesn't pay for the rest of the catalog.

**Adding an example in a language nothing here uses yet?** Discovery fails on it,
and your PR adds the recipe to `ci.yml` alongside the example. Deliberately a
little inconvenient: it's how the gate stays real instead of quietly not covering
your language.

CI runs offline: it builds and typechecks, and does not place orders or require
credentials. No secrets are available to it, and it uses a read-only token. If
your example includes a live smoke check against testnet, it must degrade
gracefully when no credentials are present — skip, don't fail.

CI does not run your example, so building green isn't proof it works. Say in your
PR that you ran it end-to-end from a clean clone.

## Review

- [`.github/CODEOWNERS`](./.github/CODEOWNERS) auto-requests the Nexus Interfaces
  team on every PR. One approval from a code owner is required, and pushing to
  your branch dismisses stale approvals, so a review after a force-push or a new
  commit is a fresh review.
- **`CI` is a required status check on `main`**, so a red build blocks the merge
  button rather than relying on someone noticing. It's a single job that passes
  only when every discovered example passed, which is why it — and not the
  per-language jobs — is the required one: the language jobs are a dynamic matrix
  and skip entirely when a language has no examples, so none of them is a name
  branch protection could depend on.
  > **If you rename it, re-point the protection rule.** A required check that no
  > longer runs blocks every PR forever, and the fix is a repo setting, not a
  > commit.
- `main` requires linear history; PRs are squash-merged.
- Reviewers read your example's README **as a reader would** and try to run it
  from a clean clone. If the five-minute path doesn't work, that's the review
  comment you'll get first.

Keep PRs focused: one example, or one fix, per PR.

## License

Contributions are dual-licensed under [MIT](./LICENSE-MIT) or
[Apache-2.0](./LICENSE-APACHE), matching the repo. By opening a PR you agree your
contribution is licensed under both.
