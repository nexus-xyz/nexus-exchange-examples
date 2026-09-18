"""Which deployment this runs against, and whose money is behind it.

This is the first module because it is the one a port gets wrong silently. CCXT
code says ``ccxt.binance()`` and the exchange knows where it lives; the adapter
takes a target and then **hides it** — :class:`~nexus_exchange.ccxt_adapter.NexusExchange`
keeps no public reference to its :class:`~nexus_exchange.Client`, so its only
public attributes are ``markets`` and ``symbols``. There is no ``ex.urls['api']``
to print, and the client is there only under a private name, which is not
somewhere an example should reach. Measured, not assumed.

So the app has to remember what it built, and state it in its own first line.
That is the whole job here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from nexus_exchange import Client, Funds, NetworkConfig

#: Testnet's durable REST base — play funds, no real-world value.
#:
#: Not ``Network.TESTNET``, and the difference is load-bearing. The SDK's own
#: testnet descriptor resolves to ``https://exchange.nexus.xyz/api/exchange``,
#: which is a **decommissioned** gateway: measured on 2026-09-18, every route
#: under it answers `500` with an HTML error page — `/markets`, `/api/v1/tickers`
#: and `health_check` alike. Passing ``Network.TESTNET`` here would therefore
#: produce an example that cannot run, on a host the SDK still calls the default.
#: The rest of this catalog moved to the same base for the same reason
#: (`exchange-api/trading-terminal`, ENG-14959; `analytics/market-report`).
#:
#: The ``/indexer`` prefix is part of the base, not decoration. The whole API —
#: the `/api/v1` surface and the host-root `/markets` route alike — is mounted
#: under it, and `https://api.testnet.nexus.xyz/api/v1/...` is a 404.
DEFAULT_BASE_URL = "https://api.testnet.nexus.xyz/indexer"

#: Label for the built-in target. A :class:`NetworkConfig` label is a *key* — it
#: namespaces stored credentials — so it is spelled out rather than derived.
TESTNET_LABEL = "testnet-indexer"

#: Label for a `NEXUS_EXCHANGE_API_URL` target, named after the variable it came
#: from so a reader of the banner can tell where the target was chosen. The same
#: label `sdk-python/risk-guard` and `sdk-mcp/risk-review` give the same
#: override.
OVERRIDE_LABEL = "api-url-override"

#: The environment variable every example in this repo honours, so a reader
#: behind different DNS has an escape hatch instead of a bare 404.
BASE_URL_ENV = "NEXUS_EXCHANGE_API_URL"

#: How the banner names each way the base URL can have been chosen.
DEFAULT_SOURCE = "built-in testnet default"
FLAG_SOURCE = "--base-url"
ENV_SOURCE = BASE_URL_ENV


class TargetError(ValueError):
    """A base URL this app refuses to build a client from."""


@dataclass(frozen=True, slots=True)
class Target:
    """A deployment, and the funds classification that goes with it."""

    base_url: str
    label: str
    funds: Funds
    #: Where the base came from, named so the banner can say it. A run that
    #: picked up an exported `NEXUS_EXCHANGE_API_URL` the reader forgot about
    #: looks exactly like a run that used the default, unless it says which.
    source: str

    @property
    def overridden(self) -> bool:
        return self.source != DEFAULT_SOURCE

    def network(self) -> NetworkConfig:
        """The described target to hand the SDK — never a bare ``base_url=``.

        Passing ``base_url=`` on its own routes requests correctly and then
        reports the wrong thing about them: the client keeps whatever network
        descriptor it was given, so it goes on claiming `funds=PLAY` for a host
        the caller supplied. It is also the deprecated selector (ENG-10955).
        Spelling the config out makes the funds classification something this
        app *states* rather than something it inherits.

        ``direct_base_url`` is left to fall back to ``base_url``, which is what
        a single override has always meant; a deployment that keeps a
        gateway/direct split is the case that has to name both.
        """
        return NetworkConfig.custom(
            label=self.label, funds=self.funds, base_url=self.base_url
        )

    def client(self, timeout: float) -> Client:
        """One :class:`Client`, shared by both halves of the comparison.

        Deliberately one and not two. The CCXT path and the native path have to
        read the same deployment through the same transport, or a difference
        between their answers could be a difference between two connections
        rather than a difference between the two APIs — which is the only thing
        this app is trying to measure.
        """
        return Client(self.network(), timeout=timeout)

    def funds_phrase(self) -> str:
        """What the target's funds are — never an assumption.

        ``Funds`` has three states and ``UNKNOWN`` is a real one, so this is a
        mapping and not a ternary. A bare URL declares nothing about whose money
        is behind it, and printing "play funds" over an undeclared host is the
        one lie a tool that names its target must not tell.
        """
        return {
            Funds.PLAY: "play funds",
            Funds.REAL: "REAL FUNDS",
            Funds.UNKNOWN: "funds not declared",
        }[self.funds]

    def banner(self) -> str:
        return f"{self.base_url} (from {self.source}) — {self.funds_phrase()}"


def resolve(flag: str | None = None, env: Mapping[str, str] | None = None) -> Target:
    """The target, from the flag, then the environment, then the testnet default.

    Precedence is the usual one and worth stating because the failure is quiet:
    an explicit ``--base-url`` beats an exported `NEXUS_EXCHANGE_API_URL`, so a
    reader debugging one run does not have to remember what is in their shell.

    An overridden target is classified ``Funds.UNKNOWN``. That is not caution
    theatre — this app is read-only, so nothing here is funds-guarded — it is
    that the banner is the only place the target is ever named, and a banner
    that guesses is worse than one that says it does not know.
    """
    environ = os.environ if env is None else env
    raw: str | None
    if flag is not None:
        raw, source = flag, FLAG_SOURCE
    else:
        # An *empty* environment variable falls back to the default rather than
        # failing. The repo's own `_template/.env.example` ships this variable
        # blank, so `set -a; . ./.env` exports it as "" on a machine that never
        # customised it — and refusing to start there would make the documented
        # setup path an error. An empty `--base-url` is different: it was typed.
        value = environ.get(BASE_URL_ENV, "").strip()
        raw, source = (value or None), ENV_SOURCE
    if raw is None:
        return Target(DEFAULT_BASE_URL, TESTNET_LABEL, Funds.PLAY, DEFAULT_SOURCE)

    base = raw.strip().rstrip("/")
    if not base:
        raise TargetError(f"{source} was given as an empty value — omit it or give a URL")
    # The SDK appends `/api/v1` to every direct-service route itself, so a base
    # that already ends in it produces `/api/v1/api/v1/markets/...` — which 404s
    # exactly like a missing endpoint and sends you looking in the wrong place.
    # The SDK's own `_clean_base_url` checks the scheme, the host, userinfo and
    # a stray query, but not this, so it is checked here.
    if base.endswith("/api/v1"):
        raise TargetError(
            f"base URL must not end in /api/v1 (got {base!r}): the SDK appends it, "
            f"so this would request /api/v1/api/v1/... and 404. Pass the "
            f"deployment base, e.g. {DEFAULT_BASE_URL}"
        )

    resolved = Target(base, OVERRIDE_LABEL, Funds.UNKNOWN, source)
    try:
        # Build the config now rather than at first request: a malformed URL
        # should fail before the banner claims a host this app cannot reach.
        resolved.network()
    except (TypeError, ValueError) as error:
        raise TargetError(f"{source}: {error}") from error
    return resolved
