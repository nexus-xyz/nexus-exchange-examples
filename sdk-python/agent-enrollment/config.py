"""Configuration, validated before a single request goes out.

Every check here is local. A misconfiguration caught on this machine never
becomes a request against someone's account -- and, for this app in particular,
never becomes a *signature*. A signed agent registration is a bearer credential
the moment it exists, so the cheapest place to stop a bad one is before it is
produced.

Two rules govern how failures are reported here:

* **Key material is never echoed.** Every other value in this file appears in its
  own error message, because seeing what you typed is how you find the typo. A
  private key is the one input where that trade goes the other way: the error
  says what is wrong with the shape and nothing about the bytes, so a paste into
  a bug report cannot carry the key with it.
* **The base URL is decided once, here.** It is handed to the client *and* to the
  ``/metadata`` read, so the chain id this app signs under and the host it
  registers with can never be two different places. See ``domain.py``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

#: Testnet's durable REST base -- play funds.
#:
#: Named explicitly rather than left to the SDK's default (CONTRIBUTING § 4).
#: ``nexus-exchange`` 0.4.0 resolves ``Network.TESTNET`` to the legacy
#: ``https://exchange.nexus.xyz/api/exchange`` gateway, which answers 500 on
#: every route now; the durable per-network host is what the rest of this catalog
#: moved to (ENG-14959, and ``analytics/market-report``). The ``/indexer`` prefix
#: is load-bearing -- the bare host 404s.
TESTNET_BASE_URL = "https://api.testnet.nexus.xyz/indexer"

#: The shortest delegation the spec accepts, and this app's default.
#:
#: ``POST /agents/register`` expects an expiry in ``[now+1d, now+90d]``, so one
#: day is the floor rather than a number chosen here. It is the *default* because
#: the right default for a delegation is the shortest one that works: an agent
#: key is a standing authorization to trade, and the expiry is the only thing
#: that bounds it without anyone having to remember anything.
MIN_TTL_DAYS = 1
MAX_TTL_DAYS = 90
DEFAULT_TTL_DAYS = MIN_TTL_DAYS

#: Default ``label`` on the registration. It is echoed back by ``GET /agents``,
#: so it is what tells a human reading that list which key this was and where it
#: came from. Deliberately names the example rather than something generic.
DEFAULT_LABEL = "agent-enrollment-example"

#: The label survives a round trip through ``GET /agents`` and has to be readable
#: back in a terminal, so it is held to the same ASCII-only standard the SDK
#: applies to a network label.
_LABEL = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

#: Whole days, and nothing else. ``int()`` accepts underscores (``1_0``) and
#: every Unicode decimal digit, and neither is what the author meant. Same
#: reasoning -- and the same ``[0-9]`` rather than ``\d`` -- as
#: ``sdk-python/risk-guard``.
_WHOLE_DAYS = re.compile(r"^[0-9]+$")

#: A 32-byte secp256k1 private key, ``0x`` optional. Checked here only so the
#: failure names the variable; ``EthSigner.from_hex`` is what actually validates
#: the scalar.
_PRIVATE_KEY = re.compile(r"^(?:0[xX])?[0-9a-fA-F]{64}$")

USAGE = """\
agent-enrollment — delegate trading to a scoped, expiring agent key.

Usage:
  python enroll.py              enroll an agent key, prove it, then revoke it
  python enroll.py --dry-run    do everything local, send nothing
  python enroll.py --help       print this

--dry-run reads the signing domain from the target's /metadata and builds and
signs the registration, but never sends it. It needs no API credentials, so it
is also the way to see the refuse-to-sign behaviour without an account.

Credentials and options come from the environment. See .env.example.\
"""


class ConfigError(Exception):
    """A local misconfiguration. Reported as configuration, never as a crash."""


class HelpRequested(Exception):
    """``--help`` was asked for: print USAGE and exit zero."""


@dataclass(frozen=True)
class Config:
    #: The one base URL this run uses, for ``/metadata`` and every request alike.
    base_url: str
    #: True when ``base_url`` came from the environment rather than from the
    #: testnet default. Decides whether the funds can be declared -- see
    #: :func:`enroll.build_client`.
    base_url_overridden: bool
    #: The owning wallet's key. Signs the EIP-712 registration locally, and is
    #: never sent anywhere.
    wallet_private_key: str
    #: The agent's key, or ``None`` to generate an ephemeral one.
    agent_private_key: str | None
    #: HMAC credentials, for the signed reads and the revoke. Absent is legal
    #: only under ``--dry-run``, which sends nothing.
    api_key: str | None
    api_secret: str | None
    ttl_days: int
    label: str
    dry_run: bool


def _env(name: str) -> str | None:
    """Read an environment variable, treating blank as absent."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def _private_key(name: str, *, required: bool) -> str | None:
    """Read a private key, and say nothing about its value if it is wrong.

    Every other parser here quotes what it got, because seeing what you typed is
    how you find the typo. This one never does: the value is key material, and an
    error message is the most-copied string a program produces. The shape is
    checked rather than parsed so the message can name the variable and the
    expected form without touching the bytes.
    """
    raw = _env(name)
    if raw is None:
        if required:
            raise ConfigError(
                f"{name} is required: it is the key that signs the delegation. "
                f"See .env.example."
            )
        return None
    if not _PRIVATE_KEY.match(raw):
        # No value in the message, deliberately -- and no length either. A length
        # is a fact about a secret, and this says everything a reader needs
        # without becoming one more place the key can leak.
        raise ConfigError(
            f"{name} must be a 32-byte secp256k1 private key in hex, `0x` optional. "
            f"The value is not echoed here on purpose."
        )
    return raw


def _require(value: str | None) -> str:
    """Narrow ``str | None`` to ``str`` for a value ``_private_key`` required.

    ``_private_key(required=True)`` raises rather than returning ``None``, but
    its signature cannot say so, and ``strict = True`` is worth more than the one
    line this costs. An assertion rather than a cast: a cast is a claim mypy
    takes on trust, and this one is checked.
    """
    assert value is not None
    return value


def _ttl_days() -> int:
    raw = _env("NEXUS_AGENT_TTL_DAYS")
    if raw is None:
        return DEFAULT_TTL_DAYS
    if not _WHOLE_DAYS.match(raw):
        raise ConfigError(
            f"NEXUS_AGENT_TTL_DAYS must be a whole number of days between "
            f"{MIN_TTL_DAYS} and {MAX_TTL_DAYS}, got {raw!r}"
        )
    days = int(raw)
    if not MIN_TTL_DAYS <= days <= MAX_TTL_DAYS:
        # Bounded here rather than left to the venue, and that is the whole
        # reason to carry the bound locally: an out-of-window expiry would
        # otherwise be discovered *after* the registration was signed, and a
        # signed registration is a credential whether or not anyone accepted it.
        raise ConfigError(
            f"NEXUS_AGENT_TTL_DAYS must be between {MIN_TTL_DAYS} and {MAX_TTL_DAYS} "
            f"— the expiry the venue accepts is [now+{MIN_TTL_DAYS}d, "
            f"now+{MAX_TTL_DAYS}d] — got {days}"
        )
    return days


def _label() -> str:
    raw = _env("NEXUS_AGENT_LABEL")
    if raw is None:
        return DEFAULT_LABEL
    if not _LABEL.match(raw):
        raise ConfigError(
            f"NEXUS_AGENT_LABEL must be 1-64 characters of ASCII letters, digits, "
            f"'.', '_' or '-', got {raw!r}. It is read back out of GET /agents, so "
            f"it has to survive a round trip and be checkable by eye."
        )
    return raw


def parse_args(argv: list[str]) -> bool:
    """Read the argument list and return whether this is a dry run.

    Unrecognised arguments are **refused**, not ignored, for the same reason
    ``risk-guard`` refuses them: every near-miss for the one flag that matters --
    ``--dryrun``, ``-dry-run``, ``--dry-run=true`` -- would otherwise leave
    someone believing nothing would be sent while the app went ahead and
    registered a key against their account.
    """
    # Help wins over everything, including a bad argument beside it: someone
    # asking what the flags are should be told, not corrected.
    if any(arg in ("-h", "--help") for arg in argv):
        raise HelpRequested
    dry_run = False
    for arg in argv:
        if arg == "--dry-run":
            dry_run = True
            continue
        raise ConfigError(f"unrecognised argument {arg!r}.\n\n{USAGE}")
    return dry_run


def load(argv: list[str]) -> Config:
    # Arguments first: a typo'd flag should not need a key in the environment
    # before it is reported.
    dry_run = parse_args(argv)

    override = _env("NEXUS_EXCHANGE_API_URL")

    api_key = _env("NEXUS_EXCHANGE_API_KEY")
    api_secret = _env("NEXUS_EXCHANGE_API_SECRET")
    if not dry_run and (api_key is None or api_secret is None):
        raise ConfigError(
            "listing and revoking agent keys are signed calls, so this needs both "
            "NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET.\n"
            "Copy .env.example to .env and export them, or run with --dry-run, "
            "which sends nothing and needs neither."
        )

    return Config(
        base_url=override or TESTNET_BASE_URL,
        base_url_overridden=override is not None,
        # Required even under --dry-run: signing the registration is the part a
        # dry run exists to show.
        wallet_private_key=_require(
            _private_key("NEXUS_WALLET_PRIVATE_KEY", required=True)
        ),
        agent_private_key=_private_key("NEXUS_AGENT_PRIVATE_KEY", required=False),
        api_key=api_key,
        api_secret=api_secret,
        ttl_days=_ttl_days(),
        label=_label(),
        dry_run=dry_run,
    )
