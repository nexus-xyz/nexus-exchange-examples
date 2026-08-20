#!/usr/bin/env python3
"""Tests for market-report. Offline, standard library only.

    python3 -m unittest -v          # or: python3 test_report.py

Two halves. Most of it is the validation in `series.py`, checked against the
exact shapes this venue really returns — the timestamp-0 row, the silent
timeframe fallback, missing and off-grid buckets. The rest stands a real HTTP
server up on the loopback interface, so the client's own refusals (HTML instead
of JSON, a redirect, a body over the cap) are exercised against a socket rather
than a mock.

CI does not run these — the Python recipe compiles and typechecks every example
— so they are here for the reader and for whoever changes this next.
"""

from __future__ import annotations

import io
import json
import threading
import unittest
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable

import api
import render
from analysis import (
    MarketRules,
    SummaryRow,
    analyze_market,
    merge_market_sources,
    parse_catalog,
    parse_summaries,
    parse_tickers,
    parse_venue_stats,
)
from api import Api, ApiError, Cache
from series import (
    TIMEFRAMES,
    bucket_fill_history,
    consecutive_returns,
    parse_candles,
    parse_funding,
    parse_candles as parse,
    realized_volatility,
    to_decimal,
)

HOUR = 3_600_000
MINUTE = 60_000

# A fixed "now" well past every timestamp in the fixtures, so no test depends on
# the clock — the forming-bucket rule is exercised by choosing `now` explicitly.
NOW = 2_000_000_000_000


def candle(start: int, close: str = "100", volume: str = "1") -> list[Any]:
    """A candle in the venue's own shape: [start, open, high, low, close, volume].

    Values as `Decimal`, because that is what `json.loads(parse_float=Decimal)`
    produces and therefore what the parser really sees.
    """
    return [start, Decimal("100"), Decimal("101"), Decimal("99"), Decimal(close), Decimal(volume)]


def codes(series: Any) -> list[str]:
    return [issue.code for issue in series.issues]


class TestCandleValidation(unittest.TestCase):
    def test_drops_the_zero_timestamp_row(self) -> None:
        """The venue puts one at the head of its 5m and 1h series."""
        rows = [candle(0)] + [candle(HOUR * i) for i in range(1, 5)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=5, window_buckets=5, now_ms=NOW
        )
        self.assertIn("nonpositive_timestamp", codes(series))
        self.assertTrue(all(c.start_ms > 0 for c in series.candles))
        self.assertEqual(len(series.candles), 4)

    def test_detects_the_silent_timeframe_fallback(self) -> None:
        """Ask for 1h, get 1m. The venue does this with no error at all."""
        rows = [candle(MINUTE * i) for i in range(1, 40)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=40, window_buckets=40, now_ms=NOW
        )
        self.assertFalse(series.timeframe_honoured)
        self.assertIn("timeframe_not_honoured", codes(series))
        self.assertFalse(series.usable)
        self.assertEqual(series.step_ms, MINUTE)

    def test_honoured_timeframe_is_usable(self) -> None:
        rows = [candle(HOUR * i) for i in range(1, 25)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=24, window_buckets=24, now_ms=NOW
        )
        self.assertTrue(series.timeframe_honoured)
        self.assertTrue(series.usable)
        self.assertEqual(series.coverage, Decimal(1))

    def test_unsupported_timeframe_is_fatal(self) -> None:
        rows = [candle(MINUTE * i) for i in range(1, 10)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1d", limit=9, window_buckets=9, now_ms=NOW
        )
        self.assertIn("timeframe_unsupported", codes(series))
        self.assertFalse(series.usable)

    def test_counts_missing_buckets(self) -> None:
        # 1..10 with 4, 5 and 8 absent, the way a market with no trades looks.
        present = [1, 2, 3, 6, 7, 9, 10]
        rows = [candle(HOUR * i) for i in present]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=10, window_buckets=10, now_ms=NOW
        )
        self.assertIn("missing_buckets", codes(series))
        self.assertEqual(series.expected_buckets, 10)
        self.assertEqual(series.missing_buckets, 3)
        self.assertEqual(series.coverage, Decimal(7) / Decimal(10))

    def test_drops_off_grid_timestamps(self) -> None:
        """This venue's hourly grid is not clock-aligned and shifts mid-series."""
        rows = [candle(HOUR), candle(2 * HOUR), candle(2 * HOUR + 12345), candle(3 * HOUR)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=4, window_buckets=4, now_ms=NOW
        )
        self.assertIn("off_grid_timestamp", codes(series))
        self.assertEqual([c.start_ms for c in series.candles], [HOUR, 2 * HOUR, 3 * HOUR])

    def test_drops_the_forming_bucket(self) -> None:
        now = 5 * HOUR + 100          # inside the bucket that starts at 5h
        rows = [candle(HOUR * i) for i in range(1, 6)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=5, window_buckets=5, now_ms=now
        )
        self.assertIn("forming_bucket_dropped", codes(series))
        self.assertEqual(series.candles[-1].start_ms, 4 * HOUR)

    def test_keeps_a_closed_final_bucket(self) -> None:
        rows = [candle(HOUR * i) for i in range(1, 6)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=5, window_buckets=5,
            now_ms=6 * HOUR + 1,
        )
        self.assertNotIn("forming_bucket_dropped", codes(series))
        self.assertEqual(series.candles[-1].start_ms, 5 * HOUR)

    def test_sorts_and_deduplicates(self) -> None:
        rows = [candle(3 * HOUR), candle(HOUR), candle(2 * HOUR), candle(2 * HOUR)]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=4, window_buckets=4, now_ms=NOW
        )
        self.assertIn("unsorted", codes(series))
        self.assertIn("duplicate_timestamp", codes(series))
        self.assertEqual([c.start_ms for c in series.candles], [HOUR, 2 * HOUR, 3 * HOUR])

    def test_survives_malformed_rows(self) -> None:
        rows: list[Any] = [
            candle(HOUR),
            {"not": "a candle"},
            [2 * HOUR, 1, 2, 3],                     # too short
            [3 * HOUR, "x", "y", "z", "w", "v"],     # not numbers
            candle(4 * HOUR),
        ]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=5, window_buckets=5, now_ms=NOW
        )
        self.assertIn("row_shape", codes(series))
        self.assertEqual(len(series.candles), 2)

    def test_rejects_a_non_list_payload(self) -> None:
        series = parse_candles(
            {"error": "nope"}, market="M", requested_timeframe="1h", limit=5,
            window_buckets=5, now_ms=NOW,
        )
        self.assertIn("payload_shape", codes(series))
        self.assertFalse(series.usable)

    def test_empty_payload_is_a_never_traded_market(self) -> None:
        series = parse_candles(
            [], market="NDQ-USDX-PERP", requested_timeframe="1h", limit=5,
            window_buckets=5, now_ms=NOW,
        )
        self.assertIn("no_candles", codes(series))
        self.assertFalse(series.usable)

    def test_window_truncation_is_about_the_request_not_the_row_count(self) -> None:
        rows = [candle(HOUR * i) for i in range(1, 11)]
        # Ten rows for a ten-bucket ask: complete, and must not be called truncated.
        complete = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=10, window_buckets=10, now_ms=NOW
        )
        self.assertNotIn("window_truncated", codes(complete))
        # The same rows, for a window that needed more than the cap allows.
        cut = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=10, window_buckets=5000, now_ms=NOW
        )
        self.assertIn("window_truncated", codes(cut))


class TestReturnsAndVolatility(unittest.TestCase):
    def test_returns_skip_gap_spanning_pairs(self) -> None:
        rows = [candle(HOUR, "100"), candle(2 * HOUR, "110"), candle(5 * HOUR, "121")]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=3, window_buckets=3, now_ms=NOW
        )
        returns = consecutive_returns(series)
        # 1h→2h is adjacent and counts; 2h→5h spans a gap and does not.
        self.assertEqual(returns.count, 1)
        self.assertEqual(returns.skipped_gaps, 1)
        self.assertEqual(returns.values[0], Decimal("0.1"))

    def test_zero_volatility_for_a_constant_return(self) -> None:
        rows = [candle(HOUR, "100"), candle(2 * HOUR, "110"), candle(3 * HOUR, "121")]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=3, window_buckets=3, now_ms=NOW
        )
        volatility = realized_volatility(consecutive_returns(series), HOUR)
        self.assertIsNotNone(volatility)
        assert volatility is not None
        self.assertEqual(volatility, Decimal(0))

    def test_annualisation_uses_the_step(self) -> None:
        # Returns of +0.1 and -0.1: mean 0, sample variance 0.02.
        # Annualised at hourly buckets: sqrt(0.02 * 8760) = sqrt(175.2).
        rows = [candle(HOUR, "100"), candle(2 * HOUR, "110"), candle(3 * HOUR, "99")]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=3, window_buckets=3, now_ms=NOW
        )
        volatility = realized_volatility(consecutive_returns(series), HOUR)
        assert volatility is not None
        self.assertEqual(round(volatility, 4), round(Decimal("175.2").sqrt(), 4))

    def test_no_volatility_from_one_sample(self) -> None:
        rows = [candle(HOUR, "100"), candle(2 * HOUR, "110")]
        series = parse_candles(
            rows, market="M", requested_timeframe="1h", limit=2, window_buckets=2, now_ms=NOW
        )
        self.assertIsNone(realized_volatility(consecutive_returns(series), HOUR))


class TestDecimalBoundary(unittest.TestCase):
    def test_floats_are_refused(self) -> None:
        """A float here means JSON was parsed without parse_float=Decimal."""
        with self.assertRaises(ValueError) as caught:
            to_decimal(1.5, "price")
        self.assertIn("parse_float=Decimal", str(caught.exception))

    def test_accepts_the_shapes_the_wire_really_sends(self) -> None:
        self.assertEqual(to_decimal("0.0000101026291887794966498108", "rate"),
                         Decimal("0.0000101026291887794966498108"))
        self.assertEqual(to_decimal(7, "count"), Decimal(7))
        self.assertEqual(to_decimal(Decimal("1.10"), "price"), Decimal("1.10"))

    def test_booleans_and_junk_are_refused(self) -> None:
        for value in (True, "abc", None, [1]):
            with self.assertRaises(ValueError):
                to_decimal(value, "price")

    def test_json_parsing_keeps_the_digits_the_venue_sent(self) -> None:
        # The live venue really does return this 24h change.
        payload = json.loads('{"change": 391.2000000000003}', parse_float=Decimal)
        self.assertIsInstance(payload["change"], Decimal)
        self.assertEqual(str(payload["change"]), "391.2000000000003")


class TestFunding(unittest.TestCase):
    def test_parses_decimal_strings_and_derives_the_interval(self) -> None:
        rows = [
            {"timestamp": HOUR, "funding_rate": "0.001"},
            {"timestamp": 2 * HOUR, "funding_rate": "0.002"},
            {"timestamp": 3 * HOUR, "funding_rate": "0.003"},
        ]
        series = parse_funding(rows, market="M")
        self.assertEqual(series.step_ms, HOUR)
        self.assertEqual(series.mean_rate, Decimal("0.002"))
        # 8760 hourly intervals in a 365-day year.
        self.assertEqual(series.annualized, Decimal("0.002") * 8760)

    def test_annualisation_follows_a_different_interval(self) -> None:
        """The factor is measured, not the hardcoded 8760 that is right today."""
        rows = [{"timestamp": 4 * HOUR * i, "funding_rate": "0.001"} for i in range(1, 5)]
        series = parse_funding(rows, market="M")
        self.assertEqual(series.step_ms, 4 * HOUR)
        self.assertEqual(series.annualized, Decimal("0.001") * 2190)

    def test_unusable_rows_are_counted_not_fatal(self) -> None:
        rows: list[Any] = [
            {"timestamp": HOUR, "funding_rate": "0.001"},
            {"timestamp": 0, "funding_rate": "0.001"},
            {"timestamp": 2 * HOUR},
            "not a row",
        ]
        series = parse_funding(rows, market="M")
        self.assertEqual(len(series.points), 1)
        self.assertEqual([issue.code for issue in series.issues], ["row_shape"])

    def test_no_points_means_no_number(self) -> None:
        series = parse_funding([], market="M")
        self.assertIsNone(series.mean_rate)
        self.assertIsNone(series.annualized)


class TestFillHistory(unittest.TestCase):
    def test_buckets_irregular_timestamps(self) -> None:
        now = 100_000
        step = 10_000
        rows = [
            {"timestamp": now - 95_000, "fills": 1},   # bucket 0
            {"timestamp": now - 91_000, "fills": 2},   # bucket 0
            {"timestamp": now - 5_000, "fills": 3},    # last bucket
            {"timestamp": now + 1_000, "fills": 9},    # future: ignored
            {"timestamp": now - 500_000, "fills": 9},  # before the window: ignored
        ]
        counts = bucket_fill_history(rows, step_ms=step, now_ms=now, buckets=10)
        self.assertEqual(len(counts), 10)
        self.assertEqual(counts[0], 3)
        self.assertEqual(counts[-1], 3)
        self.assertEqual(sum(counts), 6)

    def test_junk_is_ignored(self) -> None:
        counts = bucket_fill_history("nope", step_ms=1000, now_ms=NOW, buckets=4)
        self.assertEqual(counts, [0, 0, 0, 0])


class TestMarketSources(unittest.TestCase):
    def summary(self, market: str) -> SummaryRow:
        return SummaryRow(
            market=market, status="active", halt_reason=None, halted_at_ms=None,
            last_trade_price=Decimal(10), mark_price=Decimal(10),
            volume_24h=Decimal(100), trade_count=5,
            rules=MarketRules(market, None, None, None, None),
        )

    def test_a_market_missing_from_the_summary_still_appears(self) -> None:
        """Measured on testnet: /markets lists NDQ-USDX-PERP, /summary does not."""
        catalog = parse_catalog([
            {"market_id": "BTC-USDX-PERP", "tick_size": "0.5", "lot_size": "0.001",
             "min_order_size": "0.001", "max_leverage": 50},
            {"market_id": "NDQ-USDX-PERP", "tick_size": "0.25", "lot_size": "0.01",
             "min_order_size": "0.01", "max_leverage": 50},
        ])
        tickers = parse_tickers({
            "BTC-USDX-PERP": {"close": Decimal("10"), "quoteVolume": Decimal("1")},
            "NDQ-USDX-PERP": {"close": None, "quoteVolume": Decimal("0")},
        })
        merged = merge_market_sources(catalog, {"BTC-USDX-PERP": self.summary("BTC-USDX-PERP")}, tickers)

        self.assertEqual(sorted(merged), ["BTC-USDX-PERP", "NDQ-USDX-PERP"])
        ndq = merged["NDQ-USDX-PERP"]
        self.assertFalse(ndq.in_summary)
        self.assertEqual(ndq.status, "unknown")
        self.assertEqual([issue.code for issue in ndq.source_issues], ["missing_from_summary"])
        # Its rules still came from the catalog.
        self.assertEqual(ndq.rules.tick_size, Decimal("0.25"))
        self.assertEqual(merged["BTC-USDX-PERP"].source_issues, ())

    def test_a_market_only_the_summary_knows_is_flagged(self) -> None:
        merged = merge_market_sources({}, {"X-PERP": self.summary("X-PERP")}, {})
        issues = [issue.code for issue in merged["X-PERP"].source_issues]
        self.assertIn("missing_from_catalog", issues)
        self.assertIn("missing_from_tickers", issues)

    def test_null_is_not_zero(self) -> None:
        """`NDQ-USDX-PERP` reports a null close with a real high and low."""
        tickers = parse_tickers({"X": {"close": None, "high": Decimal("5"), "bid": None}})
        self.assertIsNone(tickers["X"].close)
        self.assertEqual(tickers["X"].high, Decimal("5"))
        self.assertFalse(tickers["X"].has_two_sided_book)

    def test_tickers_wrong_shape_yields_nothing(self) -> None:
        """That route is a map keyed by symbol; a list would iterate to nothing."""
        self.assertEqual(parse_tickers([{"symbol": "X"}]), {})

    def test_summary_skips_unrecognisable_rows(self) -> None:
        rows = parse_summaries([{"no_market_id": True}, "junk", {"market_id": "X", "status": "active"}])
        self.assertEqual(list(rows), ["X"])

    def test_venue_stats_tolerate_absent_fields(self) -> None:
        stats = parse_venue_stats({"health": "healthy", "fills_total": 3})
        self.assertEqual(stats.health, "healthy")
        self.assertEqual(stats.fills_total, 3)
        self.assertIsNone(stats.liquidations_total)
        self.assertEqual(parse_venue_stats("nope").health, "unknown")


class TestAnalysis(unittest.TestCase):
    def build(self) -> Any:
        rows = [
            [HOUR, Decimal("100"), Decimal("110"), Decimal("90"), Decimal("105"), Decimal("2")],
            [2 * HOUR, Decimal("105"), Decimal("120"), Decimal("100"), Decimal("115"), Decimal("3")],
        ]
        series = parse(
            rows, market="M", requested_timeframe="1h", limit=2, window_buckets=2, now_ms=NOW
        )
        snapshot = merge_market_sources(
            parse_catalog([{"market_id": "M"}]), {}, {}
        )["M"]
        return analyze_market(snapshot, None, series, parse_funding([], market="M"))

    def test_window_figures(self) -> None:
        analysis = self.build()
        self.assertEqual(analysis.window_open, Decimal("100"))
        self.assertEqual(analysis.window_high, Decimal("120"))
        self.assertEqual(analysis.window_low, Decimal("90"))
        self.assertEqual(analysis.window_close, Decimal("115"))
        self.assertEqual(analysis.window_base_volume, Decimal("5"))
        self.assertEqual(analysis.window_return, Decimal("0.15"))

    def test_vwap_is_volume_weighted(self) -> None:
        analysis = self.build()
        # (2 * (110+90+105)/3 + 3 * (120+100+115)/3) / 5
        expected = (
            Decimal(2) * (Decimal("110") + Decimal("90") + Decimal("105")) / 3
            + Decimal(3) * (Decimal("120") + Decimal("100") + Decimal("115")) / 3
        ) / Decimal(5)
        assert analysis.window_vwap is not None
        self.assertEqual(analysis.window_vwap, expected)

    def test_flags_a_mark_price_that_contradicts_the_traded_price(self) -> None:
        """Measured: NDQ-USDX-PERP marks at 717.5 and trades near 18,466."""
        rows = [
            [HOUR, Decimal("18000"), Decimal("18500"), Decimal("18000"), Decimal("18466"), Decimal("1")],
            [2 * HOUR, Decimal("18466"), Decimal("18500"), Decimal("18400"), Decimal("18466"), Decimal("1")],
        ]
        series = parse(rows, market="NDQ-USDX-PERP", requested_timeframe="1h", limit=2,
                       window_buckets=2, now_ms=NOW)
        tickers = parse_tickers({"NDQ-USDX-PERP": {"markPrice": Decimal("717.5")}})
        snapshot = merge_market_sources(
            parse_catalog([{"market_id": "NDQ-USDX-PERP"}]), {}, tickers
        )["NDQ-USDX-PERP"]
        analysis = analyze_market(snapshot, tickers["NDQ-USDX-PERP"], series, None)
        self.assertIn("price_sources_disagree", [issue.code for issue in analysis.issues])

    def test_agreeing_prices_are_not_flagged(self) -> None:
        rows = [
            [HOUR, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), Decimal("1")],
            [2 * HOUR, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("101"), Decimal("1")],
        ]
        series = parse(rows, market="M", requested_timeframe="1h", limit=2,
                       window_buckets=2, now_ms=NOW)
        tickers = parse_tickers({"M": {"markPrice": Decimal("100.5")}})
        snapshot = merge_market_sources(parse_catalog([{"market_id": "M"}]), {}, tickers)["M"]
        analysis = analyze_market(snapshot, tickers["M"], series, None)
        self.assertNotIn("price_sources_disagree", [issue.code for issue in analysis.issues])

    def test_an_unusable_series_produces_no_figures(self) -> None:
        snapshot = merge_market_sources(parse_catalog([{"market_id": "M"}]), {}, {})["M"]
        series = parse([], market="M", requested_timeframe="1h", limit=1,
                       window_buckets=1, now_ms=NOW)
        analysis = analyze_market(snapshot, None, series, None)
        self.assertFalse(analysis.has_series)
        self.assertIsNone(analysis.window_close)
        self.assertIsNone(analysis.volatility_annual)
        self.assertIn("no_candles", [issue.code for issue in analysis.issues])


class TestRendering(unittest.TestCase):
    def meta(self) -> render.ReportMeta:
        return render.ReportMeta(
            base_url="http://example.invalid", api_version="v0.8.1",
            generated_at="2026-08-20 00:00:00Z", window_label="24h", timeframe="1h",
            buckets_requested=25, requests_made=4, cache_hits=0, strict=False,
        )

    def test_display_rounds_and_csv_does_not(self) -> None:
        value = Decimal("1.23456789")
        self.assertEqual(render.fmt(value), "1.23")
        self.assertEqual(render.exact(value), "1.23456789")
        self.assertEqual(render.fmt(None), render.DASH)
        self.assertEqual(render.exact(None), "")

    def test_percentages(self) -> None:
        self.assertEqual(render.fmt_pct(Decimal("0.0775")), "7.75")
        self.assertEqual(render.fmt_pct(None), render.DASH)

    def test_sparkline_is_self_contained(self) -> None:
        svg = render.sparkline([Decimal(1), Decimal(5), Decimal(3)])
        self.assertIn("<polyline", svg)
        self.assertIn("currentColor", svg)
        self.assertNotIn("http", svg)
        self.assertEqual(render.sparkline([Decimal(1)]), "")

    def test_sparkline_handles_a_flat_series(self) -> None:
        svg = render.sparkline([Decimal(7), Decimal(7), Decimal(7)])
        self.assertIn("<polyline", svg)
        self.assertNotIn("nan", svg.lower())

    def test_html_escapes_wire_strings_and_loads_nothing(self) -> None:
        catalog = parse_catalog([{"market_id": "X-PERP"}])
        summaries = parse_summaries([
            {"market_id": "X-PERP", "status": "halted",
             "halt_reason": "<script>alert(1)</script>"}
        ])
        snapshot = merge_market_sources(catalog, summaries, {})["X-PERP"]
        analysis = analyze_market(snapshot, None, None, None)
        page = render.html_report(self.meta(), parse_venue_stats({}), [analysis], [1, 2, 3])

        self.assertNotIn("<script>", page)
        self.assertIn("&lt;script&gt;", page)
        # Self-contained: no external stylesheet, script or image.
        for marker in ("src=\"http", "href=\"http", "//cdn", "@import"):
            self.assertNotIn(marker, page)

    def test_csv_round_trips_at_full_precision(self) -> None:
        import csv as csv_module

        rows = [[HOUR, Decimal("100"), Decimal("101"), Decimal("99"),
                 Decimal("100.123456789"), Decimal("1")],
                [2 * HOUR, Decimal("100"), Decimal("101"), Decimal("99"),
                 Decimal("100.987654321"), Decimal("1")]]
        series = parse(rows, market="M", requested_timeframe="1h", limit=2,
                       window_buckets=2, now_ms=NOW)
        snapshot = merge_market_sources(parse_catalog([{"market_id": "M"}]), {}, {})["M"]
        analysis = analyze_market(snapshot, None, series, None)

        with TemporaryDirectory() as directory:
            path = Path(directory) / "report.csv"
            render.write_csv(path, [analysis])
            with path.open(newline="", encoding="utf-8") as handle:
                parsed = list(csv_module.DictReader(handle))
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["window_close"], "100.987654321")
        self.assertEqual(parsed[0]["market"], "M")

    def test_text_report_names_every_market(self) -> None:
        catalog = parse_catalog([{"market_id": "A-PERP"}, {"market_id": "B-PERP"}])
        merged = merge_market_sources(catalog, {}, {})
        analyses = [analyze_market(snapshot, None, None, None) for snapshot in merged.values()]
        text = render.text_report(self.meta(), parse_venue_stats({}), analyses)
        self.assertIn("A-PERP", text)
        self.assertIn("B-PERP", text)
        self.assertIn("data quality", text)


# ── the client, against a real socket ───────────────────────────────────────


class _Handler(BaseHTTPRequestHandler):
    routes: dict[str, Callable[[], tuple[int, str, bytes]]] = {}
    hits: dict[str, int] = {}

    def do_GET(self) -> None:  # noqa: N802 - the name http.server requires
        _Handler.hits[self.path] = _Handler.hits.get(self.path, 0) + 1
        handler = _Handler.routes.get(self.path)
        if handler is None:
            self.send_error(404, "no route")
            return
        status, content_type, body = handler()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if status in (301, 302, 307, 308):
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Silence the default stderr access log."""


class TestApiAgainstALocalServer(unittest.TestCase):
    server: ThreadingHTTPServer
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        _Handler.routes = {}
        _Handler.hits = {}
        # Only the port is read back: the bound host is the literal below, and
        # `server_address[0]` is typed as possibly-bytes, which is not worth
        # decoding to rebuild a string we already know.
        port = int(self.server.server_address[1])
        self.base = f"http://127.0.0.1:{port}"

    def client(self, **kwargs: Any) -> Api:
        kwargs.setdefault("timeout", 5.0)
        kwargs.setdefault("min_interval", 0.0)
        return Api(self.base, **kwargs)

    def test_json_arrives_as_decimal(self) -> None:
        _Handler.routes["/ok"] = lambda: (200, "application/json", b'{"price": 2303.3}')
        payload = self.client().get_json("/ok")
        self.assertIsInstance(payload["price"], Decimal)
        self.assertEqual(str(payload["price"]), "2303.3")

    def test_html_body_is_diagnosed_not_parsed(self) -> None:
        _Handler.routes["/html"] = lambda: (200, "text/html", b"<!doctype html><p>hi")
        with self.assertRaises(ApiError) as caught:
            self.client().get_json("/html")
        self.assertIn("not JSON", str(caught.exception))
        self.assertIn("gateway prefix", str(caught.exception))

    def test_html_error_body_is_diagnosed(self) -> None:
        _Handler.routes["/gone"] = lambda: (404, "text/html", b"<!DOCTYPE html><html>404")
        with self.assertRaises(ApiError) as caught:
            self.client(attempts=1).get_json("/gone")
        self.assertIn("HTML page rather than JSON", str(caught.exception))

    def test_redirects_are_refused(self) -> None:
        _Handler.routes["/moved"] = lambda: (302, "application/json", b"{}")
        with self.assertRaises(ApiError):
            self.client(attempts=1).get_json("/moved")
        # Refused, not followed: exactly one request was made.
        self.assertEqual(_Handler.hits.get("/moved"), 1)

    def test_server_errors_are_retried_and_client_errors_are_not(self) -> None:
        state = {"calls": 0}

        def flaky() -> tuple[int, str, bytes]:
            state["calls"] += 1
            if state["calls"] < 3:
                return 503, "application/json", b'{"error": "later"}'
            return 200, "application/json", b'{"ok": true}'

        _Handler.routes["/flaky"] = flaky
        _Handler.routes["/bad"] = lambda: (400, "application/json", b'{"error": "nope"}')

        payload = self.client(attempts=3).get_json("/flaky")
        self.assertEqual(payload, {"ok": True})
        self.assertEqual(state["calls"], 3)

        with self.assertRaises(ApiError):
            self.client(attempts=3).get_json("/bad")
        self.assertEqual(_Handler.hits.get("/bad"), 1)

    def test_oversized_bodies_are_refused(self) -> None:
        _Handler.routes["/big"] = lambda: (200, "application/json", b"[" + b"0," * 500 + b"0]")
        original = api.MAX_RESPONSE_BYTES
        api.MAX_RESPONSE_BYTES = 16
        try:
            with self.assertRaises(ApiError) as caught:
                self.client(attempts=1).get_json("/big")
            self.assertIn("more than", str(caught.exception))
        finally:
            api.MAX_RESPONSE_BYTES = original

    def test_the_cache_serves_the_second_read(self) -> None:
        _Handler.routes["/cached"] = lambda: (200, "application/json", b'{"n": 1}')
        with TemporaryDirectory() as directory:
            cache = Cache(Path(directory), ttl_seconds=60)
            client = self.client(cache=cache)
            self.assertEqual(client.get_json("/cached"), {"n": 1})
            self.assertEqual(client.get_json("/cached"), {"n": 1})
        self.assertEqual(_Handler.hits.get("/cached"), 1)
        self.assertEqual(client.cache_hits, 1)

    def test_an_expired_or_corrupt_cache_entry_is_ignored(self) -> None:
        _Handler.routes["/c"] = lambda: (200, "application/json", b'{"n": 2}')
        with TemporaryDirectory() as directory:
            expired = Cache(Path(directory), ttl_seconds=-1)
            client = self.client(cache=expired)
            client.get_json("/c")
            client.get_json("/c")
            self.assertEqual(_Handler.hits.get("/c"), 2)

            # A half-written file from an interrupted run must not be read as data.
            corrupt = Cache(Path(directory), ttl_seconds=60)
            key = client._cache_key(f"{self.base}/c")
            (Path(directory) / f"{key}.json").write_text('{"fetched_at": 0, "pay')
            self.assertIsNone(corrupt.get(key))

    def test_a_base_url_ending_in_api_v1_is_refused(self) -> None:
        with self.assertRaises(ApiError) as caught:
            Api("https://example.invalid/api/exchange/api/v1")
        self.assertIn("must not end in /api/v1", str(caught.exception))

    def test_query_parameters_reach_the_server(self) -> None:
        _Handler.routes["/q?timeframe=1h&limit=25"] = lambda: (
            200, "application/json", b"[]",
        )
        self.assertEqual(
            self.client().get_json("/q", {"timeframe": "1h", "limit": "25"}), []
        )


class TestEntryPointHelpers(unittest.TestCase):
    def test_window_parsing(self) -> None:
        import report

        self.assertEqual(report.parse_window("90m"), 90 * MINUTE)
        self.assertEqual(report.parse_window("24h"), 24 * HOUR)
        self.assertEqual(report.parse_window("7d"), 7 * 24 * HOUR)
        for bad in ("", "h", "0h", "-1h", "24x", "abc", "1.5h"):
            with self.assertRaises(Exception):
                report.parse_window(bad)

    def test_timeframe_choice_fits_the_cap(self) -> None:
        import report
        from series import CANDLE_LIMIT_CAP

        # A 24h window: 1m would need 1441 buckets, so 5m is the finest that fits.
        name, step, limit, needed = report.choose_timeframe(24 * HOUR)
        self.assertEqual(name, "5m")
        self.assertEqual(step, TIMEFRAMES["5m"])
        self.assertEqual(limit, needed)
        self.assertLessEqual(limit, CANDLE_LIMIT_CAP)

        # A short window gets the finest timeframe there is.
        self.assertEqual(report.choose_timeframe(2 * HOUR)[0], "1m")

        # Wider than 1h can reach: the limit is capped and `needed` records what
        # was actually wanted, so the truncation gets reported instead of hidden.
        name, _, limit, needed = report.choose_timeframe(365 * 24 * HOUR)
        self.assertEqual(name, "1h")
        self.assertEqual(limit, CANDLE_LIMIT_CAP)
        self.assertGreater(needed, CANDLE_LIMIT_CAP)

    def test_window_labels_read_like_the_flag(self) -> None:
        import report

        self.assertEqual(report._window_label(24 * HOUR), "24h")
        self.assertEqual(report._window_label(7 * 24 * HOUR), "7d")
        self.assertEqual(report._window_label(90 * MINUTE), "90m")

    def test_funding_limit_covers_the_window(self) -> None:
        import report

        self.assertGreaterEqual(report._funding_limit(24 * HOUR), 24)
        self.assertLessEqual(report._funding_limit(365 * 24 * HOUR), 1000)
        self.assertGreaterEqual(report._funding_limit(MINUTE), 2)


if __name__ == "__main__":
    unittest.main(buffer=True, verbosity=2)
