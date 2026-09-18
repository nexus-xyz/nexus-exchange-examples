"""What the adapter actually implements, asked of the adapter itself.

The one thing this example must not do is read as though the trading methods
exist. A reader who copies ``ex.create_order(...)`` gets an ``AttributeError``
from a facade that never defined it, which is a worse first experience than
being told up front — so the covered / not-covered table is printed by the app,
generated from the live object, rather than written down in a README that can go
stale against a version bump.

It is generated from **two** sources and cross-checked, which is the part worth
copying. ``describe()["has"]`` is the adapter's advertisement; ``hasattr`` is the
ground truth. Today they agree exactly. If a later version ever advertises a
method it did not define — or defines one it forgot to advertise — this prints a
mismatch instead of quietly believing whichever it happened to read.

Nothing here calls anything. A capability probe that works by calling the method
and catching the exception would place an order on the day the follow-up
increment lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from nexus_exchange.ccxt_adapter import NexusExchange

#: CCXT's unified method name → the adapter's Python name. Only the methods
#: ``describe()["has"]`` makes a claim about; the ones it says nothing about are
#: in :data:`EXTRAS` and :data:`MISSING_ATTRIBUTES` below.
HAS_TO_METHOD: dict[str, str] = {
    "fetchMarkets": "fetch_markets",
    "fetchTicker": "fetch_ticker",
    "fetchTickers": "fetch_tickers",
    "fetchOrderBook": "fetch_order_book",
    "fetchOHLCV": "fetch_ohlcv",
    "fetchTrades": "fetch_trades",
    "fetchBalance": "fetch_balance",
    "fetchPositions": "fetch_positions",
    "createOrder": "create_order",
    "cancelOrder": "cancel_order",
    "fetchMyTrades": "fetch_my_trades",
    "fetchOrders": "fetch_orders",
    "fetchOpenOrders": "fetch_open_orders",
}

#: Implemented, and not described by a ``has`` flag because CCXT does not put
#: them there either.
EXTRAS: tuple[str, ...] = ("describe", "load_markets", "close")

#: Attributes ordinary CCXT code reaches for that this facade does not define.
#:
#: This is the list that actually breaks a port, and none of it is about
#: trading. ``exchange.has["fetchOHLCV"]`` is the standard CCXT capability
#: check and it is an ``AttributeError`` here — the flags live inside
#: ``describe()["has"]`` and nowhere else. The value is what to write instead.
MISSING_ATTRIBUTES: tuple[tuple[str, str], ...] = (
    ("has", 'ex.describe()["has"]'),
    ("id", 'ex.describe()["id"]'),
    ("timeframes", 'ex.describe()["timeframes"]'),
    ("urls", 'ex.describe()["urls"]'),
    ("market(symbol)", 'ex.load_markets()[symbol]'),
    ("milliseconds()", "time.time() * 1000, or the standard library"),
    ("iso8601(ms)", "datetime.fromtimestamp(ms / 1000, timezone.utc)"),
)


class Support(str, Enum):
    COVERED = "covered"
    #: Advertised ``False`` and not defined: calling it raises ``AttributeError``.
    FOLLOW_UP = "not implemented"
    #: ``describe()`` and ``hasattr`` disagree. Should never print.
    INCONSISTENT = "INCONSISTENT"


@dataclass(frozen=True, slots=True)
class Entry:
    ccxt_name: str
    python_name: str
    #: What ``describe()["has"]`` claims, or ``None`` when it makes no claim.
    advertised: bool | None
    #: Whether the attribute exists on the object.
    defined: bool
    support: Support

    @property
    def note(self) -> str:
        if self.support is Support.COVERED:
            return ""
        if self.support is Support.FOLLOW_UP:
            return "AttributeError if called — SDK follow-up increment"
        return (
            f"describe() says has={self.advertised} but the attribute is "
            f"{'present' if self.defined else 'absent'}"
        )


def _support(advertised: bool | None, defined: bool) -> Support:
    if advertised is not False and defined:
        return Support.COVERED
    if advertised is False and not defined:
        return Support.FOLLOW_UP
    return Support.INCONSISTENT


def probe(exchange: NexusExchange) -> list[Entry]:
    """The covered / not-covered table, read off the live object."""
    described: dict[str, Any] = exchange.describe()
    raw = described.get("has")
    flags: dict[str, Any] = raw if isinstance(raw, dict) else {}

    entries = [
        Entry(
            ccxt_name=ccxt_name,
            python_name=python_name,
            advertised=(
                bool(flags[ccxt_name]) if isinstance(flags.get(ccxt_name), bool) else None
            ),
            defined=hasattr(exchange, python_name),
            support=_support(
                bool(flags[ccxt_name])
                if isinstance(flags.get(ccxt_name), bool)
                else None,
                hasattr(exchange, python_name),
            ),
        )
        for ccxt_name, python_name in HAS_TO_METHOD.items()
    ]
    entries.extend(
        Entry(name, name, None, hasattr(exchange, name), _support(None, hasattr(exchange, name)))
        for name in EXTRAS
    )
    return entries


def inconsistencies(entries: list[Entry]) -> list[Entry]:
    return [entry for entry in entries if entry.support is Support.INCONSISTENT]


def one_line(entries: list[Entry]) -> str:
    """The banner summary: how much of CCXT's surface is actually here."""
    covered = sum(1 for e in entries if e.support is Support.COVERED)
    follow_up = sum(1 for e in entries if e.support is Support.FOLLOW_UP)
    return (
        f"adapter surface: {covered} unified methods implemented, "
        f"{follow_up} advertised False and not defined (market data only — "
        f"no balances, orders or positions)"
    )


def table(entries: list[Entry]) -> str:
    """The full table, for `--surface`."""
    lines = [
        f"{'CCXT method':<20} {'python':<20} {'has':<6} {'attr':<6} status",
        "─" * 92,
    ]
    for entry in entries:
        advertised = "—" if entry.advertised is None else str(entry.advertised)
        lines.append(
            f"{entry.ccxt_name:<20} {entry.python_name:<20} {advertised:<6} "
            f"{str(entry.defined):<6} {entry.support.value}"
            + (f"  ({entry.note})" if entry.note else "")
        )
    lines.append("")
    lines.append("CCXT attributes this facade does not define — use the right-hand form:")
    for name, replacement in MISSING_ATTRIBUTES:
        lines.append(f"  ex.{name:<18} → {replacement}")
    lines.append("")
    lines.append(
        "It follows CCXT's conventions without importing ccxt and without "
        "subclassing ccxt.Exchange, so there is no polymorphism to rely on: "
        "isinstance(ex, ccxt.Exchange) is False and nothing that dispatches on "
        "it will pick this up."
    )
    return "\n".join(lines)
