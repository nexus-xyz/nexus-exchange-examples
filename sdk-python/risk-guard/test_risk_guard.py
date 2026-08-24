"""Offline tests. No network, no credentials, no live venue.

Two kinds here, and the split is deliberate.

`risk.py` is pure, so most of this is table-driven: build positions, evaluate,
assert the outcome. That is where the decisions that matter live, and they are
cheap to pin exhaustively.

The rest runs the real `nexus_exchange.Client` against a **real HTTP server on
the loopback interface** rather than a mock. A mock of an SDK proves the mock
matches the test's idea of it; a socket proves the SDK composes the URL, signs
the request and decodes the body the way this app assumes. Both of the SDK traps
this example documents were found that way and are pinned below, so a version
bump that changes either one fails here instead of in production.

Run with:  python -m unittest -q
"""

from __future__ import annotations

import json
import os
import signal
import threading
import unittest
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import config
import guard
import risk
from config import ConfigError, HelpRequested, Limits
from risk import State


def position(
    market: str = "BTC-USDX-PERP",
    *,
    size: str = "1",
    notional: str | None = "100",
    notional_error: str | None = None,
    pnl: str = "0",
) -> Any:
    """A `Position` built the way the SDK builds one: through `from_dict`.

    Decoded from a payload rather than constructed field-by-field, so a field
    this app reads cannot silently be renamed upstream without these tests
    noticing -- and so the fixtures exercise the same decode path a live
    response takes.
    """
    from nexus_exchange import Position

    payload: dict[str, Any] = {
        "market_id": market,
        "side": "long",
        "size": size,
        "entry_price": "100",
        "unrealized_pnl": pnl,
        "realized_pnl": "0",
    }
    if notional is not None:
        payload["notional_value"] = notional
    else:
        payload["notional_value"] = None
        payload["notional_value_error"] = notional_error or "mark_price_unavailable"
    return Position.from_dict(payload)


def limits(
    *, notional: str | None = None, loss: str | None = None, margin: str | None = None
) -> Limits:
    return Limits(
        max_notional=Decimal(notional) if notional else None,
        max_loss=Decimal(loss) if loss else None,
        min_available_margin=Decimal(margin) if margin else None,
    )


class NotionalRules(unittest.TestCase):
    """The three-outcome rule, and the two ways `unknown` is the wrong answer."""

    def state(self, positions: list[Any], cap: str = "1000") -> risk.Finding:
        verdict = risk.evaluate(positions, Decimal("1000"), limits(notional=cap))
        return verdict.findings[0]

    def test_exact_total_under_limit_is_within(self) -> None:
        self.assertIs(self.state([position(notional="100")]).state, State.WITHIN)

    def test_exact_total_over_limit_is_breached(self) -> None:
        self.assertIs(self.state([position(notional="5000")]).state, State.BREACHED)

    def test_missing_mark_under_the_bound_is_unknown(self) -> None:
        """The honest unknown: the absent value could land either side."""
        finding = self.state([position(notional="100"), position("ETH", notional=None)])
        self.assertIs(finding.state, State.UNKNOWN)
        self.assertIn("mark_price_unavailable", finding.detail)

    def test_missing_mark_over_the_bound_is_a_proven_breach(self) -> None:
        """A partial sum is a lower bound, so over the limit is already proven.

        Reporting `unknown` here would refuse to act on a fact the app has.
        """
        finding = self.state([position(notional="5000"), position("ETH", notional=None)])
        self.assertIs(finding.state, State.BREACHED)
        self.assertIn("at least 5000", finding.detail)

    def test_bound_exactly_at_the_limit_is_unknown(self) -> None:
        """`>` not `>=`, matching the within/breached boundary elsewhere."""
        finding = self.state([position(notional="1000"), position("ETH", notional=None)])
        self.assertIs(finding.state, State.UNKNOWN)

    def test_flat_position_with_no_mark_does_not_poison_the_total(self) -> None:
        """`|0| x mark` is zero whatever the mark is, so it proves nothing missing.

        Without the skip, one dust position in an unmirrored market pins
        max-notional to `unknown` on every tick from then on.
        """
        finding = self.state(
            [position("DOGE", size="0", notional=None), position(notional="100")]
        )
        self.assertIs(finding.state, State.WITHIN)
        self.assertIn("notional 100", finding.detail)

    def test_all_positions_flat_is_zero_not_unknown(self) -> None:
        finding = self.state([position("DOGE", size="0", notional=None)])
        self.assertIs(finding.state, State.WITHIN)

    def test_no_positions_is_zero(self) -> None:
        self.assertIs(self.state([]).state, State.WITHIN)


class LossAndMarginRules(unittest.TestCase):
    def test_loss_compares_magnitudes(self) -> None:
        verdict = risk.evaluate(
            [position(pnl="-61.40")], Decimal("1000"), limits(loss="50")
        )
        self.assertIs(verdict.findings[0].state, State.BREACHED)
        self.assertIn("loss 61.40", verdict.findings[0].detail)

    def test_profit_is_never_a_loss_breach(self) -> None:
        verdict = risk.evaluate(
            [position(pnl="500")], Decimal("1000"), limits(loss="50")
        )
        self.assertIs(verdict.findings[0].state, State.WITHIN)

    def test_loss_exactly_at_the_limit_is_within(self) -> None:
        verdict = risk.evaluate(
            [position(pnl="-50")], Decimal("1000"), limits(loss="50")
        )
        self.assertIs(verdict.findings[0].state, State.WITHIN)

    def test_margin_floor_breaches_below_not_at(self) -> None:
        self.assertIs(
            risk.evaluate([], Decimal("100"), limits(margin="100")).findings[0].state,
            State.WITHIN,
        )
        self.assertIs(
            risk.evaluate([], Decimal("99"), limits(margin="100")).findings[0].state,
            State.BREACHED,
        )

    def test_unknown_alone_never_breaches(self) -> None:
        """`unknown` reports; it does not fire the guard."""
        verdict = risk.evaluate(
            [position(notional=None)], Decimal("1000"), limits(notional="1000")
        )
        self.assertFalse(verdict.breached)
        self.assertTrue(verdict.indeterminate)

    def test_a_proven_limit_still_fires_beside_an_unknown_one(self) -> None:
        """An unprovable limit must not mask a provable breach elsewhere."""
        verdict = risk.evaluate(
            [position(notional=None, pnl="-500")],
            Decimal("1000"),
            limits(notional="1000", loss="50"),
        )
        self.assertTrue(verdict.breached)
        self.assertTrue(verdict.indeterminate)


class DecimalExactness(unittest.TestCase):
    def test_sums_that_binary_floats_get_wrong(self) -> None:
        """0.1 + 0.2 == 0.3 exactly, which is the whole reason for Decimal."""
        verdict = risk.evaluate(
            [position(notional="0.1"), position("ETH", notional="0.2")],
            Decimal("1000"),
            limits(notional="0.3"),
        )
        self.assertIs(verdict.findings[0].state, State.WITHIN)

    def test_trailing_zeros_compare_equal(self) -> None:
        verdict = risk.evaluate(
            [position(notional="100.00")], Decimal("1000"), limits(notional="100")
        )
        self.assertIs(verdict.findings[0].state, State.WITHIN)


class ConfigRules(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = dict(os.environ)
        for name in list(os.environ):
            if name.startswith(("NEXUS_EXCHANGE_", "NEXUS_GUARD_")):
                del os.environ[name]

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._saved)

    def credentials(self) -> None:
        os.environ["NEXUS_EXCHANGE_API_KEY"] = "k"
        os.environ["NEXUS_EXCHANGE_API_SECRET"] = "00" * 32

    def test_missing_credentials_refuses(self) -> None:
        with self.assertRaises(ConfigError) as caught:
            config.load([])
        self.assertIn("NEXUS_EXCHANGE_API_KEY", str(caught.exception))

    def test_half_a_credential_pair_refuses(self) -> None:
        os.environ["NEXUS_EXCHANGE_API_KEY"] = "k"
        with self.assertRaises(ConfigError):
            config.load([])

    def test_blank_is_treated_as_absent(self) -> None:
        os.environ["NEXUS_EXCHANGE_API_KEY"] = "   "
        os.environ["NEXUS_EXCHANGE_API_SECRET"] = "s"
        with self.assertRaises(ConfigError):
            config.load([])

    def test_no_limits_refuses(self) -> None:
        self.credentials()
        with self.assertRaises(ConfigError) as caught:
            config.load([])
        self.assertIn("nothing to guard", str(caught.exception))

    def test_limits_reject_plausible_nonsense(self) -> None:
        self.credentials()
        for value in ("1e5", "nan", "inf", "1,000", "1_000", "abc", "", "--5", "0x10"):
            os.environ["NEXUS_GUARD_MAX_LOSS"] = value or " "
            with self.subTest(value=value), self.assertRaises(ConfigError):
                config.load([])

    def test_non_ascii_digits_are_refused(self) -> None:
        """`Decimal` reads these; a person reading the shell history does not.

        `\\d` in a Python regex matches every Unicode decimal digit, so this is
        the case where the pattern has to say `[0-9]` to mean what the comment
        beside it claims. `Decimal("١٠٠٠")` is 1000 and `int("١٠٠٠")` is 1000, so
        without the narrower class both a limit and an interval would be accepted
        in a form nobody can check by eye.
        """
        self.credentials()
        for value in ("١٠٠٠", "1٠٠", "𝟣𝟢"):
            os.environ["NEXUS_GUARD_MAX_LOSS"] = value
            with self.subTest(limit=value), self.assertRaises(ConfigError):
                config.load([])
        os.environ["NEXUS_GUARD_MAX_LOSS"] = "50"
        for value in ("١٠", "1٠"):
            os.environ["NEXUS_GUARD_INTERVAL_SECONDS"] = value
            with self.subTest(interval=value), self.assertRaises(ConfigError):
                config.load([])

    def test_limits_must_be_positive(self) -> None:
        self.credentials()
        for value in ("0", "-5", "0.00"):
            os.environ["NEXUS_GUARD_MAX_LOSS"] = value
            with self.subTest(value=value), self.assertRaises(ConfigError):
                config.load([])

    def test_a_plain_decimal_limit_is_exact(self) -> None:
        self.credentials()
        os.environ["NEXUS_GUARD_MAX_LOSS"] = "50.25"
        self.assertEqual(config.load([]).limits.max_loss, Decimal("50.25"))

    def test_interval_bounds_both_ends(self) -> None:
        self.credentials()
        os.environ["NEXUS_GUARD_MAX_LOSS"] = "50"
        for value in ("1", "0", "3601", "1e5", "0x1e", "1_0", "-5", "3.5"):
            os.environ["NEXUS_GUARD_INTERVAL_SECONDS"] = value
            with self.subTest(value=value), self.assertRaises(ConfigError):
                config.load([])
        for value in ("2", "15", "3600"):
            os.environ["NEXUS_GUARD_INTERVAL_SECONDS"] = value
            with self.subTest(value=value):
                self.assertEqual(config.load([]).interval_seconds, int(value))

    def test_arm_flag(self) -> None:
        self.credentials()
        os.environ["NEXUS_GUARD_MAX_LOSS"] = "50"
        self.assertFalse(config.load([]).armed)
        self.assertTrue(config.load(["--arm"]).armed)

    def test_near_misses_for_arm_are_refused_not_ignored(self) -> None:
        """The failure this guards against is an operator who thinks it is armed."""
        self.credentials()
        os.environ["NEXUS_GUARD_MAX_LOSS"] = "50"
        for arg in ("--armed", "-arm", "--arm=true", "arm", "-a", "--ARM"):
            with self.subTest(arg=arg), self.assertRaises(ConfigError) as caught:
                config.load([arg])
            self.assertIn("unrecognised argument", str(caught.exception))

    def test_help_wins_over_everything(self) -> None:
        for argv in (["--help"], ["-h"], ["--arm", "--help"], ["--bogus", "--help"]):
            with self.subTest(argv=argv), self.assertRaises(HelpRequested):
                config.load(argv)


class ErrorClassification(unittest.TestCase):
    """Transient vs terminal, including the SDK flag this app corrects."""

    def test_auth_failures_are_fatal_with_ex_noperm(self) -> None:
        from nexus_exchange import ApiError, AuthError

        for error in (ApiError(401, "no"), ApiError(403, "no"), AuthError("no")):
            with self.subTest(error=error):
                fatal = guard.classify(error)
                assert fatal is not None
                self.assertEqual(fatal.code, guard.EX_NOPERM)

    def test_server_errors_are_transient(self) -> None:
        from nexus_exchange import ApiError, TransportError

        for error in (ApiError(500, "x"), ApiError(503, "x"), ApiError(408, "x")):
            with self.subTest(error=error):
                self.assertIsNone(guard.classify(error))
        self.assertIsNone(guard.classify(TransportError("connection reset")))

    def test_rate_limiting_is_transient_despite_the_sdk_flag(self) -> None:
        """The correction this app makes, pinned so a bump cannot undo it.

        `ApiError.transient` is `status >= 500 or status == 408`, so 429 reports
        terminal. Left alone, the guard would shut itself down the first time it
        was rate limited.
        """
        from nexus_exchange import ApiError

        rate_limited = ApiError(429, "slow down")
        self.assertFalse(rate_limited.transient, "SDK behaviour changed; revisit is_transient")
        self.assertTrue(guard.is_transient(rate_limited))
        self.assertIsNone(guard.classify(rate_limited))

    def test_other_terminal_errors_use_ex_dataerr(self) -> None:
        from nexus_exchange import ApiError

        fatal = guard.classify(ApiError(400, "bad request"))
        assert fatal is not None
        self.assertEqual(fatal.code, guard.EX_DATAERR)

    def test_failure_key_groups_by_class_not_message(self) -> None:
        """One outage must not reprint forever because the path differs."""
        from nexus_exchange import ApiError, TransportError

        a = guard.failure_key(TransportError("GET /api/v1/account failed"))
        b = guard.failure_key(TransportError("GET /api/v1/orders failed"))
        self.assertEqual(a, b)
        self.assertNotEqual(a, guard.failure_key(ApiError(500, "x")))

    def test_one_line_bounds_an_html_error_page(self) -> None:
        html = "<html>\n<head>\n<title>403</title>\n</head>\n" + "x" * 500
        flat = guard.one_line(html)
        self.assertNotIn("\n", flat)
        self.assertLessEqual(len(flat), 201)


class _Handler(BaseHTTPRequestHandler):
    #: Set per test. Class-level so the handler, which the server instantiates
    #: per request, can reach it without threading state through the server.
    account: dict[str, Any] = {}
    #: Every path the server was asked for, so a test can assert on the URL the
    #: SDK actually composed rather than on what it hoped it would.
    seen: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
        _Handler.seen.append(self.path)
        body = json.dumps(self.account).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


class SdkBoundary(unittest.TestCase):
    """The real SDK against a real socket. Pins what this app assumes of it."""

    server: HTTPServer
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    @property
    def base(self) -> str:
        # Bound to 127.0.0.1 above; `server_port` is the only part that varies,
        # since port 0 lets the OS choose a free one.
        return f"http://127.0.0.1:{self.server.server_port}"

    def setUp(self) -> None:
        _Handler.seen.clear()
        _Handler.account = {
            "balance": "1000",
            "collateral": "1000",
            "equity": "1000",
            "available_margin": "400",
            "positions": [],
        }

    def cfg(self, base_url: str | None) -> config.Config:
        return config.Config(
            api_key="k",
            api_secret="00" * 32,
            base_url=base_url,
            limits=limits(loss="50"),
            interval_seconds=2,
            armed=False,
        )

    def test_override_alone_reports_funds_as_undeclared(self) -> None:
        """The trap this app avoids, pinned.

        Passing `Network.TESTNET` *and* `base_url` routes at the override while
        still reporting `funds=PLAY` — a caller-supplied host labelled play
        funds. Passing `base_url` alone is honest, so that is what `build_client`
        does.
        """
        from nexus_exchange import Client, Funds, Network

        mislabelled = Client(
            Network.TESTNET, base_url=self.base, api_key="k", api_secret="00" * 32
        )
        self.assertIs(
            mislabelled.network.funds,
            Funds.PLAY,
            "SDK behaviour changed; revisit build_client",
        )

        honest = guard.build_client(self.cfg(self.base))
        self.assertIs(honest.network.funds, Funds.UNKNOWN)
        self.assertEqual(guard.describe_funds(honest.network.funds), "funds not declared")

    def test_the_override_is_a_described_target_not_a_bare_url(self) -> None:
        """The non-deprecated selector, and that it changes nothing but the name.

        A lone `base_url=` is deprecated (ENG-10955) and resolves to exactly this
        config, so the two must agree on everything a request depends on — the
        two bases and the funds — and differ only in the label, which this app
        now supplies instead of inheriting the SDK's generic "custom".
        """
        from nexus_exchange import Client

        described = guard.build_client(self.cfg(self.base)).network
        self.assertEqual(described.label, guard.OVERRIDE_LABEL)

        deprecated = Client(
            base_url=self.base, api_key="k", api_secret="00" * 32
        ).network
        self.assertEqual(described.base_url, deprecated.base_url)
        self.assertEqual(described.direct_base_url, deprecated.direct_base_url)
        self.assertIs(described.funds, deprecated.funds)
        # A faucet mints funds; nothing about a URL says this deployment has one.
        self.assertFalse(described.has_faucet)

    def test_both_forms_actually_route_at_the_override(self) -> None:
        """Which is why reporting is the only difference that matters."""
        guard.build_client(self.cfg(self.base)).fetch_balance()
        self.assertIn("/api/v1/account", _Handler.seen)

    def test_default_target_is_testnet_play_funds(self) -> None:
        client = guard.build_client(self.cfg(None))
        self.assertEqual(guard.describe_funds(client.network.funds), "play funds")

    def test_decimals_survive_the_wire_as_decimals(self) -> None:
        """A float here is how a limit check decides the wrong way."""
        _Handler.account["available_margin"] = "0.30"
        _Handler.account["positions"] = [
            {
                "market_id": "BTC-USDX-PERP",
                "side": "long",
                "size": "1",
                "entry_price": "100",
                "unrealized_pnl": "-0.1",
                "realized_pnl": "0",
                "notional_value": "0.2",
            }
        ]
        account = guard.build_client(self.cfg(self.base)).fetch_balance()
        self.assertIsInstance(account.available_margin, Decimal)
        self.assertIsInstance(account.positions[0].notional_value, Decimal)
        verdict = risk.evaluate(
            account.positions, account.available_margin, limits(margin="0.3")
        )
        self.assertIs(verdict.findings[0].state, State.WITHIN)

    def test_mainnet_is_refused_locally(self) -> None:
        """No bytes leave the process, and this app does not re-implement it."""
        from nexus_exchange import Client, Network

        with self.assertRaises(ValueError):
            Client(Network.MAINNET, api_key="k", api_secret="00" * 32)


class Presentation(unittest.TestCase):
    def test_summary_states(self) -> None:
        ok = risk.evaluate([], Decimal("1000"), limits(loss="50"))
        self.assertTrue(guard.summarise(ok, 2).startswith("ok "))
        breached = risk.evaluate([position(pnl="-500")], Decimal("1000"), limits(loss="50"))
        self.assertTrue(guard.summarise(breached, 2).startswith("BREACHED"))
        unproven = risk.evaluate(
            [position(notional=None)], Decimal("1000"), limits(notional="1000")
        )
        self.assertTrue(guard.summarise(unproven, 0).startswith("UNPROVEN"))

    def test_summary_carries_the_resting_count(self) -> None:
        ok = risk.evaluate([], Decimal("1000"), limits(loss="50"))
        self.assertIn("resting=3", guard.summarise(ok, 3))

    def test_shutdown_bound_is_derived_from_the_timeout(self) -> None:
        """Stated in the README, so it must not drift from the constant."""
        self.assertEqual(
            guard.MAX_SHUTDOWN_WAIT_SECONDS, 3 * guard.REQUEST_TIMEOUT_SECONDS
        )
        self.assertLess(guard.MAX_SHUTDOWN_WAIT_SECONDS, 30)

    def test_forced_exit_names_the_signal_that_forced_it(self) -> None:
        """`128 + signum`, so a supervisor is not told SIGTERM was a Ctrl-C."""
        self.assertEqual(guard.signal_exit_code(signal.SIGINT), 130)
        self.assertEqual(guard.signal_exit_code(signal.SIGTERM), 143)


if __name__ == "__main__":
    unittest.main()
