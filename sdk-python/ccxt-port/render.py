"""Terminal output: the scan table, the parity report, and the notes.

Rounding here is for reading and nowhere else. Every figure printed is
quantized; every figure *compared* in `parity.py` is the full value. Rounding on
the way into a comparison would hide exactly the difference this app exists to
show, which is why the two never share a code path.
"""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Sequence

from ccxt_path import Scan
from native_path import NativeScan
from parity import Gap, Row, Summary, Verdict

RULE = "─" * 100

#: Marker per verdict, so a scan of the column works without reading the words.
MARKER: dict[Verdict, str] = {
    Verdict.EXACT: " ",
    Verdict.ROUNDED: "·",
    Verdict.DIFFERS: "!",
    Verdict.ABSENT: "–",
}


def number(value: float | Decimal | None, places: int = 4) -> str:
    """One figure, quantized for reading. ``None`` prints as an em dash.

    A ``float`` is routed through ``Decimal(str(...))`` rather than ``%f`` so
    that the printed digits are the ones the double actually names, not a
    formatter's idea of them — which matters in a tool whose whole subject is
    what a double does and does not hold.
    """
    if value is None:
        return "—"
    try:
        exact = value if isinstance(value, Decimal) else Decimal(str(value))
        return str(
            exact.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN)
        )
    except (InvalidOperation, ValueError):
        return str(value)


def _row(symbol: str, cells: Sequence[str]) -> str:
    return f"{symbol:<18}" + "".join(f"{cell:>14}" for cell in cells)


HEADER = ("last", "chg%", "spread_bps", "depth_quote", "rvol%", "taker_buy")


def ccxt_table(scans: Sequence[Scan]) -> str:
    lines = [_row("MARKET (ccxt)", HEADER), RULE]
    for scan in scans:
        lines.append(
            _row(
                scan.symbol,
                (
                    number(scan.last, 2),
                    number(scan.change_pct, 2),
                    number(scan.spread_bps, 2),
                    number(scan.depth_quote, 2),
                    number(scan.rvol_pct, 2),
                    number(scan.taker_buy_share, 3),
                ),
            )
        )
    return "\n".join(lines)


def native_table(scans: Sequence[NativeScan]) -> str:
    lines = [_row("MARKET (native)", HEADER), RULE]
    for scan in scans:
        lines.append(
            _row(
                scan.symbol,
                (
                    number(scan.last, 2),
                    number(scan.change_pct, 2),
                    number(scan.spread_bps, 2),
                    number(scan.depth_quote, 2),
                    number(scan.rvol_pct, 2),
                    number(scan.taker_buy_share, 3),
                ),
            )
        )
    return "\n".join(lines)


#: Width of the two value columns. A `Decimal` from the volatility calculation
#: can run to fifty digits, so the columns are fixed and the overflow is elided
#: — with the elision *visible*, because a silently truncated number in a report
#: about precision would be its own small joke.
VALUE_WIDTH = 26


def _cell(value: float | Decimal | None) -> str:
    """One value column: the full digits where they fit, elided where they do not.

    ``repr`` for the float and ``str`` for the ``Decimal``, both deliberately:
    this is the one table where the printed digits *are* the subject, so nothing
    is rounded on the way in. The delta column is what carries the difference
    when the elision hides it.
    """
    if value is None:
        return "—"
    text = repr(value) if isinstance(value, float) else str(value)
    if len(text) <= VALUE_WIDTH:
        return text
    return text[: VALUE_WIDTH - 1] + "…"


def parity_table(rows: Sequence[Row]) -> str:
    """Every compared field, with the delta where there is one.

    ``exact`` rows are printed too. The temptation is to show only the
    differences, and it is the wrong call: a report that lists three problems
    and hides the forty-five agreements gives no sense of whether the layer is
    broadly faithful or broadly lossy, which is the actual question a reader
    arrived with.
    """
    lines = [
        f"{'MARKET':<18}{'field':<12}{'ccxt (float)':>{VALUE_WIDTH}}  "
        f"{'native (decimal)':>{VALUE_WIDTH}}  {'Δ':<11} verdict",
        RULE,
    ]
    for row in rows:
        delta = (
            "" if row.verdict is Verdict.EXACT or row.delta is None
            else f"{row.delta:.3E}"
        )
        detail = (
            f"  ({row.detail})"
            if row.detail and row.verdict is Verdict.DIFFERS
            else ""
        )
        lines.append(
            f"{row.symbol:<18}{row.field:<12}"
            f"{_cell(row.ccxt):>{VALUE_WIDTH}}  {_cell(row.native):>{VALUE_WIDTH}}  "
            f"{delta:<11} {MARKER[row.verdict]} {row.verdict.value}{detail}"
        )
    return "\n".join(lines)


def parity_summary(summary: Summary) -> str:
    if summary.compared == 0:
        return "parity: nothing to compare — no market produced a figure on both paths"
    share = 100 * summary.exact / summary.compared
    return (
        f"parity: {summary.compared} field(s) compared — "
        f"{summary.exact} exact ({share:.0f}%), {summary.rounded} rounded, "
        f"{summary.differs} differs, {summary.absent} absent on both"
    )


def gaps_block(gaps: Sequence[Gap]) -> str:
    """What the unified structures cannot carry, and where to reach it instead.

    Grouped by field rather than by market, because the escape hatch is a
    property of the field and repeating it under every market turns three facts
    into twelve lines of the same sentence. The values still appear per market,
    since a gap with no number next to it reads as theoretical.
    """
    if not gaps:
        return ""
    order: list[str] = []
    hatch: dict[str, str] = {}
    values: dict[str, list[str]] = {}
    for gap in gaps:
        if gap.field not in hatch:
            order.append(gap.field)
            hatch[gap.field] = gap.escape_hatch
            values[gap.field] = []
        values[gap.field].append(f"{gap.symbol} {gap.native_value}")

    lines = ["what the unified layer does not carry"]
    for field_name in order:
        lines.append(f"  {field_name}")
        lines.append(f"    from CCXT-shaped code: {hatch[field_name]}")
        lines.append(f"    {'   '.join(values[field_name])}")
    return "\n".join(lines)


def notes_block(
    ccxt_scans: Sequence[Scan], native_scans: Sequence[NativeScan]
) -> str:
    """Everything either path refused to compute on.

    Both paths are reported even though they agree in normal operation, because
    the case where they *stop* agreeing — one dropping a candle the other kept —
    is precisely the case that would make a parity difference look like an API
    difference.

    A note that applies to every market is printed once, under ``every market``.
    Two of them always do: the venue's ``timestamp == 0`` leading candle and the
    forming final bucket happen on every run. Repeating them per market would
    bury the note that only fired for one, which is the only one worth reading —
    the same reasoning `analytics/market-report` uses to keep its routine
    findings from drowning its real ones.
    """
    native_notes = {scan.symbol: scan.notes for scan in native_scans}
    per_market: list[tuple[str, list[tuple[str, str]]]] = []
    for scan in ccxt_scans:
        tagged = [("ccxt", note) for note in scan.notes]
        tagged += [("native", note) for note in native_notes.get(scan.symbol, [])]
        per_market.append((scan.symbol, tagged))
    if not any(tagged for _, tagged in per_market):
        return ""

    universal: list[tuple[str, str]] = []
    if len(per_market) > 1:
        first = per_market[0][1]
        universal = [
            note for note in first if all(note in tagged for _, tagged in per_market)
        ]

    lines = ["data notes"]
    for path, note in universal:
        lines.append(f"  every market  {path:<7}· {note}")
    for symbol, tagged in per_market:
        rest = [note for note in tagged if note not in universal]
        if not rest:
            continue
        lines.append(f"  {symbol}")
        for path, note in rest:
            lines.append(f"    {path:<7}· {note}")
    return "\n".join(lines)
