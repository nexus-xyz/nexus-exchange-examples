#!/usr/bin/env python3
"""ccxt-port — run CCXT-shaped code against Nexus, next to the native client.

    python3 scan.py                       # both paths, and the parity report
    python3 scan.py --via ccxt            # just the CCXT-shaped scan
    python3 scan.py --surface             # what the adapter implements, and what it does not
    python3 scan.py --timeframe 1h --strict

The app is a market scanner: per market it reports last price, 24h change,
top-of-book spread, book depth near the mid, annualised realized volatility from
candles, and taker buy share from recent trades. It is written **twice** — once
in `ccxt_path.py` as the CCXT-shaped code a freqtrade or hummingbot user already
has, once in `native_path.py` on the typed SDK — and `parity.py` diffs the two
answers field by field.

Why it is built that way: the shortest path from "I have a CCXT script" to "it
runs on Nexus" is the adapter, and the question nobody can answer from an API
reference is what that costs. So the app measures it on whatever deployment you
point it at instead of asserting it.

**Market data only.** The adapter implements ``describe()`` plus
``fetch_markets``, ``fetch_ticker``, ``fetch_tickers``, ``fetch_order_book``,
``fetch_ohlcv`` and ``fetch_trades``. Balances, positions and orders are a
deliberate follow-up in the SDK and are **not** stubbed here — calling one is an
``AttributeError``, which `--surface` will show you without calling anything.
That is also why this app needs no credentials at all.
"""

from __future__ import annotations

import argparse
import sys
from decimal import Decimal, InvalidOperation
from typing import NoReturn, Sequence

from nexus_exchange import ApiError, Client, NexusExchangeError
from nexus_exchange.ccxt_adapter import NexusExchange

import render
import surface
from ccxt_path import DEFAULT_DEPTH_BPS, STEP_MS
from ccxt_path import scan as ccxt_scan
from native_path import scan as native_scan
from parity import DEFAULT_TOLERANCE, Verdict, compare, gaps, summarise
from target import BASE_URL_ENV, TargetError, resolve

EX_OK = 0
EX_USAGE = 1  # a flag or an environment value that cannot be used
EX_HOST = 2  # the venue could not be read at all
EX_NO_DATA = 3  # it answered, and no market produced a comparable figure
EX_PARITY = 4  # --strict, and the two paths disagreed by more than rounding

#: Per-request ceiling. Tighter than the SDK's 30s default because this makes
#: 2 + 3N requests in a burst and exits; a run that hangs for half a minute on
#: one market is a run somebody kills before it prints anything.
REQUEST_TIMEOUT_SECONDS = 15.0

DEFAULT_TIMEFRAME = "5m"
DEFAULT_CANDLES = 200
DEFAULT_TRADES = 200


class _Parser(argparse.ArgumentParser):
    """argparse, but its own errors use this program's usage exit code.

    ``ArgumentParser.error`` exits 2 by default, and 2 already means "the venue
    could not be read" here. A caller switching on the exit code would otherwise
    read a typo in a flag as an outage. Same subclass, for the same reason, as
    `analytics/market-report`.
    """

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        raise SystemExit(EX_USAGE)


def _tolerance(text: str) -> Decimal:
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise argparse.ArgumentTypeError(f"tolerance must be a decimal (got {text!r})")
    if not value.is_finite() or value < 0:
        raise argparse.ArgumentTypeError("tolerance must be finite and non-negative")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="ccxt-port",
        description=(
            "Run CCXT-shaped market-data code against Nexus through "
            "nexus_exchange.ccxt_adapter, next to the same logic on the native client."
        ),
    )
    parser.add_argument(
        "--via",
        choices=("both", "ccxt", "native"),
        default="both",
        help="which implementation to run (default: both, which also prints parity)",
    )
    parser.add_argument(
        "--markets",
        metavar="IDS",
        help="comma-separated market ids (default: every market the venue lists)",
    )
    parser.add_argument(
        "--timeframe",
        choices=tuple(sorted(STEP_MS)),
        default=DEFAULT_TIMEFRAME,
        help=(
            f"candle interval (default: {DEFAULT_TIMEFRAME}). These four are the "
            f"whole set the venue serves — there is no 15m, 4h or 1d"
        ),
    )
    parser.add_argument(
        "--candles", type=int, default=DEFAULT_CANDLES, metavar="N",
        help=f"candles to request per market (default: {DEFAULT_CANDLES})",
    )
    parser.add_argument(
        "--trades", type=int, default=DEFAULT_TRADES, metavar="N",
        help=f"recent trades to request per market (default: {DEFAULT_TRADES})",
    )
    parser.add_argument(
        "--depth-bps", type=float, default=DEFAULT_DEPTH_BPS, metavar="BPS",
        help=f"how far from the mid to sum depth (default: {DEFAULT_DEPTH_BPS:g})",
    )
    parser.add_argument(
        "--tolerance", type=_tolerance, default=DEFAULT_TOLERANCE, metavar="REL",
        help=(
            f"relative difference still counted as rounding rather than a real "
            f"disagreement (default: {DEFAULT_TOLERANCE})"
        ),
    )
    parser.add_argument(
        "--base-url", metavar="URL",
        help=f"deployment base; also read from {BASE_URL_ENV}. Must not end in /api/v1",
    )
    parser.add_argument(
        "--surface", action="store_true",
        help="print what the adapter implements and what it does not, then exit",
    )
    parser.add_argument(
        "--strict", action="store_true",
        help="exit non-zero if any field differs by more than rounding explains",
    )
    return parser


def _symbols(exchange: NexusExchange, requested: str | None) -> list[str]:
    """The markets to scan, refusing an unknown id rather than skipping it.

    ``load_markets`` is the CCXT idiom and it is also the adapter's only cache,
    so this is where it gets populated for the whole run.
    """
    available = sorted(exchange.load_markets())
    if not available:
        return []
    if requested is None:
        return available
    wanted = [item.strip() for item in requested.split(",") if item.strip()]
    unknown = [item for item in wanted if item not in available]
    if unknown:
        raise TargetError(
            f"unknown market(s): {', '.join(unknown)}. "
            f"The venue lists: {', '.join(available)}"
        )
    return wanted


def _positive(name: str, value: int, ceiling: int) -> int:
    if value < 1 or value > ceiling:
        raise TargetError(f"--{name} must be between 1 and {ceiling} (got {value})")
    return value


def run(args: argparse.Namespace) -> int:
    target = resolve(args.base_url)
    client: Client | None = None
    try:
        client = target.client(REQUEST_TIMEOUT_SECONDS)
        # One transport, two facades over it. `NexusExchange(client=...)` shares
        # the underlying `Client` rather than opening a second one, so the two
        # halves cannot differ because of connection-level luck — and, because
        # the adapter did not create it, `ex.close()` leaves it alone and this
        # function stays the single owner.
        exchange = NexusExchange(client=client)

        entries = surface.probe(exchange)
        if args.surface:
            print(surface.table(entries))
            return EX_OK

        print(f"ccxt-port on {target.banner()}")
        print(surface.one_line(entries))
        for entry in surface.inconsistencies(entries):
            print(f"  WARNING {entry.ccxt_name}: {entry.note}", file=sys.stderr)

        candles = _positive("candles", args.candles, 1000)
        trades = _positive("trades", args.trades, 1000)
        symbols = _symbols(exchange, args.markets)
        if not symbols:
            print("the venue listed no markets", file=sys.stderr)
            return EX_NO_DATA
        print(
            f"window: {len(symbols)} market(s) at {args.timeframe}, "
            f"{candles} candles and {trades} trades each, "
            f"depth within {args.depth_bps:g} bps of the mid"
        )
        print()

        depth_bps = float(args.depth_bps)
        ccxt_scans = native_scans = None
        if args.via in ("both", "ccxt"):
            ccxt_scans = ccxt_scan(
                exchange, symbols, args.timeframe, candles, trades, depth_bps
            )
            print(render.ccxt_table(ccxt_scans))
            print()
        if args.via in ("both", "native"):
            markets = {market.market_id: market for market in client.fetch_markets()}
            native_scans = native_scan(
                client, symbols, markets, args.timeframe, candles, trades,
                Decimal(str(depth_bps)),
            )
            print(render.native_table(native_scans))
            print()

        if ccxt_scans is not None and native_scans is not None:
            rows = compare(ccxt_scans, native_scans, args.tolerance)
            summary = summarise(rows)
            print(render.parity_table(rows))
            print()
            print(render.parity_summary(summary))
            print()
            block = render.gaps_block(gaps(native_scans))
            if block:
                print(block)
                print()
            notes = render.notes_block(ccxt_scans, native_scans)
            if notes:
                print(notes)
                print()
            if summary.compared == 0:
                return EX_NO_DATA
            if args.strict and summary.worst is Verdict.DIFFERS:
                print(
                    f"--strict: {summary.differs} field(s) differ by more than "
                    f"rounding explains",
                    file=sys.stderr,
                )
                return EX_PARITY
        return EX_OK
    finally:
        if client is not None:
            client.close()


def main(argv: Sequence[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except TargetError as error:
        print(f"error: {error}", file=sys.stderr)
        return EX_USAGE
    except ValueError as error:
        # `fetch_ohlcv` raises this for an unsupported timeframe. `--timeframe`
        # is already a `choices=` argument so it should be unreachable from the
        # command line, but a venue that drops a timeframe would surface here,
        # and it is a usage problem rather than an outage.
        print(f"error: {error}", file=sys.stderr)
        return EX_USAGE
    except ApiError as error:
        # Printed in one bounded line: point this at a host whose root serves a
        # web app and the error body is a whole HTML document, which buries the
        # line that said what failed. Seen for real on the decommissioned
        # gateway `Network.TESTNET` still resolves to.
        detail = " ".join(str(error).split())[:200]
        print(f"the venue answered {error.status}: {detail}", file=sys.stderr)
        if error.status >= 500:
            print(
                f"a 5xx here is the deployment, not this example. Try "
                f"{BASE_URL_ENV} against another base.",
                file=sys.stderr,
            )
        return EX_HOST
    except NexusExchangeError as error:
        print(f"could not read the venue: {' '.join(str(error).split())[:200]}", file=sys.stderr)
        return EX_HOST


def _entry() -> NoReturn:
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    _entry()
