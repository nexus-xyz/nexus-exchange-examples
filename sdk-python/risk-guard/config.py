"""Configuration, validated before a single request goes out.

Every check here is local: it costs nothing, and a misconfiguration caught on
this machine never becomes a request against someone's account.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

#: Shortest polling interval. A guard that hammers the API is its own problem.
MIN_INTERVAL_SECONDS = 2
#: Longest polling interval: one hour. A guard that checks less often than this
#: is not really watching anything, and an interval that large is far likelier to
#: be a typo than a decision. Bounded on both sides so neither mistake is silent.
MAX_INTERVAL_SECONDS = 3600
DEFAULT_INTERVAL_SECONDS = 15

USAGE = """\
risk-guard — watch one Nexus Exchange account against limits you set.

Usage:
  python guard.py              watch and report; changes nothing
  python guard.py --arm        let a breach cancel every resting order
  python guard.py --help       print this

Credentials and limits come from the environment; at least one limit is
required. See .env.example for every variable and its meaning.\
"""

#: Plain decimals only: no exponents, no `nan`/`inf`, no thousands separators,
#: no underscores. Every one of those has a plausible-looking reading that
#: `Decimal()` will happily accept -- `Decimal("1e5")` is 100000, `Decimal("nan")`
#: is a NaN that compares false against everything -- and this value decides
#: whether the guard fires. So the shape is checked before the parse, not after.
_PLAIN_DECIMAL = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")

#: Whole seconds, and nothing else. Same reasoning as above: `int()` accepts
#: underscores (`1_000`) and unicode digits, and neither is what the author meant.
_WHOLE_SECONDS = re.compile(r"^\d+$")


class ConfigError(Exception):
    """A local misconfiguration. Reported as configuration, never as a crash."""


class HelpRequested(Exception):
    """`--help` was asked for: print USAGE and exit zero."""


@dataclass(frozen=True)
class Limits:
    """A limit left unset is ``None`` -- not zero.

    Zero is a real limit that would fire permanently, so the two must never
    collapse into one value.
    """

    max_notional: Decimal | None
    max_loss: Decimal | None
    min_available_margin: Decimal | None

    @property
    def empty(self) -> bool:
        return (
            self.max_notional is None
            and self.max_loss is None
            and self.min_available_margin is None
        )


@dataclass(frozen=True)
class Config:
    api_key: str
    api_secret: str
    base_url: str | None
    limits: Limits
    interval_seconds: int
    #: True when `--arm` was passed: the guard may cancel resting orders.
    armed: bool


def _env(name: str) -> str | None:
    """Read an environment variable, treating blank as absent."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def _limit(name: str) -> Decimal | None:
    """Parse a limit as an exact decimal.

    Limits must be strictly positive. A zero or negative limit is almost always
    a typo, and it is the kind that either fires the guard forever or never --
    neither of which the author intended.
    """
    raw = _env(name)
    if raw is None:
        return None
    if not _PLAIN_DECIMAL.match(raw):
        raise ConfigError(f"{name} must be a plain decimal number, got {raw!r}")
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:  # pragma: no cover - the regex precedes it
        raise ConfigError(f"{name} is not a usable decimal: {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be greater than zero, got {raw}")
    return value


def _interval() -> int:
    raw = _env("NEXUS_GUARD_INTERVAL_SECONDS")
    if raw is None:
        return DEFAULT_INTERVAL_SECONDS
    if not _WHOLE_SECONDS.match(raw):
        raise ConfigError(
            f"NEXUS_GUARD_INTERVAL_SECONDS must be a whole number of seconds "
            f"between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS}, got {raw!r}"
        )
    seconds = int(raw)
    if not MIN_INTERVAL_SECONDS <= seconds <= MAX_INTERVAL_SECONDS:
        raise ConfigError(
            f"NEXUS_GUARD_INTERVAL_SECONDS must be between {MIN_INTERVAL_SECONDS} "
            f"and {MAX_INTERVAL_SECONDS} seconds, got {seconds}"
        )
    return seconds


def parse_args(argv: list[str]) -> bool:
    """Read the argument list and return whether the guard is armed.

    Unrecognised arguments are **refused**, not ignored. The near-misses for the
    one flag that matters all look plausible -- ``--armed``, ``-arm``,
    ``--arm=true`` -- and every one of them would otherwise leave an operator
    believing the guard may act, with a startup banner agreeing, while it
    silently stayed watch-only. A guard you think is armed and is not is worse
    than no guard.
    """
    # Help wins over everything, including a bad argument beside it: someone
    # asking what the flags are should be told, not corrected.
    if any(arg in ("-h", "--help") for arg in argv):
        raise HelpRequested
    armed = False
    for arg in argv:
        if arg == "--arm":
            armed = True
            continue
        raise ConfigError(f"unrecognised argument {arg!r}.\n\n{USAGE}")
    return armed


def load(argv: list[str]) -> Config:
    # Arguments first: a typo'd flag should not need a key in the environment
    # before it is reported.
    armed = parse_args(argv)

    api_key = _env("NEXUS_EXCHANGE_API_KEY")
    api_secret = _env("NEXUS_EXCHANGE_API_SECRET")
    # Half a credential pair is always a mistake -- a typo'd variable name, a
    # shell that only exported one -- and left alone it surfaces as an opaque
    # 401 long after the cause.
    if api_key is None or api_secret is None:
        raise ConfigError(
            "this example watches your account, so it needs both "
            "NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET.\n"
            "Copy .env.example to .env and export them, or pass them inline."
        )

    limits = Limits(
        max_notional=_limit("NEXUS_GUARD_MAX_NOTIONAL"),
        max_loss=_limit("NEXUS_GUARD_MAX_LOSS"),
        min_available_margin=_limit("NEXUS_GUARD_MIN_AVAILABLE_MARGIN"),
    )
    # A guard with no limits is not a guard, and it would sit there printing
    # reassuring output forever. Refuse rather than imply coverage that does not
    # exist.
    if limits.empty:
        raise ConfigError(
            "no limits configured, so there is nothing to guard. Set at least one "
            "of NEXUS_GUARD_MAX_NOTIONAL, NEXUS_GUARD_MAX_LOSS or "
            "NEXUS_GUARD_MIN_AVAILABLE_MARGIN — see .env.example."
        )

    return Config(
        api_key=api_key,
        api_secret=api_secret,
        base_url=_env("NEXUS_EXCHANGE_API_URL"),
        limits=limits,
        interval_seconds=_interval(),
        armed=armed,
    )
