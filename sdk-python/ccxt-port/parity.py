"""What the unified layer costs, measured rather than asserted.

Both halves of this app compute the same seven figures from the same
deployment through the same transport. This module lines them up and classifies
each pair, which turns "floats lose precision" from a claim in a README into a
number printed next to the field it happened to.

That framing is deliberate. The differences depend on what the venue sends: a
JSON double survives the round trip intact, because
:func:`nexus_exchange._parse.to_decimal` goes through ``str`` and
``Decimal(str(x))`` of a double is exactly the double. A decimal *string* with
more digits than an ``f64`` holds does not. Which fields arrive as which is a
property of the deployment on the day you run this, so the app measures instead
of asserting — and `--strict` is there for running it on a schedule and hearing
about it when the answer changes.

The four verdicts, and why they are four rather than "equal / not equal":

``exact``
    ``Decimal(str(ccxt)) == native``. The unified ``float`` carries the native
    value with every digit intact. This is the common case on the market-data
    routes and it is worth being able to see, because it is the evidence that
    the other verdicts mean something.

``rounded``
    The two paths started from the same value and the ``float`` could not hold
    it — either because the venue sent more digits than an ``f64`` has, or
    because a derived figure accumulated binary error through a division and a
    square root. The delta is printed. Nothing is wrong; it is the cost.

``differs``
    The paths disagree by more than rounding explains, or one produced a figure
    and the other did not. This is the verdict worth alerting on: it means the
    two surfaces are not reading the same thing, and neither answer should be
    trusted until you know which.

``absent``
    Neither path produced a figure — a quiet market, an empty book. Not a
    finding, and counted separately so it cannot pad the agreement rate.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum

from ccxt_path import Scan
from native_path import NativeScan

#: Relative difference below which a disagreement is attributed to binary
#: floating point rather than to the two surfaces reading different things.
#:
#: 1e-12 is about three orders of magnitude inside a double's ~1e-16 relative
#: precision, with room for the error a division and a square root accumulate.
#: Named and tunable (`--tolerance`) because it is a judgement call, and a
#: judgement call buried in a comparison is how a tool starts lying quietly.
DEFAULT_TOLERANCE = Decimal("1e-12")


class Verdict(str, Enum):
    EXACT = "exact"
    ROUNDED = "rounded"
    DIFFERS = "differs"
    ABSENT = "absent"


@dataclass(frozen=True, slots=True)
class Row:
    """One field of one market, compared."""

    symbol: str
    field: str
    ccxt: float | None
    native: Decimal | None
    verdict: Verdict
    #: ``|Decimal(str(ccxt)) - native|``, when both sides produced a figure.
    delta: Decimal | None
    detail: str = ""


@dataclass(frozen=True, slots=True)
class Gap:
    """Something the native path has and the unified structures cannot express."""

    symbol: str
    field: str
    native_value: str
    #: Where the same information can still be reached from CCXT-shaped code,
    #: or why it cannot. Always actionable — "not available" on its own is what
    #: sends someone to read the adapter's source.
    escape_hatch: str


def classify(
    ccxt: float | None, native: Decimal | None, tolerance: Decimal
) -> tuple[Verdict, Decimal | None, str]:
    """Compare one pair. See the module docstring for what each verdict means."""
    if ccxt is None and native is None:
        return Verdict.ABSENT, None, "neither path produced a figure"
    if ccxt is None:
        return Verdict.DIFFERS, None, "no unified value; the native path has one"
    if native is None:
        return Verdict.DIFFERS, None, "no native value; the unified path has one"

    try:
        # `Decimal(str(float))` is the shortest decimal that round-trips to the
        # same double, which is exactly the question being asked: does the
        # unified number name the native one?
        as_decimal = Decimal(str(ccxt))
    except InvalidOperation:  # pragma: no cover - `as_float` already excluded these
        return Verdict.DIFFERS, None, f"unified value is not a decimal: {ccxt!r}"

    if as_decimal == native:
        return Verdict.EXACT, Decimal(0), ""

    delta = abs(as_decimal - native)
    try:
        # The other direction of the same question: do both sides name the same
        # *double*? If so the values are the same to the limit of the unified
        # type and the difference is digits the float never had room for.
        same_double = float(native) == ccxt
    except (OverflowError, ValueError):
        same_double = False
    if same_double:
        return Verdict.ROUNDED, delta, "digits lost to the float"

    if native != 0 and delta / abs(native) <= tolerance:
        return Verdict.ROUNDED, delta, "binary error accumulated in the arithmetic"
    return Verdict.DIFFERS, delta, "beyond what rounding explains"


#: The compared fields, in the order they are reported. Paired by attribute name
#: because both dataclasses use the same names on purpose — a field that exists
#: on one and not the other is a gap, and gaps are reported by
#: :func:`gaps`, not by silently dropping out of this list.
COMPARED: tuple[tuple[str, str], ...] = (
    ("last", "last"),
    ("change%", "change_pct"),
    ("spread_bps", "spread_bps"),
    ("depth_quote", "depth_quote"),
    ("rvol%", "rvol_pct"),
    ("taker_buy", "taker_buy_share"),
    ("tick_size", "tick_size"),
)


def compare(
    ccxt_scans: list[Scan],
    native_scans: list[NativeScan],
    tolerance: Decimal = DEFAULT_TOLERANCE,
) -> list[Row]:
    """Every field of every market that both scans cover."""
    by_symbol = {scan.symbol: scan for scan in native_scans}
    rows: list[Row] = []
    for scan in ccxt_scans:
        native = by_symbol.get(scan.symbol)
        if native is None:
            continue
        for label, attribute in COMPARED:
            unified = getattr(scan, attribute)
            exact = getattr(native, attribute)
            verdict, delta, detail = classify(unified, exact, tolerance)
            rows.append(
                Row(scan.symbol, label, unified, exact, verdict, delta, detail)
            )
    return rows


def gaps(native_scans: list[NativeScan]) -> list[Gap]:
    """What the native path saw that the unified structures have no field for.

    Three of them, and they are the actual answer to "when do I drop down to the
    native client": not when the unified layer is awkward, but when it cannot
    represent the thing at all.

    Note that two of the three are reachable from CCXT-shaped code — through
    ``market["info"]`` and ``trade["info"]``, the raw payloads CCXT carries by
    convention for exactly this. Reaching them means leaving the unified layer,
    which is the honest description of the trade: the escape hatch exists, and
    using it is the same as not being ported.
    """
    out: list[Gap] = []
    for scan in native_scans:
        if scan.maintenance_margin_rate is not None:
            out.append(
                Gap(
                    scan.symbol,
                    "maintenance_margin_rate",
                    str(scan.maintenance_margin_rate),
                    'market["info"]["maintenance_margin_rate"], as a string',
                )
            )
        if scan.liquidation_trades:
            out.append(
                Gap(
                    scan.symbol,
                    "liquidation trades",
                    str(scan.liquidation_trades),
                    'trade["info"]["is_liquidation"], when the venue sends it',
                )
            )
        if scan.tick_size is not None:
            out.append(
                Gap(
                    scan.symbol,
                    "exact tick size",
                    str(scan.tick_size),
                    'market["precision"]["price"] as a float, or '
                    'market["info"]["tick_size"] as the string the venue sent',
                )
            )
    return out


@dataclass(frozen=True, slots=True)
class Summary:
    exact: int
    rounded: int
    differs: int
    absent: int

    @property
    def compared(self) -> int:
        """Pairs where both paths produced a figure and a verdict is meaningful."""
        return self.exact + self.rounded + self.differs

    @property
    def worst(self) -> Verdict:
        if self.differs:
            return Verdict.DIFFERS
        if self.rounded:
            return Verdict.ROUNDED
        if self.exact:
            return Verdict.EXACT
        return Verdict.ABSENT


def summarise(rows: list[Row]) -> Summary:
    counts = {verdict: 0 for verdict in Verdict}
    for row in rows:
        counts[row.verdict] += 1
    return Summary(
        exact=counts[Verdict.EXACT],
        rounded=counts[Verdict.ROUNDED],
        differs=counts[Verdict.DIFFERS],
        absent=counts[Verdict.ABSENT],
    )
