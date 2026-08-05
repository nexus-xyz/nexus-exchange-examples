# Nexus Exchange Examples

Small, complete, runnable apps built on the [Nexus Exchange](https://github.com/nexus-xyz/nexus-exchange-api)
API, SDKs, and CLI. Each directory is one self-contained example: clone it,
point it at testnet with your own API key, and have it running in a few minutes.

> [!NOTE]
> **This repo is being bootstrapped.** The directory convention, the
> `_template/` scaffold, CI, and `CONTRIBUTING.md` land in the next steps of
> setup, followed by the first examples. Until then there's nothing to run here
> yet — this README covers what the repo is for and how contributions work.

## Scope

**Whole apps live here.** Something a reader can run and use — a trading
frontend, an analytics tool, a CLI workflow.

**Minimal API-surface demos stay with their client**, in the `examples/`
directory of the SDK or tool they demonstrate:
[rs](https://github.com/nexus-xyz/nexus-exchange-rs) ·
[ts](https://github.com/nexus-xyz/nexus-exchange-ts) ·
[py](https://github.com/nexus-xyz/nexus-exchange-py) ·
[cli](https://github.com/nexus-xyz/nexus-exchange-cli) ·
[mcp](https://github.com/nexus-xyz/nexus-exchange-mcp).
Those answer "how do I call this endpoint?"; this repo answers "what does a
real app on the Exchange look like?"

## What every example here does

- **One directory, self-contained**, runnable from its own README in under five minutes.
- **Pins the SDK/CLI version** it targets, so a reader gets the behaviour the README describes.
- **Runs against testnet**, with no credentials beyond a user-supplied API key. Nothing secret is ever committed.
- **Is built and typechecked in CI on every PR**, so the catalog can't rot silently.

## Contributing

Contributions are welcome, with one wrinkle worth knowing before you start:

- **Fixing or improving an existing example** — open a pull request directly.
- **Adding a new example** — open a
  [**Propose an example**](https://github.com/nexus-xyz/nexus-exchange-examples/issues/new?template=example_proposal.yml)
  issue first, before you build it. It's a short form. We'll confirm the app
  fits the catalog and isn't already in flight, then you can send the PR. This
  exists so nobody writes a whole app that we then can't merge — not to
  discourage the PR.

You can also use that same form to **request** an example you'd like to see
without building it yourself.

Every PR is reviewed by the Nexus Interfaces team, and CI must pass. The full
contribution guide — directory naming, the `_template/` scaffold, what CI
checks — arrives with the skeleton.

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the Nexus Exchange SDKs.
