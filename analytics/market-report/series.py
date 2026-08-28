"""Turning what the venue returns into something it is safe to compute on.

This is the file the example exists for. Fetching candles is one GET; the work
is establishing that the rows you got back are the series you asked for. Every
check below corresponds to something this deployment actually does, measured
against live testnet rather than imagined:

* ``timeframe=1d`` returns **one-minute** candles, with no error. Only ``1m``,
  ``5m`` and ``1h`` are honoured; every other value — ``15m``, ``4h``, ``1d``,
  ``1w``, a typo, an empty string — silently falls back to minutes. Nothing in
  the response says so, so a report that trusts its own request label will
  happily describe minute bars as daily ones.
* The ``5m`` and ``1h`` series each begin with a row whose timestamp is **0**,
  carrying an OHLC that matches no bucket. Plotted, it lands in 1970; averaged,
  it moves everything.
* Buckets are **missing** wherever nothing traded, so consecutive rows are not
  a fixed interval apart, and a return computed across a gap spans more time
  than it claims to.
* The ``1h`` grid is **not anchored to the clock hour**, and shifts mid-series:
  one observed step was 24,692,689 ms, which is not a multiple of an hour.
* ``limit`` is **silently clamped** at 1000. Asking for 5000 returns 1000 rows
  and no indication that the window was cut.

None of those is a bug in the caller, and none of them raises. They just make
the numbers wrong, so each one is detected, counted, and reported next to the
figure it affects.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, DivisionByZero, InvalidOperation
from typing import Any, Literal, Sequence

# The only timeframes this deployment actually honours, and their bucket widths.
# Measured: every other value returns the 1m series (see the module docstring).
TIMEFRAMES: dict[str, int] = {"1m": 60_000, "5m": 300_000, "1h": 3_600_000}

# The server's own ceiling on `limit`, applied silently.
CANDLE_LIMIT_CAP = 1000

MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000


# How much a finding matters. The distinction is what makes `--strict` usable: a
# dropped forming bucket happens on literally every run and means nothing is
# wrong, so a strict mode that fires on it fires always and gets turned off.
#
#   info   normal bookkeeping — worth printing, never worth alerting on
#   warn   the feed is degraded in a way that changes what the numbers mean
#   fatal  no figure can be derived from this series at all
Severity = Literal["info", "warn", "fatal"]


@dataclass(frozen=True)
class Issue:
    """One thing worth saying about a series, stated plainly enough to print."""

    code: str
    detail: str
    severity: Severity = "warn"

    @property
    def fatal(self) -> bool:
        return self.severity == "fatal"

    @property
    def alertable(self) -> bool:
        """True for anything `--strict` should exit non-zero over."""
        return self.severity != "info"


@dataclass(frozen=True)
class Candle:
    start_ms: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(frozen=True)
class CandleSeries:
    market: str
    requested_timeframe: str
    candles: tuple[Candle, ...]
    step_ms: int | None
    issues: tuple[Issue, ...] = field(default_factory=tuple)
    rows_received: int = 0
    expected_buckets: int = 0

    @property
    def timeframe_honoured(self) -> bool:
        """Did the venue return the bucket width that was asked for?

        The one check with no plausible alternative reading: if this is false the
        rows are a real series of *some* interval, just not this one, and every
        figure derived from them is mislabelled rather than merely noisy.
        """
        expected = TIMEFRAMES.get(self.requested_timeframe)
        return expected is not None and self.step_ms == expected

    @property
    def missing_buckets(self) -> int:
        return max(0, self.expected_buckets - len(self.candles))

    @property
    def coverage(self) -> Decimal:
        """Share of the buckets in the observed span that actually came back."""
        if self.expected_buckets <= 0:
            return Decimal(0)
        return Decimal(len(self.candles)) / Decimal(self.expected_buckets)

    @property
    def usable(self) -> bool:
        return len(self.candles) >= 2 and not any(i.fatal for i in self.issues)



def to_decimal(value: Any, what: str) -> Decimal:
    """Coerce a value from the wire into a Decimal, refusing floats.

    A `float` reaching here means something parsed JSON without
    ``parse_float=Decimal`` — the digits are already gone, and quietly wrapping
    them in `Decimal` would preserve the error while hiding where it came from.
    Better to fail at the boundary than to publish a number whose last digits
    are an artefact of binary floating point.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise ValueError(f"{what}: expected a number, got a boolean")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        raise ValueError(
            f"{what}: got a float ({value!r}). JSON must be parsed with "
            "parse_float=Decimal so the venue's digits survive."
        )
    if isinstance(value, str):
        try:
            return Decimal(value)
        except InvalidOperation as exc:
            raise ValueError(f"{what}: {value!r} is not a number") from exc
    raise ValueError(f"{what}: expected a number, got {type(value).__name__}")


def parse_candles(
    rows: Any,
    *,
    market: str,
    requested_timeframe: str,
    limit: int,
    window_buckets: int,
    now_ms: int,
) -> CandleSeries:
    """Validate a `/candles` payload into a series, with everything wrong noted."""
    issues: list[Issue] = []

    if not isinstance(rows, list):
        return CandleSeries(
            market=market,
            requested_timeframe=requested_timeframe,
            candles=(),
            step_ms=None,
            issues=(
                Issue(
                    "payload_shape",
                    f"expected a JSON array of candles, got {type(rows).__name__}",
                    severity="fatal",
                ),
            ),
        )

    rows_received = len(rows)
    parsed: list[Candle] = []
    malformed = 0
    nonpositive = 0

    for row in rows:
        # `[start_ms, open, high, low, close, volume]`. Checked rather than
        # unpacked: a payload that grows a seventh element or turns into a dict
        # should degrade to "this market has no usable series", not a traceback
        # halfway through a report.
        if not isinstance(row, (list, tuple)) or len(row) != 6:
            malformed += 1
            continue
        try:
            start_raw = row[0]
            if isinstance(start_raw, float):
                raise ValueError("candle timestamp arrived as a float")
            start_ms = int(start_raw)
            candle = Candle(
                start_ms=start_ms,
                open=to_decimal(row[1], "open"),
                high=to_decimal(row[2], "high"),
                low=to_decimal(row[3], "low"),
                close=to_decimal(row[4], "close"),
                volume=to_decimal(row[5], "volume"),
            )
        except (ValueError, TypeError, ArithmeticError):
            malformed += 1
            continue

        # The measured garbage row: timestamp 0, at the head of the 5m and 1h
        # series. Dropped rather than clamped — there is no bucket it belongs to.
        if candle.start_ms <= 0:
            nonpositive += 1
            continue
        parsed.append(candle)

    if malformed:
        issues.append(Issue("row_shape", f"{malformed} row(s) were not a 6-element candle"))
    if nonpositive:
        issues.append(
            Issue(
                "nonpositive_timestamp",
                f"{nonpositive} row(s) had a timestamp <= 0 and were dropped "
                "(this venue puts one at the head of the 5m and 1h series)",
            )
        )

    ordered = sorted(parsed, key=lambda c: c.start_ms)
    if [c.start_ms for c in ordered] != [c.start_ms for c in parsed]:
        issues.append(Issue("unsorted", "rows arrived out of order and were sorted"))

    deduped: list[Candle] = []
    duplicates = 0
    for candle in ordered:
        if deduped and deduped[-1].start_ms == candle.start_ms:
            # Keep the first and count the rest. Which one to keep is a guess
            # either way; counting them means the guess is visible.
            duplicates += 1
            continue
        deduped.append(candle)
    if duplicates:
        issues.append(Issue("duplicate_timestamp", f"{duplicates} duplicate bucket(s) dropped"))

    # Truncation is a property of the *request*, not of the row count. Getting
    # exactly as many rows as were asked for is the success case when the ask
    # covered the window; what actually loses data is a window needing more
    # buckets than the server's cap allows, since `limit` is clamped at
    # CANDLE_LIMIT_CAP in silence. Comparing rows to `limit` instead — the
    # obvious check — flags every complete series as truncated.
    if window_buckets > limit:
        issues.append(
            Issue(
                "window_truncated",
                f"the window needs {window_buckets} buckets at this timeframe and the "
                f"venue caps a request at {CANDLE_LIMIT_CAP}, so this covers only the "
                f"most recent {limit} — use a coarser timeframe to reach further back",
            )
        )

    step_ms = _modal_step([c.start_ms for c in deduped])
    expected = TIMEFRAMES.get(requested_timeframe)

    if expected is None:
        issues.append(
            Issue(
                "timeframe_unsupported",
                f"{requested_timeframe!r} is not one of the honoured timeframes "
                f"({', '.join(TIMEFRAMES)}); this venue answers anything else with "
                "1m candles and no error",
                severity="fatal",
            )
        )
    elif step_ms is not None and step_ms != expected:
        issues.append(
            Issue(
                "timeframe_not_honoured",
                f"asked for {requested_timeframe} ({expected} ms buckets) and got "
                f"{step_ms} ms buckets — the venue silently substituted a different "
                "interval, so nothing here can be labelled "
                f"{requested_timeframe}",
                severity="fatal",
            )
        )

    on_grid = deduped
    if step_ms is not None and deduped:
        anchor = deduped[0].start_ms
        on_grid = [c for c in deduped if (c.start_ms - anchor) % step_ms == 0]
        off_grid = len(deduped) - len(on_grid)
        if off_grid:
            issues.append(
                Issue(
                    "off_grid_timestamp",
                    f"{off_grid} bucket(s) were not a whole number of steps from the "
                    "first one and were dropped (this venue's hourly grid is not "
                    "anchored to the clock hour, and shifts mid-series)",
                )
            )

    # The last bucket is still being written while the window includes now, so
    # its close and volume are partial. Including it makes the most recent
    # return and the total volume both wrong, in the direction that looks like
    # news.
    if on_grid and step_ms is not None and on_grid[-1].start_ms + step_ms > now_ms:
        dropped = on_grid[-1]
        on_grid = on_grid[:-1]
        issues.append(
            Issue(
                "forming_bucket_dropped",
                f"the bucket starting at {dropped.start_ms} has not closed yet and "
                "was excluded",
                severity="info",
            )
        )

    expected_buckets = 0
    if step_ms and len(on_grid) >= 2:
        expected_buckets = (on_grid[-1].start_ms - on_grid[0].start_ms) // step_ms + 1
        missing = expected_buckets - len(on_grid)
        if missing > 0:
            issues.append(
                Issue(
                    "missing_buckets",
                    f"{missing} of {expected_buckets} buckets in the window are absent "
                    "(nothing traded in them), so consecutive rows are not a fixed "
                    "interval apart",
                )
            )
    elif not on_grid and rows_received == 0:
        # An empty series is a state, not a failure, and not necessarily a market
        # that never traded: measured on testnet, `NDQ-USDX-PERP` returns nothing
        # at 5m while its 1m series has data. So the message points at the
        # timeframe rather than concluding anything about the market.
        issues.append(
            Issue(
                "no_candles",
                f"the venue returned no candles at all at {requested_timeframe}; some "
                "markets here have a 1m series and nothing coarser, so try "
                "--timeframe 1m before concluding the market never traded",
                severity="fatal",
            )
        )
    elif len(on_grid) < 2:
        issues.append(
            Issue(
                "too_short",
                f"only {len(on_grid)} usable candle(s) after validation — not enough "
                "for a return",
                severity="fatal",
            )
        )

    return CandleSeries(
        market=market,
        requested_timeframe=requested_timeframe,
        candles=tuple(on_grid),
        step_ms=step_ms,
        issues=tuple(issues),
        rows_received=rows_received,
        expected_buckets=expected_buckets,
    )


def _modal_step(timestamps: Sequence[int]) -> int | None:
    """The most common gap between consecutive timestamps.

    The mode rather than the minimum, the mean, or the greatest common divisor.
    The minimum is thrown off by one duplicate-ish row, the mean by any gap at
    all, and the gcd by a single off-grid timestamp — and this venue has one, so
    the gcd of the observed steps in its hourly series comes out at 1 ms. The
    most common step survives all three.
    """
    if len(timestamps) < 2:
        return None
    diffs = Counter(b - a for a, b in zip(timestamps, timestamps[1:]) if b > a)
    if not diffs:
        return None
    return diffs.most_common(1)[0][0]


@dataclass(frozen=True)
class Returns:
    values: tuple[Decimal, ...]
    skipped_gaps: int

    @property
    def count(self) -> int:
        return len(self.values)


def consecutive_returns(series: CandleSeries) -> Returns:
    """Close-to-close simple returns, over adjacent buckets only.

    The gap handling is the point. A series with holes in it still has rows next
    to each other in the list, and subtracting those two closes gives a return
    over however long the hole was — reported as if it were one bucket. That
    understates the number of periods and mis-scales anything annualised from
    it, so a pair that is not exactly one step apart is skipped and counted.
    """
    if series.step_ms is None or len(series.candles) < 2:
        return Returns((), 0)

    values: list[Decimal] = []
    skipped = 0
    for previous, current in zip(series.candles, series.candles[1:]):
        if current.start_ms - previous.start_ms != series.step_ms:
            skipped += 1
            continue
        if previous.close == 0:
            skipped += 1
            continue
        try:
            values.append((current.close - previous.close) / previous.close)
        except (DivisionByZero, InvalidOperation):
            skipped += 1
    return Returns(tuple(values), skipped)


def realized_volatility(returns: Returns, step_ms: int) -> Decimal | None:
    """Annualised close-to-close volatility, or None when there is too little.

    Sample standard deviation (n-1) of the simple returns, scaled by the square
    root of the number of buckets in a 365-day year. Every part of that is a
    convention rather than a fact — calendar days not trading days, simple
    returns not log returns, no mean adjustment — which is why the README states
    it and this returns None instead of a small number when there is not enough
    data to say anything.
    """
    if returns.count < 2 or step_ms <= 0:
        return None
    mean = sum(returns.values, Decimal(0)) / Decimal(returns.count)
    variance = sum(((value - mean) ** 2 for value in returns.values), Decimal(0)) / Decimal(
        returns.count - 1
    )
    periods_per_year = Decimal(MS_PER_YEAR) / Decimal(step_ms)
    try:
        return (variance * periods_per_year).sqrt()
    except (InvalidOperation, DivisionByZero):
        return None


# ── funding ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FundingPoint:
    timestamp_ms: int
    rate: Decimal


@dataclass(frozen=True)
class FundingSeries:
    market: str
    points: tuple[FundingPoint, ...]
    step_ms: int | None
    issues: tuple[Issue, ...] = field(default_factory=tuple)

    @property
    def mean_rate(self) -> Decimal | None:
        if not self.points:
            return None
        return sum((p.rate for p in self.points), Decimal(0)) / Decimal(len(self.points))

    @property
    def annualized(self) -> Decimal | None:
        """Mean rate × intervals per year, with the interval taken from the data.

        Derived rather than assumed. This venue currently funds hourly, so the
        factor is 8760 — but hard-coding that is how a report keeps quoting
        annualised carry off by 8× after the interval changes. The observed step
        is right there in the timestamps.
        """
        mean = self.mean_rate
        if mean is None or not self.step_ms:
            return None
        return mean * (Decimal(MS_PER_YEAR) / Decimal(self.step_ms))


def parse_funding(rows: Any, *, market: str) -> FundingSeries:
    """Validate a `/funding` payload.

    Note what is different here: this route sends rates as decimal *strings*
    with 28 significant digits, where `/candles` and `/tickers` send JSON
    doubles. The same API is deliberately two-faced about numbers, so the
    parsing has to be too — which is exactly why nothing in this example
    converts through `float` on the way in.
    """
    issues: list[Issue] = []
    if not isinstance(rows, list):
        return FundingSeries(
            market,
            (),
            None,
            (Issue("payload_shape", f"expected an array, got {type(rows).__name__}"),),
        )

    points: list[FundingPoint] = []
    malformed = 0
    for row in rows:
        if not isinstance(row, dict):
            malformed += 1
            continue
        try:
            timestamp_raw = row["timestamp"]
            if isinstance(timestamp_raw, float):
                raise ValueError("funding timestamp arrived as a float")
            timestamp = int(timestamp_raw)
            rate = to_decimal(row["funding_rate"], "funding_rate")
        except (KeyError, ValueError, TypeError, ArithmeticError):
            malformed += 1
            continue
        if timestamp <= 0:
            malformed += 1
            continue
        points.append(FundingPoint(timestamp, rate))

    if malformed:
        issues.append(Issue("row_shape", f"{malformed} funding row(s) were unusable"))

    points.sort(key=lambda p: p.timestamp_ms)
    step = _modal_step([p.timestamp_ms for p in points])
    return FundingSeries(market, tuple(points), step, tuple(issues))


# ── the venue's own event history ────────────────────────────────────────────


def bucket_fill_history(rows: Any, *, step_ms: int, now_ms: int, buckets: int) -> list[int]:
    """Fills per bucket, from `/stats/history`.

    That endpoint is not a time series: it is one row per moment something
    happened, at irregular timestamps a second or two apart. Charting it as-is
    plots the venue's event *timing* and calls it activity, so it is bucketed
    onto a fixed grid first — and the grid is built here rather than inferred,
    because there is none in the data to infer.
    """
    counts = [0] * buckets
    if not isinstance(rows, list) or step_ms <= 0 or buckets <= 0:
        return counts
    start = now_ms - buckets * step_ms
    for row in rows:
        if not isinstance(row, dict):
            continue
        # Checked with `isinstance` rather than coerced in a `try`. A `bool` is
        # an `int` in Python, and `True` would otherwise become a timestamp of 1.
        timestamp_raw = row.get("timestamp")
        fills_raw = row.get("fills", 0)
        if not isinstance(timestamp_raw, int) or isinstance(timestamp_raw, bool):
            continue
        if not isinstance(fills_raw, int) or isinstance(fills_raw, bool):
            continue
        timestamp, fills = timestamp_raw, fills_raw
        if timestamp < start or timestamp >= now_ms:
            continue
        index = (timestamp - start) // step_ms
        if 0 <= index < buckets:
            counts[index] += fills
    return counts

