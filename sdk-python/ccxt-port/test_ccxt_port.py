"""Tests for ccxt-port. No network, no credentials.

Two kinds, and the split is deliberate.

The pure tests cover the arithmetic and the classification, which is most of
what could be wrong in this app's own code.

The rest run the **real adapter and the real SDK against a real HTTP server on
the loopback interface**, rather than against a mock. A mock of an SDK only ever
proves that the mock matches the test author's idea of it; a socket proves that
the adapter composes the URL, decodes the body and flattens the fields the way
this example claims it does. Every README claim about adapter behaviour —
``/markets`` not being under ``/api/v1``, the ``load_markets`` cache, floats
truncating a decimal string, ``since`` filtering after the fetch, the lower-cased
trade side, the timeframe the native client forwards and the adapter refuses —
is pinned by a test here, so a version bump that changes one fails the gate
instead of quietly making the README wrong.

CI runs these: the Python recipe ends with `unittest discover`.
"""

from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import ccxt_path
import native_path
import parity
import render
import scan as scan_app
import surface
import target
from nexus_exchange import Client, Funds, NetworkConfig
from nexus_exchange.ccxt_adapter import NexusExchange

# --------------------------------------------------------------------------
# Fixtures shaped like the live venue, including the parts that are awkward.
# --------------------------------------------------------------------------

MARKET = {
    "market_id": "BTC-USDX-PERP",
    "base_asset": "BTC",
    "quote_asset": "USDX",
    "tick_size": "0.5",
    "lot_size": "0.001",
    "min_order_size": "0.001",
    "max_order_size": "100",
    "initial_margin_rate": "0.05",
    "maintenance_margin_rate": "0.03",
    "max_leverage": 20,
}

#: `markPrice` carries more digits than an f64 holds, which is the case the
#: parity report exists to catch. `change` is a JSON double with a float
#: artefact the live venue really does emit (see analytics/market-report).
TICKER: dict[str, Any] = {
    "symbol": "BTC-USDX-PERP",
    "timestamp": 1787195400000,
    "datetime": "2026-08-20T03:10:00Z",
    "high": 70090.0,
    "low": 64079.0,
    "bid": 69062.5,
    "bidVolume": 1.5,
    "ask": 69063.5,
    "askVolume": 2.0,
    "open": 64200.0,
    "close": 69063.0,
    "last": "69063.00000000000000001",
    "change": 391.2000000000003,
    "percentage": 7.57,
    "baseVolume": 40.137,
    "quoteVolume": 2700000.10,
    "markPrice": 69063.0,
    "indexPrice": 69064.0,
}

BOOK: dict[str, Any] = {
    "symbol": "BTC-USDX-PERP",
    "timestamp": 1787195400000,
    "datetime": "2026-08-20T03:10:00Z",
    "nonce": 7,
    "bids": [["69062.5", "1.5"], ["69062.0", "2.0"], ["69000.0", "9.0"]],
    "asks": [["69063.5", "2.0"], ["69064.0", "1.0"], ["69500.0", "8.0"]],
}

#: A `timestamp == 0` leading row, as the 5m and 1h series really arrive, and a
#: final bucket that is still forming.
CANDLES: list[list[Any]] = [
    [0, 1.0, 1.0, 1.0, 1.0, 0.0],
    [1787100000000, 64200.0, 64300.0, 64100.0, 64250.0, 10.0],
    [1787103600000, 64250.0, 65000.0, 64200.0, 64900.0, 12.0],
    [1787107200000, 64900.0, 66000.0, 64800.0, 65500.0, 21.0],
    [1787110800000, 65500.0, 69100.0, 65400.0, 69063.0, 31.0],
    [1787114400000, 69063.0, 69100.0, 69000.0, 69050.0, 3.0],
]

#: Newest first, as the adapter documents, and with an upper-case `side` — which
#: the adapter lower-cases and `Trade.from_dict` does not.
TRADES: list[dict[str, Any]] = [
    {"id": "3", "timestamp": 1787114000000, "datetime": "c", "symbol": "BTC-USDX-PERP",
     "side": "BUY", "price": "69063.0", "amount": "0.5", "cost": "34531.5",
     "takerOrMaker": "taker", "is_liquidation": True},
    {"id": "2", "timestamp": 1787110000000, "datetime": "b", "symbol": "BTC-USDX-PERP",
     "side": "SELL", "price": "69062.0", "amount": "0.25", "cost": "17265.5",
     "takerOrMaker": "taker", "is_liquidation": False},
    {"id": "1", "timestamp": 1787100000000, "datetime": "a", "symbol": "BTC-USDX-PERP",
     "side": "BUY", "price": "64200.0", "amount": "1.25", "cost": "80250.0",
     "takerOrMaker": "maker", "is_liquidation": False},
]

SYMBOL = "BTC-USDX-PERP"


class _Venue:
    """A throwaway HTTP server standing in for the deployment."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        #: Set to make the *second* candle fetch return a different series, so
        #: the two halves genuinely disagree — the venue moving between calls.
        self.drift_candles = False
        self._candle_calls = 0
        venue = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
                venue.paths.append(self.path)
                route = self.path.split("?")[0]
                query = self.path.partition("?")[2]
                body = venue.route(route, query)
                if body is None:
                    self.send_response(404)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"code":"not_found"}')
                    return
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def route(self, path: str, query: str) -> Any:
        if path == "/markets":
            return [MARKET]
        if path == "/api/v1/tickers":
            return {SYMBOL: TICKER}
        if path == f"/api/v1/markets/{SYMBOL}/ticker":
            return TICKER
        if path == f"/api/v1/markets/{SYMBOL}/orderbook":
            return BOOK
        if path == f"/api/v1/markets/{SYMBOL}/candles":
            # The venue substitutes the 1m series for an unsupported timeframe
            # and says nothing — the behaviour `native_path.check_timeframe`
            # exists for. Modelled here so the test is about the real hazard.
            self._candle_calls += 1
            if self.drift_candles and self._candle_calls > 1:
                # One close moved, not a uniform scale: returns are ratios, so
                # scaling the whole series leaves every return — and therefore
                # the volatility — untouched. Only a change of *shape* is a
                # disagreement the parity report should catch.
                moved = [list(row) for row in CANDLES]
                moved[3][4] = 61000.0
                return moved
            return CANDLES
        if path == f"/api/v1/markets/{SYMBOL}/trades":
            return TRADES
        return None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def config(self) -> NetworkConfig:
        return NetworkConfig.custom(
            label="loopback", funds=Funds.PLAY, base_url=self.base_url
        )

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class VenueTestCase(unittest.TestCase):
    """Base class owning one loopback venue and one shared client."""

    def setUp(self) -> None:
        self.venue = _Venue()
        self.client = Client(self.venue.config(), timeout=5.0)
        self.exchange = NexusExchange(client=self.client)
        self.addCleanup(self.venue.close)
        self.addCleanup(self.client.close)


# --------------------------------------------------------------------------
# Pure: coercion and arithmetic
# --------------------------------------------------------------------------


class AsFloatTests(unittest.TestCase):
    def test_accepts_numbers(self) -> None:
        self.assertEqual(ccxt_path.as_float(1), 1.0)
        self.assertEqual(ccxt_path.as_float(1.5), 1.5)

    def test_rejects_bool_before_int(self) -> None:
        # `isinstance(True, int)` is True, so without the explicit check a flag
        # would become the price 1.0 — a plausible number instead of an error.
        self.assertIsNone(ccxt_path.as_float(True))
        self.assertIsNone(ccxt_path.as_float(False))

    def test_rejects_strings_and_none(self) -> None:
        self.assertIsNone(ccxt_path.as_float("1.5"))
        self.assertIsNone(ccxt_path.as_float(None))
        self.assertIsNone(ccxt_path.as_float({}))

    def test_rejects_non_finite(self) -> None:
        self.assertIsNone(ccxt_path.as_float(float("nan")))
        self.assertIsNone(ccxt_path.as_float(float("inf")))


class CandleHygieneTests(unittest.TestCase):
    def test_drops_zero_timestamp_row_and_forming_bucket(self) -> None:
        closes, notes = ccxt_path._closes([[float(v) for v in row] for row in CANDLES])
        # Six rows in: one at ts 0, one still forming, four usable.
        self.assertEqual(len(closes), 4)
        self.assertEqual(closes[0], 64250.0)
        self.assertEqual(closes[-1], 69063.0)
        self.assertTrue(any("non-positive timestamp" in note for note in notes))
        self.assertTrue(any("still forming" in note for note in notes))

    def test_both_paths_drop_the_same_candles(self) -> None:
        from nexus_exchange import Ohlcv

        floats, _ = ccxt_path._closes([[float(v) for v in row] for row in CANDLES])
        decimals, _ = native_path._closes([Ohlcv.from_row(row) for row in CANDLES])
        self.assertEqual(len(floats), len(decimals))
        self.assertEqual([Decimal(str(c)) for c in floats], list(decimals))

    def test_sorts_before_dropping_the_forming_bucket(self) -> None:
        shuffled = [CANDLES[4], CANDLES[1], CANDLES[5], CANDLES[2], CANDLES[3]]
        closes, _ = ccxt_path._closes([[float(v) for v in row] for row in shuffled])
        # The newest row (69050.0) is the one dropped, whatever order it arrived in.
        self.assertNotIn(69050.0, closes)
        self.assertEqual(closes[-1], 69063.0)


class VolatilityTests(unittest.TestCase):
    def test_none_below_three_closes(self) -> None:
        self.assertIsNone(ccxt_path.realized_vol_pct([1.0, 2.0], 60_000))
        self.assertIsNone(native_path.realized_vol_pct([Decimal(1), Decimal(2)], 60_000))

    def test_float_and_decimal_agree_to_well_inside_the_tolerance(self) -> None:
        closes = [100.0, 101.0, 99.5, 102.25, 103.0]
        as_float = ccxt_path.realized_vol_pct(closes, 300_000)
        as_decimal = native_path.realized_vol_pct(
            [Decimal(str(c)) for c in closes], 300_000
        )
        assert as_float is not None and as_decimal is not None
        relative = abs(Decimal(str(as_float)) - as_decimal) / as_decimal
        self.assertLess(relative, Decimal("1e-13"))

    def test_zero_step_is_refused(self) -> None:
        self.assertIsNone(ccxt_path.realized_vol_pct([1.0, 2.0, 3.0, 4.0], 0))


class BookTests(unittest.TestCase):
    def test_crossed_book_yields_no_figures(self) -> None:
        crossed = {"bids": [[100.0, 1.0]], "asks": [[99.0, 1.0]]}
        spread, depth, notes = ccxt_path._book_figures(crossed, 10.0)
        self.assertIsNone(spread)
        self.assertIsNone(depth)
        self.assertTrue(any("crossed" in note for note in notes))

    def test_best_level_is_not_taken_by_index(self) -> None:
        # Bids out of order on purpose: an ordering assumption would take 69000
        # as the best bid and report a spread twenty times too wide.
        out_of_order = {
            "bids": [[69000.0, 1.0], [69062.5, 1.0]],
            "asks": [[69063.5, 1.0], [69500.0, 1.0]],
        }
        spread, _, _ = ccxt_path._book_figures(out_of_order, 10.0)
        assert spread is not None
        self.assertLess(spread, 1.0)


class FlowTests(unittest.TestCase):
    def test_native_lowercases_the_side_the_sdk_leaves_raw(self) -> None:
        # `Trade.from_dict` keeps `side=str(d["side"])`, so the venue's "BUY"
        # stays upper-case; the adapter lower-cases it. A native port that
        # compared against "buy" would count every trade as an unknown side.
        from nexus_exchange import Trade

        trades = [Trade.from_dict(t) for t in TRADES]
        self.assertEqual([t.side for t in trades], ["BUY", "SELL", "BUY"])
        share, used, liquidations, notes = native_path._flow(trades)
        self.assertEqual(used, 3)
        self.assertEqual(notes, [])
        self.assertEqual(liquidations, 1)
        assert share is not None
        self.assertEqual(share, Decimal("1.75") / Decimal("2.0"))

    def test_unrecognised_side_is_skipped_and_counted(self) -> None:
        share, used, notes = ccxt_path._flow(
            [{"side": "sideways", "amount": 1.0}, {"side": "buy", "amount": 3.0}]
        )
        self.assertEqual(used, 1)
        self.assertEqual(share, 1.0)
        self.assertTrue(any("unrecognised side" in note for note in notes))


# --------------------------------------------------------------------------
# Pure: the parity classification
# --------------------------------------------------------------------------


class ClassifyTests(unittest.TestCase):
    TOL = parity.DEFAULT_TOLERANCE

    def test_exact_when_the_float_names_the_decimal(self) -> None:
        verdict, delta, _ = parity.classify(0.5, Decimal("0.5"), self.TOL)
        self.assertIs(verdict, parity.Verdict.EXACT)
        self.assertEqual(delta, 0)

    def test_rounded_when_the_venue_sent_more_digits_than_a_double_holds(self) -> None:
        native = Decimal("69063.00000000000000001")
        verdict, delta, detail = parity.classify(float(native), native, self.TOL)
        self.assertIs(verdict, parity.Verdict.ROUNDED)
        self.assertEqual(detail, "digits lost to the float")
        assert delta is not None
        self.assertGreater(delta, 0)

    def test_rounded_when_arithmetic_accumulated_binary_error(self) -> None:
        native = Decimal("1.0000000000000000001")
        verdict, _, detail = parity.classify(1.0 + 1e-17, native, self.TOL)
        self.assertIs(verdict, parity.Verdict.ROUNDED)

    def test_differs_beyond_the_tolerance(self) -> None:
        verdict, delta, detail = parity.classify(1.0, Decimal("1.1"), self.TOL)
        self.assertIs(verdict, parity.Verdict.DIFFERS)
        self.assertEqual(delta, Decimal("0.1"))
        self.assertEqual(detail, "beyond what rounding explains")

    def test_absent_only_when_neither_side_has_a_figure(self) -> None:
        verdict, _, _ = parity.classify(None, None, self.TOL)
        self.assertIs(verdict, parity.Verdict.ABSENT)

    def test_one_sided_is_a_difference_not_an_absence(self) -> None:
        # An absence that padded the agreement rate would make the report say
        # "100% exact" about a scan where half the fields never arrived.
        for pair in ((None, Decimal("1")), (1.0, None)):
            verdict, _, _ = parity.classify(pair[0], pair[1], self.TOL)
            self.assertIs(verdict, parity.Verdict.DIFFERS)

    def test_summary_worst_prefers_differs(self) -> None:
        rows = [
            parity.Row("m", "f", 1.0, Decimal(1), parity.Verdict.EXACT, Decimal(0)),
            parity.Row("m", "g", 1.0, Decimal(2), parity.Verdict.DIFFERS, Decimal(1)),
        ]
        summary = parity.summarise(rows)
        self.assertIs(summary.worst, parity.Verdict.DIFFERS)
        self.assertEqual(summary.compared, 2)


# --------------------------------------------------------------------------
# Pure: target resolution
# --------------------------------------------------------------------------


class TargetTests(unittest.TestCase):
    def test_default_is_the_durable_testnet_base_and_play_funds(self) -> None:
        resolved = target.resolve(None, {})
        self.assertEqual(resolved.base_url, target.DEFAULT_BASE_URL)
        self.assertIs(resolved.funds, Funds.PLAY)
        self.assertFalse(resolved.overridden)
        self.assertIn("play funds", resolved.banner())

    def test_default_is_not_the_decommissioned_gateway(self) -> None:
        # `Network.TESTNET` resolves to https://exchange.nexus.xyz/api/exchange,
        # which answers 500 on every route. An example that used it would not
        # run, so this pins the choice rather than leaving it to a comment.
        self.assertNotIn("exchange.nexus.xyz", target.DEFAULT_BASE_URL)
        self.assertTrue(target.DEFAULT_BASE_URL.endswith("/indexer"))

    def test_override_is_funds_unknown(self) -> None:
        resolved = target.resolve(None, {"NEXUS_EXCHANGE_API_URL": "https://host/base"})
        self.assertTrue(resolved.overridden)
        self.assertIs(resolved.funds, Funds.UNKNOWN)
        self.assertIn("funds not declared", resolved.banner())
        self.assertIn("NEXUS_EXCHANGE_API_URL", resolved.banner())

    def test_flag_beats_the_environment(self) -> None:
        resolved = target.resolve(
            "https://flag/base", {"NEXUS_EXCHANGE_API_URL": "https://env/base"}
        )
        self.assertEqual(resolved.base_url, "https://flag/base")

    def test_api_v1_suffix_is_refused(self) -> None:
        with self.assertRaises(target.TargetError) as caught:
            target.resolve("https://host/base/api/v1", {})
        self.assertIn("/api/v1", str(caught.exception))

    def test_blank_environment_variable_falls_back_to_the_default(self) -> None:
        # `_template/.env.example` ships this variable blank, so `set -a; .
        # ./.env` exports "" on a machine that never customised it. Refusing to
        # start there would make the repo's own documented setup an error.
        for blank in ("", "   "):
            resolved = target.resolve(None, {"NEXUS_EXCHANGE_API_URL": blank})
            self.assertEqual(resolved.base_url, target.DEFAULT_BASE_URL)
            self.assertIs(resolved.funds, Funds.PLAY)

    def test_empty_flag_is_refused(self) -> None:
        # Typed, unlike an exported blank, so it is a mistake rather than a
        # default.
        with self.assertRaises(target.TargetError):
            target.resolve("   ", {})

    def test_malformed_url_fails_before_any_request(self) -> None:
        with self.assertRaises(target.TargetError):
            target.resolve("ftp://host/base", {})

    def test_userinfo_is_refused_by_the_sdk_through_us(self) -> None:
        with self.assertRaises(target.TargetError):
            target.resolve("https://real.example@evil.example/base", {})

    def test_trailing_slash_is_normalised(self) -> None:
        self.assertEqual(target.resolve("https://host/base/", {}).base_url, "https://host/base")


# --------------------------------------------------------------------------
# Against the real adapter, over a real socket
# --------------------------------------------------------------------------


class AdapterContractTests(VenueTestCase):
    def test_markets_is_not_under_api_v1(self) -> None:
        # The market catalog is the one route not migrated to /api/v1. A port
        # that assumes a uniform prefix 404s on the first call.
        self.exchange.load_markets()
        self.assertIn("/markets", self.venue.paths)
        self.assertNotIn("/api/v1/markets", self.venue.paths)

    def test_load_markets_caches_until_reloaded(self) -> None:
        self.exchange.load_markets()
        before = len(self.venue.paths)
        self.exchange.load_markets()
        self.assertEqual(len(self.venue.paths), before, "a cache hit made a request")
        self.exchange.load_markets(reload=True)
        self.assertEqual(len(self.venue.paths), before + 1)

    def test_unified_market_has_no_margin_rates_and_a_tick_size_in_precision(self) -> None:
        market = self.exchange.load_markets()[SYMBOL]
        self.assertNotIn("maintenance_margin_rate", market)
        self.assertIn("maintenance_margin_rate", market["info"])
        # CCXT's `precision` is a digit count under the default precision mode;
        # this is a tick *size*, and `describe()` advertises no precisionMode.
        self.assertEqual(market["precision"]["price"], 0.5)
        self.assertNotIn("precisionMode", self.exchange.describe())

    def test_floats_truncate_a_decimal_string_the_native_path_keeps(self) -> None:
        unified = self.exchange.fetch_ticker(SYMBOL)
        native = self.client.fetch_ticker(SYMBOL)
        self.assertEqual(unified["last"], 69063.0)
        self.assertEqual(native.last, Decimal("69063.00000000000000001"))
        self.assertNotEqual(Decimal(str(unified["last"])), native.last)

    def test_json_doubles_survive_intact_on_both_paths(self) -> None:
        unified = self.exchange.fetch_ticker(SYMBOL)
        native = self.client.fetch_ticker(SYMBOL)
        # `to_decimal` goes through `str`, so a double becomes the decimal text
        # that arrived — which is why most fields come back `exact`.
        self.assertEqual(Decimal(str(unified["change"])), native.change)

    def test_order_book_levels_are_positional_pairs(self) -> None:
        unified = self.exchange.fetch_order_book(SYMBOL)
        native = self.client.fetch_order_book(SYMBOL)
        self.assertEqual(unified["bids"][0], [69062.5, 1.5])
        self.assertEqual(native.bids[0].price, Decimal("69062.5"))
        self.assertEqual(native.bids[0].amount, Decimal("1.5"))

    def test_limit_truncates_the_book_client_side(self) -> None:
        before = len(self.venue.paths)
        book = self.exchange.fetch_order_book(SYMBOL, limit=1)
        self.assertEqual(len(book["bids"]), 1)
        # One request, and no `limit` on the wire: the endpoint returns a full
        # snapshot and the adapter slices it.
        self.assertEqual(len(self.venue.paths), before + 1)
        self.assertNotIn("limit", self.venue.paths[-1])

    def test_candles_are_positional_rows_with_the_zero_timestamp_passed_through(self) -> None:
        rows = self.exchange.fetch_ohlcv(SYMBOL, "1h", limit=10)
        self.assertEqual(len(rows), len(CANDLES))
        self.assertEqual(rows[0][0], 0)  # not filtered by the adapter

    def test_adapter_refuses_a_timeframe_the_native_client_forwards(self) -> None:
        # The headline case where the unified layer is the *safer* of the two.
        for unsupported in ("1d", "4h", "15m", ""):
            with self.assertRaises(ValueError):
                self.exchange.fetch_ohlcv(SYMBOL, unsupported)
            with self.assertRaises(ValueError):
                native_path.check_timeframe(unsupported)
        # Without that guard the native client sends it and the venue answers
        # with a series anyway — no error, nothing saying it substituted.
        forwarded = self.client.fetch_ohlcv(SYMBOL, "1d", limit=10)
        self.assertTrue(forwarded)

    def test_since_is_filtered_after_the_fetch_not_on_the_wire(self) -> None:
        rows = self.exchange.fetch_ohlcv(
            SYMBOL, "1h", since=1787110800000, limit=10
        )
        self.assertEqual([int(row[0]) for row in rows], [1787110800000, 1787114400000])
        self.assertNotIn("since", self.venue.paths[-1])

    def test_trade_side_is_lowercased_by_the_adapter_only(self) -> None:
        unified = self.exchange.fetch_trades(SYMBOL)
        native = self.client.fetch_trades(SYMBOL)
        self.assertEqual([t["side"] for t in unified], ["buy", "sell", "buy"])
        self.assertEqual([t.side for t in native], ["BUY", "SELL", "BUY"])

    def test_liquidation_flag_survives_only_in_info(self) -> None:
        unified = self.exchange.fetch_trades(SYMBOL)
        self.assertNotIn("is_liquidation", unified[0])
        self.assertTrue(unified[0]["info"]["is_liquidation"])
        self.assertTrue(self.client.fetch_trades(SYMBOL)[0].is_liquidation)

    def test_trades_arrive_newest_first_against_ccxt_convention(self) -> None:
        stamps = [t["timestamp"] for t in self.exchange.fetch_trades(SYMBOL)]
        self.assertEqual(stamps, sorted(stamps, reverse=True))

    def test_adapter_exposes_no_target(self) -> None:
        # Why `target.py` exists: there is no public way to ask the adapter what
        # it connected to. The `Client` is there, under a private name, and
        # reaching for it would be reaching into the SDK's internals.
        public = sorted(name for name in vars(self.exchange) if not name.startswith("_"))
        self.assertEqual(public, ["markets", "symbols"])
        self.assertFalse(hasattr(self.exchange, "network"))
        self.assertFalse(hasattr(self.exchange, "urls"))

    def test_close_does_not_close_a_borrowed_client(self) -> None:
        self.exchange.close()
        # Still usable: the adapter did not own this transport.
        self.assertTrue(self.client.fetch_markets())


class SurfaceTests(VenueTestCase):
    def test_describe_and_hasattr_agree(self) -> None:
        entries = surface.probe(self.exchange)
        self.assertEqual(surface.inconsistencies(entries), [])

    def test_every_private_method_is_absent_and_advertised_false(self) -> None:
        entries = {e.ccxt_name: e for e in surface.probe(self.exchange)}
        for name in (
            "fetchBalance", "fetchPositions", "createOrder", "cancelOrder",
            "fetchMyTrades", "fetchOrders", "fetchOpenOrders",
        ):
            entry = entries[name]
            self.assertIs(entry.support, surface.Support.FOLLOW_UP, name)
            self.assertFalse(entry.advertised, name)
            self.assertFalse(entry.defined, name)
            self.assertIn("AttributeError", entry.note)

    def test_every_market_data_method_is_covered(self) -> None:
        entries = {e.ccxt_name: e for e in surface.probe(self.exchange)}
        for name in (
            "fetchMarkets", "fetchTicker", "fetchTickers", "fetchOrderBook",
            "fetchOHLCV", "fetchTrades",
        ):
            self.assertIs(entries[name].support, surface.Support.COVERED, name)

    def test_ccxt_attributes_the_facade_lacks(self) -> None:
        # `exchange.has["fetchOHLCV"]` is the standard CCXT capability check and
        # it raises here. This is the list the README's porting table mirrors.
        for name, _ in surface.MISSING_ATTRIBUTES:
            attribute = name.split("(")[0]
            self.assertFalse(
                hasattr(self.exchange, attribute),
                f"{attribute} exists now — update MISSING_ATTRIBUTES and the README",
            )

    def test_table_names_the_no_subclassing_fact(self) -> None:
        text = surface.table(surface.probe(self.exchange))
        self.assertIn("without importing ccxt", text)
        self.assertIn("ccxt.Exchange", text)


class ScanParityTests(VenueTestCase):
    def _both(self) -> tuple[list[ccxt_path.Scan], list[native_path.NativeScan]]:
        unified = ccxt_path.scan(self.exchange, [SYMBOL], "1h", 200, 200, 10.0)
        markets = {m.market_id: m for m in self.client.fetch_markets()}
        native = native_path.scan(
            self.client, [SYMBOL], markets, "1h", 200, 200, Decimal("10")
        )
        return unified, native

    def test_the_two_paths_agree_on_everything_a_double_can_hold(self) -> None:
        unified, native = self._both()
        rows = parity.compare(unified, native)
        by_field = {row.field: row for row in rows}
        self.assertEqual(
            by_field["last"].verdict, parity.Verdict.ROUNDED,
            "the ticker's `last` carries more digits than an f64 holds",
        )
        for field in ("change%", "tick_size"):
            self.assertIs(by_field[field].verdict, parity.Verdict.EXACT, field)
        for field in ("spread_bps", "depth_quote", "rvol%", "taker_buy"):
            self.assertIn(
                by_field[field].verdict,
                (parity.Verdict.EXACT, parity.Verdict.ROUNDED),
                f"{field} should not differ beyond rounding: {by_field[field]}",
            )
        self.assertEqual(parity.summarise(rows).differs, 0)

    def test_gaps_name_the_three_things_the_unified_layer_cannot_carry(self) -> None:
        _, native = self._both()
        fields = {gap.field for gap in parity.gaps(native)}
        self.assertEqual(
            fields, {"maintenance_margin_rate", "liquidation trades", "exact tick size"}
        )
        for gap in parity.gaps(native):
            self.assertTrue(gap.escape_hatch, "a gap with no escape hatch is not actionable")

    def test_both_paths_use_the_same_number_of_requests(self) -> None:
        self.exchange.load_markets()  # warm the cache, as a run does
        before = len(self.venue.paths)
        ccxt_path.scan(self.exchange, [SYMBOL], "1h", 50, 50, 10.0)
        unified_requests = len(self.venue.paths) - before
        markets = {m.market_id: m for m in self.client.fetch_markets()}
        before = len(self.venue.paths)
        native_path.scan(self.client, [SYMBOL], markets, "1h", 50, 50, Decimal("10"))
        self.assertEqual(len(self.venue.paths) - before, unified_requests)

    def test_a_venue_that_moves_between_the_two_scans_reports_differs(self) -> None:
        # The verdict that matters. If the candle series changes under the two
        # halves, rvol% must be reported as a real disagreement rather than
        # absorbed as rounding.
        self.venue.drift_candles = True
        unified, native = self._both()
        rows = {row.field: row for row in parity.compare(unified, native)}
        self.assertIs(rows["rvol%"].verdict, parity.Verdict.DIFFERS)
        self.assertIs(parity.summarise(list(rows.values())).worst, parity.Verdict.DIFFERS)


class RenderTests(unittest.TestCase):
    def test_number_quantizes_without_touching_the_compared_value(self) -> None:
        self.assertEqual(render.number(Decimal("1.23456"), 2), "1.23")
        self.assertEqual(render.number(None), "—")
        self.assertEqual(render.number(0.1, 4), "0.1000")

    def test_parity_summary_counts_absent_separately(self) -> None:
        summary = parity.Summary(exact=2, rounded=1, differs=0, absent=5)
        text = render.parity_summary(summary)
        self.assertIn("3 field(s) compared", text)
        self.assertIn("5 absent", text)

    def test_empty_comparison_says_so(self) -> None:
        text = render.parity_summary(parity.Summary(0, 0, 0, 4))
        self.assertIn("nothing to compare", text)

    def test_long_decimals_are_elided_visibly(self) -> None:
        row = parity.Row(
            "M", "rvol%", 1.0, Decimal("1." + "2" * 60),
            parity.Verdict.ROUNDED, Decimal("1e-30"),
        )
        text = render.parity_table([row])
        self.assertIn("…", text, "a truncated number must show that it was truncated")
        self.assertIn("1.000E-30", text, "the delta must survive the elision")

    def test_gaps_state_the_escape_hatch_once_per_field(self) -> None:
        gaps = [
            parity.Gap("A", "tick", "0.5", 'market["info"]["tick_size"]'),
            parity.Gap("B", "tick", "0.05", 'market["info"]["tick_size"]'),
        ]
        text = render.gaps_block(gaps)
        self.assertEqual(text.count('market["info"]["tick_size"]'), 1)
        self.assertIn("A 0.5", text)
        self.assertIn("B 0.05", text)

    def test_a_note_every_market_shares_is_printed_once(self) -> None:
        shared = "dropped the newest candle: still forming"
        only_one = "empty book side — no spread or depth"
        ccxt_scans = [
            ccxt_path.Scan("A", None, None, None, None, None, None, 0, 0, None, [shared]),
            ccxt_path.Scan(
                "B", None, None, None, None, None, None, 0, 0, None, [shared, only_one]
            ),
        ]
        text = render.notes_block(ccxt_scans, [])
        self.assertEqual(text.count(shared), 1)
        self.assertIn("every market", text)
        self.assertIn(only_one, text)
        self.assertIn("  B", text)

    def test_no_notes_renders_nothing(self) -> None:
        scans = [ccxt_path.Scan("A", None, None, None, None, None, None, 0, 0, None, [])]
        self.assertEqual(render.notes_block(scans, []), "")


class EndToEndTests(VenueTestCase):
    def _argv(self, *extra: str) -> list[str]:
        return ["--base-url", self.venue.base_url, "--timeframe", "1h", *extra]

    def _run(self, *extra: str) -> tuple[int, str]:
        """`main`, with its report captured rather than printed into the suite."""
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = scan_app.main(self._argv(*extra))
        return code, out.getvalue() + err.getvalue()

    def test_runs_clean_against_the_loopback_venue(self) -> None:
        code, output = self._run()
        self.assertEqual(code, scan_app.EX_OK)
        self.assertIn("parity:", output)
        self.assertIn("what the unified layer does not carry", output)

    def test_banner_names_the_target_and_refuses_to_claim_play_funds(self) -> None:
        # The override is `--base-url`, which declares nothing about the host.
        _, output = self._run()
        self.assertIn(self.venue.base_url, output)
        self.assertIn("funds not declared", output)
        self.assertIn("--base-url", output)
        self.assertNotIn("play funds", output)

    def test_banner_says_the_surface_is_market_data_only(self) -> None:
        _, output = self._run()
        self.assertIn("market data only", output)

    def test_strict_passes_when_only_rounding_separates_the_paths(self) -> None:
        self.assertEqual(self._run("--strict")[0], scan_app.EX_OK)

    def test_strict_fails_when_the_paths_genuinely_disagree(self) -> None:
        self.venue.drift_candles = True
        code, output = self._run("--strict")
        self.assertEqual(code, scan_app.EX_PARITY)
        self.assertIn("more than rounding explains", output)

    def test_surface_exits_clean_without_scanning(self) -> None:
        before = len(self.venue.paths)
        code, output = self._run("--surface")
        self.assertEqual(code, scan_app.EX_OK)
        # `describe()` is local, so printing the surface costs no request.
        self.assertEqual(len(self.venue.paths), before)
        self.assertIn("not implemented", output)

    def test_unknown_market_is_refused_with_the_real_list(self) -> None:
        code, output = self._run("--markets", "NOPE-PERP")
        self.assertEqual(code, scan_app.EX_USAGE)
        self.assertIn(SYMBOL, output)

    def test_single_path_runs_skip_the_parity_report(self) -> None:
        for via in ("ccxt", "native"):
            code, output = self._run("--via", via)
            self.assertEqual(code, scan_app.EX_OK, via)
            self.assertNotIn("parity:", output)

    def test_out_of_range_limits_are_refused(self) -> None:
        self.assertEqual(self._run("--candles", "0")[0], scan_app.EX_USAGE)
        self.assertEqual(self._run("--trades", "5000")[0], scan_app.EX_USAGE)

    def test_bad_flag_exits_usage_not_host(self) -> None:
        # argparse exits 2 by default, and 2 means "the venue could not be read".
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                scan_app.main(["--no-such-flag"])
        self.assertEqual(caught.exception.code, scan_app.EX_USAGE)

    def test_unreachable_host_exits_host(self) -> None:
        self.venue.close()
        self.assertEqual(self._run()[0], scan_app.EX_HOST)


if __name__ == "__main__":
    unittest.main()
