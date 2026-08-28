"""The figures, assembled from validated series and the venue's own snapshots.

Nothing here fetches or parses raw payloads beyond the flat snapshot routes; the
series work lives in `series.py`. What this file owns is the arithmetic and,
more importantly, the decision about when *not* to produce a number: a market
whose candle series did not survive validation still gets a row in the report,
with its 24h snapshot and an explicit "no usable series", rather than a zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, DivisionByZero, InvalidOperation
from typing import Any, Mapping

from series import (
    CandleSeries,
    FundingSeries,
    Issue,
    Returns,
    consecutive_returns,
    realized_volatility,
    to_decimal,
)


def _opt_decimal(value: Any, what: str) -> Decimal | None:
    """A field the venue reports optionally.

    `None` stays `None` and never becomes `0`. The venue distinguishes the two —
    `NDQ-USDX-PERP` currently reports `"close": null` with a real high and low —
    and substituting zero for "not reported" turns a market with no closing
    trade into one that closed at nothing.
    """
    if value is None:
        return None
    try:
        return to_decimal(value, what)
    except ValueError:
        return None


@dataclass(frozen=True)
class MarketRules:
    market: str
    tick_size: Decimal | None
    lot_size: Decimal | None
    min_order_size: Decimal | None
    max_leverage: int | None


@dataclass(frozen=True)
class SummaryRow:
    """One market's 24h figures and halt state, from `/api/v1/markets/summary`."""

    market: str
    status: str
    halt_reason: str | None
    halted_at_ms: int | None
    last_trade_price: Decimal | None
    mark_price: Decimal | None
    volume_24h: Decimal | None
    trade_count: int | None
    rules: MarketRules


@dataclass(frozen=True)
class MarketSnapshot:
    """One market, reconciled across the three routes that list markets.

    Three, because they disagree. Measured on this deployment: `/markets` and
    `/api/v1/tickers` both list four markets, and `/api/v1/markets/summary`
    lists three — `NDQ-USDX-PERP` is simply absent from it. A tool that
    enumerates markets from the summary route reports on three markets and never
    mentions that it skipped one, which is the failure mode an analytics tool
    exists to not have.

    So the catalog is the union, and where a market is missing from a source that
    is recorded as a finding rather than smoothed over.
    """

    market: str
    status: str
    halt_reason: str | None
    halted_at_ms: int | None
    last_trade_price: Decimal | None
    mark_price: Decimal | None
    volume_24h: Decimal | None
    trade_count: int | None
    rules: MarketRules
    in_catalog: bool = True
    in_summary: bool = True
    in_tickers: bool = True

    @property
    def source_issues(self) -> tuple[Issue, ...]:
        found: list[Issue] = []
        if not self.in_summary:
            found.append(
                Issue(
                    "missing_from_summary",
                    "listed by /markets but absent from /api/v1/markets/summary, so "
                    "there is no 24h volume, trade count or halt status for it — the "
                    "row below is what the other routes could supply",
                )
            )
        if not self.in_catalog:
            found.append(
                Issue(
                    "missing_from_catalog",
                    "reported by /api/v1/markets/summary or /api/v1/tickers but not "
                    "listed by /markets, so its trading rules are unknown",
                )
            )
        if not self.in_tickers:
            found.append(
                Issue("missing_from_tickers", "absent from /api/v1/tickers")
            )
        return tuple(found)


@dataclass(frozen=True)
class TickerSnapshot:
    market: str
    open: Decimal | None
    high: Decimal | None
    low: Decimal | None
    close: Decimal | None
    change_pct: Decimal | None
    base_volume: Decimal | None
    quote_volume: Decimal | None
    mark_price: Decimal | None
    bid: Decimal | None
    ask: Decimal | None

    @property
    def has_two_sided_book(self) -> bool:
        return self.bid is not None and self.ask is not None


@dataclass(frozen=True)
class VenueStats:
    health: str
    fills_total: int | None
    liquidations_total: int | None
    unique_traders_24h: int | None
    unique_traders_7d: int | None
    unique_traders_30d: int | None
    lag_ms: int | None
    uptime_seconds: int | None
    gap_count: int | None


@dataclass(frozen=True)
class MarketAnalysis:
    snapshot: MarketSnapshot
    ticker: TickerSnapshot | None
    series: CandleSeries | None
    returns: Returns | None
    funding: FundingSeries | None

    window_open: Decimal | None = None
    window_high: Decimal | None = None
    window_low: Decimal | None = None
    window_close: Decimal | None = None
    window_return: Decimal | None = None
    window_base_volume: Decimal | None = None
    window_vwap: Decimal | None = None
    volatility_annual: Decimal | None = None
    derived_issues: tuple[Issue, ...] = ()

    @property
    def market(self) -> str:
        return self.snapshot.market

    @property
    def has_series(self) -> bool:
        return self.series is not None and self.series.usable

    @property
    def issues(self) -> tuple[Issue, ...]:
        found: list[Issue] = list(self.snapshot.source_issues)
        found.extend(self.derived_issues)
        if self.series is not None:
            found.extend(self.series.issues)
        if self.funding is not None:
            found.extend(self.funding.issues)
        return tuple(found)


def parse_market_rules(row: Mapping[str, Any], market: str) -> MarketRules:
    leverage = row.get("max_leverage")
    return MarketRules(
        market=market,
        tick_size=_opt_decimal(row.get("tick_size"), "tick_size"),
        lot_size=_opt_decimal(row.get("lot_size"), "lot_size"),
        min_order_size=_opt_decimal(row.get("min_order_size"), "min_order_size"),
        max_leverage=int(leverage) if isinstance(leverage, int) else None,
    )


def parse_catalog(payload: Any) -> dict[str, MarketRules]:
    """Parse the market catalog and its trading rules.

    This one route is **not** under `/api/v1` on this deployment: it is
    `{gateway}/markets`, and `{gateway}/api/v1/markets` is a 404. The Python
    SDK says the same thing in a comment on its own `fetch_markets` — "not
    migrated to /api/v1 (no direct-service route yet); stays on the legacy
    gateway" — so this is a known split rather than a quirk of one host, and it
    is the kind of thing worth encoding in a client instead of rediscovering.
    """
    catalog: dict[str, MarketRules] = {}
    if not isinstance(payload, list):
        return catalog
    for row in payload:
        if not isinstance(row, dict):
            continue
        market = row.get("market_id")
        if not isinstance(market, str) or not market:
            continue
        catalog[market] = parse_market_rules(row, market)
    return catalog


def parse_summaries(payload: Any) -> dict[str, SummaryRow]:
    """Parse `/api/v1/markets/summary`, skipping anything unrecognisable."""
    rows: dict[str, SummaryRow] = {}
    if not isinstance(payload, list):
        return rows
    for row in payload:
        if not isinstance(row, dict):
            continue
        market = row.get("market_id")
        if not isinstance(market, str) or not market:
            continue
        halted_at = row.get("halted_at")
        trade_count = row.get("trade_count")
        halt_reason = row.get("halt_reason")
        rows[market] = SummaryRow(
            market=market,
            status=str(row.get("status") or "unknown"),
            halt_reason=str(halt_reason) if isinstance(halt_reason, str) else None,
            halted_at_ms=int(halted_at) if isinstance(halted_at, int) else None,
            last_trade_price=_opt_decimal(row.get("last_trade_price"), "last_trade_price"),
            mark_price=_opt_decimal(row.get("engine_mark_price"), "engine_mark_price"),
            volume_24h=_opt_decimal(row.get("volume_24h"), "volume_24h"),
            trade_count=int(trade_count) if isinstance(trade_count, int) else None,
            rules=parse_market_rules(row, market),
        )
    return rows


def merge_market_sources(
    catalog: Mapping[str, MarketRules],
    summaries: Mapping[str, SummaryRow],
    tickers: Mapping[str, TickerSnapshot],
) -> dict[str, MarketSnapshot]:
    """The union of everything the venue lists, with each source's absence noted.

    The union rather than any one route, because on this deployment they
    disagree — see `MarketSnapshot`. Fields come from the summary where it has
    them and are left absent where it does not; a ticker's `close` and `markPrice`
    fill in the last price and mark for a market the summary omits, so a
    never-traded market still gets a row instead of vanishing.
    """
    snapshots: dict[str, MarketSnapshot] = {}
    for market in sorted(set(catalog) | set(summaries) | set(tickers)):
        summary = summaries.get(market)
        ticker = tickers.get(market)
        rules = catalog.get(market)
        if rules is None and summary is not None:
            rules = summary.rules
        snapshots[market] = MarketSnapshot(
            market=market,
            status=summary.status if summary is not None else "unknown",
            halt_reason=summary.halt_reason if summary is not None else None,
            halted_at_ms=summary.halted_at_ms if summary is not None else None,
            last_trade_price=(
                summary.last_trade_price
                if summary is not None and summary.last_trade_price is not None
                else (ticker.close if ticker is not None else None)
            ),
            mark_price=summary.mark_price if summary is not None else None,
            volume_24h=(
                summary.volume_24h
                if summary is not None and summary.volume_24h is not None
                else (ticker.quote_volume if ticker is not None else None)
            ),
            trade_count=summary.trade_count if summary is not None else None,
            rules=rules or MarketRules(market, None, None, None, None),
            in_catalog=market in catalog,
            in_summary=market in summaries,
            in_tickers=market in tickers,
        )
    return snapshots


def parse_tickers(payload: Any) -> dict[str, TickerSnapshot]:
    """Parse `/api/v1/tickers`, which is a **map keyed by symbol**, not a list.

    Worth stating because every other list-shaped route here is a list, and a
    `for row in payload` over this one iterates the keys and quietly finds
    nothing.
    """
    tickers: dict[str, TickerSnapshot] = {}
    if not isinstance(payload, dict):
        return tickers
    for market, row in payload.items():
        if not isinstance(market, str) or not isinstance(row, dict):
            continue
        tickers[market] = TickerSnapshot(
            market=market,
            open=_opt_decimal(row.get("open"), "open"),
            high=_opt_decimal(row.get("high"), "high"),
            low=_opt_decimal(row.get("low"), "low"),
            close=_opt_decimal(row.get("close"), "close"),
            change_pct=_opt_decimal(row.get("percentage"), "percentage"),
            base_volume=_opt_decimal(row.get("baseVolume"), "baseVolume"),
            quote_volume=_opt_decimal(row.get("quoteVolume"), "quoteVolume"),
            mark_price=_opt_decimal(row.get("markPrice"), "markPrice"),
            bid=_opt_decimal(row.get("bid"), "bid"),
            ask=_opt_decimal(row.get("ask"), "ask"),
        )
    return tickers


def parse_venue_stats(payload: Any) -> VenueStats:
    def as_int(key: str) -> int | None:
        value = payload.get(key) if isinstance(payload, dict) else None
        return int(value) if isinstance(value, int) else None

    health = "unknown"
    if isinstance(payload, dict) and isinstance(payload.get("health"), str):
        health = str(payload["health"])
    return VenueStats(
        health=health,
        fills_total=as_int("fills_total"),
        liquidations_total=as_int("liquidations_total"),
        unique_traders_24h=as_int("unique_traders_24h"),
        unique_traders_7d=as_int("unique_traders_7d"),
        unique_traders_30d=as_int("unique_traders_30d"),
        lag_ms=as_int("lag_ms"),
        uptime_seconds=as_int("uptime_seconds"),
        gap_count=as_int("gap_count"),
    )


def analyze_market(
    snapshot: MarketSnapshot,
    ticker: TickerSnapshot | None,
    candles: CandleSeries | None,
    funding: FundingSeries | None,
) -> MarketAnalysis:
    """Derive the window figures, or leave them absent."""
    # Computed before the early return, because these findings are about the
    # snapshot and the ticker: a market with no usable candle series can still
    # have a one-sided book worth mentioning.
    derived = _derived_findings(snapshot, ticker, None)

    if candles is None or not candles.usable or candles.step_ms is None:
        return MarketAnalysis(
            snapshot, ticker, candles, None, funding, derived_issues=derived
        )

    rows = candles.candles
    returns = consecutive_returns(candles)

    window_open = rows[0].open
    window_close = rows[-1].close
    window_high = max(candle.high for candle in rows)
    window_low = min(candle.low for candle in rows)
    base_volume = sum((candle.volume for candle in rows), Decimal(0))

    window_return: Decimal | None = None
    if window_open != 0:
        try:
            window_return = (window_close - window_open) / window_open
        except (DivisionByZero, InvalidOperation):
            window_return = None

    # Volume-weighted typical price. An approximation of VWAP and labelled as
    # one everywhere it is shown: candles carry no trade-by-trade prices, so the
    # best available proxy is each bucket's (high + low + close) / 3 weighted by
    # its volume. Buckets with no volume contribute nothing rather than dragging
    # the average towards an unweighted mean.
    vwap: Decimal | None = None
    weighted = sum(
        (candle.volume * (candle.high + candle.low + candle.close) / 3 for candle in rows),
        Decimal(0),
    )
    if base_volume > 0:
        try:
            vwap = weighted / base_volume
        except (DivisionByZero, InvalidOperation):
            vwap = None

    return MarketAnalysis(
        snapshot=snapshot,
        ticker=ticker,
        series=candles,
        returns=returns,
        funding=funding,
        derived_issues=_derived_findings(snapshot, ticker, window_close),
        window_open=window_open,
        window_high=window_high,
        window_low=window_low,
        window_close=window_close,
        window_return=window_return,
        window_base_volume=base_volume,
        window_vwap=vwap,
        volatility_annual=realized_volatility(returns, candles.step_ms),
    )


# The factor at which two of the venue's own prices for one market stop being a
# rounding difference and start being a contradiction. Arbitrary, and stated
# rather than hidden: 2x is far outside anything a stale quote explains, and far
# inside the 25x that testnet is currently reporting for one market.
PRICE_DISAGREEMENT_FACTOR = Decimal(2)


def _derived_findings(
    snapshot: MarketSnapshot, ticker: TickerSnapshot | None, window_close: Decimal | None
) -> tuple[Issue, ...]:
    """Findings about a market that come from comparing the venue to itself."""
    found: list[Issue] = []

    # Neither side of the book quoted. Not a defect and not this report's problem
    # — nothing here computes a spread — but it is the sort of thing an analytics
    # reader needs to know *before* they compute one, and it appears nowhere else
    # in the output because bid and ask are not columns. Routine, so `info`.
    if ticker is not None and not ticker.has_two_sided_book:
        side = "neither side"
        if ticker.bid is not None:
            side = "no ask"
        elif ticker.ask is not None:
            side = "no bid"
        found.append(
            Issue(
                "one_sided_book",
                f"/api/v1/tickers reports {side} for this market, so any spread or "
                "mid derived from it would be unusable — this report prices off "
                "candles and the mark instead",
                severity="info",
            )
        )

    found.extend(_price_disagreement(snapshot, ticker, window_close))
    return tuple(found)


def _price_disagreement(
    snapshot: MarketSnapshot, ticker: TickerSnapshot | None, window_close: Decimal | None
) -> tuple[Issue, ...]:
    """Flag a market whose mark price and traded price are not the same asset.

    Presence checks catch a market that is missing from a route; this catches one
    that is present in two routes with values that cannot both be right.
    `NDQ-USDX-PERP` currently reports a mark price of 717.5 in `/api/v1/tickers`
    while its candles trade around 18,466 — a factor of 25. Any figure combining
    the two (a notional, a funding cost, a margin estimate) would be wrong by
    that factor, silently, so it is worth one comparison to say so.
    """
    mark = snapshot.mark_price
    if mark is None and ticker is not None:
        mark = ticker.mark_price
    if mark is None or window_close is None or mark <= 0 or window_close <= 0:
        return ()

    high, low = max(mark, window_close), min(mark, window_close)
    if high / low < PRICE_DISAGREEMENT_FACTOR:
        return ()
    return (
        Issue(
            "price_sources_disagree",
            f"the venue's mark price ({mark}) and this window's closing traded price "
            f"({window_close}) differ by a factor of {(high / low).quantize(Decimal('0.1'))}; "
            "any figure that mixes the two is wrong by roughly that much",
        ),
    )
