# Security Policy

## What lives in this repo

Every directory here is an **example application**, written to be read and
learned from. Examples target **testnet**, take an API key only from the
environment, and are not hardened for production use. Please don't point one at
mainnet credentials without reviewing what it does first.

## Reporting a vulnerability

**Please report security vulnerabilities privately** using GitHub's
[**Report a vulnerability**](https://github.com/nexus-xyz/nexus-exchange-examples/security/advisories/new)
button on this repository's **Security** tab. Private vulnerability reporting
is enabled, so your report stays confidential until a fix is ready.

Please **do not** open a public issue, pull request, or discussion for a
security vulnerability — that discloses it before users can patch.

We'll acknowledge your report as quickly as we can and keep you updated on the
fix and any coordinated disclosure.

If the issue is in the Exchange API itself or in one of the clients rather than
in an example here, report it on that repository instead — the SDKs
([rs](https://github.com/nexus-xyz/nexus-exchange-rs),
[ts](https://github.com/nexus-xyz/nexus-exchange-ts),
[py](https://github.com/nexus-xyz/nexus-exchange-py)),
the [CLI](https://github.com/nexus-xyz/nexus-exchange-cli), the
[MCP server](https://github.com/nexus-xyz/nexus-exchange-mcp), or the
[API spec](https://github.com/nexus-xyz/nexus-exchange-api).

For general (non-security) bugs, use the regular [issue templates](./ISSUE_TEMPLATE).
