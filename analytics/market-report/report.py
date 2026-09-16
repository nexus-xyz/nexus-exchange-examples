#!/usr/bin/env python3
"""market-report — a venue-wide market report from the Exchange's read-only API.

    python3 report.py                      # 24h at the finest honoured timeframe
    python3 report.py --window 7d
    python3 report.py --markets BTC-USDX-PERP,SOL-USDX-PERP --timeframe 1h

No credentials, no SDK, no third-party packages: everything here is the Python
standard library talking to public market-data endpoints on testnet.

The report itself is the easy half. What the code is mostly doing is refusing to
turn a bad series into a plausible number — see `series.py`, which is where the
example earns its place.
"""

from __future__ import annotations

import argparse
import dataclasses
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn, Sequence

from analysis import (
    MarketAnalysis,
    analyze_market,
    merge_market_sources,
    parse_catalog,
    parse_summaries,
    parse_tickers,
    parse_venue_stats,
)
from api import API_VERSION, Api, ApiError, Cache, DEFAULT_BASE_URL
from render import ReportMeta, html_report, text_report, write_csv
from series import (
    CANDLE_LIMIT_CAP,
    TIMEFRAMES,
    Issue,
    bucket_fill_history,
    parse_candles,
    parse_funding,
)

EX_OK = 0
EX_USAGE = 1        # a flag or an environment value that cannot be used
EX_HOST = 2         # the venue could not be read at all
EX_NO_DATA = 3      # it answered, and no market produced a usable series
EX_QUALITY = 4      # --strict, and at least one series had something wrong with it

# The most fills-per-bucket points the venue chart uses. Enough to see shape,
# few enough to keep the HTML small.
FILL_HISTORY_BUCKETS = 120


def parse_window(text: str) -> int:
    """`90m`, `24h`, `7d` → milliseconds."""
    units = {"m": 60_000, "h": 3_600_000, "d": 86_400_000}
    raw = text.strip().lower()
    if len(raw) < 2 or raw[-1] not in units or not raw[:-1].isdigit():
        raise argparse.ArgumentTypeError(
            f"window must look like 90m, 24h or 7d (got {text!r})"
        )
    amount = int(raw[:-1])
    if amount <= 0:
        raise argparse.ArgumentTypeError("window must be positive")
    return amount * units[raw[-1]]


def choose_timeframe(window_ms: int) -> tuple[str, int, int, int]:
    """Pick the finest honoured timeframe whose bucket count fits the cap.

    Returns `(timeframe, step_ms, limit, window_buckets)`, where `limit` is what
    will be requested and `window_buckets` is what the window actually needs —
    they differ only when even the coarsest timeframe cannot reach back far
    enough, and that difference is what gets reported.

    This is the arithmetic a reader would otherwise get wrong once and never
    notice: `limit` is silently clamped at 1000 by the server, so asking for a
    7-day window at 1m returns the most recent 1000 minutes and looks like a
    7-day answer. Choosing the timeframe from the window — and printing the
    sum — means the truncation either does not happen or is stated.
    """
    for name in sorted(TIMEFRAMES, key=lambda key: TIMEFRAMES[key]):
        step = TIMEFRAMES[name]
        needed = math.ceil(window_ms / step) + 1
        if needed <= CANDLE_LIMIT_CAP:
            return name, step, needed, needed
    # Wider than the coarsest timeframe can cover: use it anyway and let the
    # `truncated_at_cap` issue report what was lost. Silently returning a
    # shorter window would be the one unacceptable outcome.
    coarsest = max(TIMEFRAMES, key=lambda key: TIMEFRAMES[key])
    needed = math.ceil(window_ms / TIMEFRAMES[coarsest]) + 1
    return coarsest, TIMEFRAMES[coarsest], CANDLE_LIMIT_CAP, needed


class _Parser(argparse.ArgumentParser):
    """argparse, but its own errors use this program's usage exit code.

    `ArgumentParser.error` exits 2 by default, and 2 already means "the venue
    could not be read" here. A caller that switches on the exit code would read
    a typo in a flag as an outage.
    """

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        raise SystemExit(EX_USAGE)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="market-report",
        description="A venue-wide market report from the Nexus Exchange read-only API.",
    )
    parser.add_argument(
        "--window",
        type=parse_window,
        default="24h",
        metavar="DURATION",
        help="window to report over, e.g. 90m, 24h, 7d (default: 24h)",
    )
    parser.add_argument(
        "--timeframe",
        choices=("auto", *sorted(TIMEFRAMES, key=lambda key: TIMEFRAMES[key])),
        default="auto",
        help="candle interval; 'auto' picks the finest one that covers the window "
        "(default: auto). Only 1m, 5m and 1h are honoured by the venue.",
    )
    parser.add_argument(
        "--markets",
        default="",
        metavar="IDS",
        help="comma-separated market ids (default: every listed market)",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("out"), metavar="DIR",
        help="where report.csv and report.html are written (default: ./out)",
    )
    parser.add_argument(
        "--format", choices=("all", "text", "csv", "html"), default="all",
        help="which outputs to produce (default: all)",
    )
    parser.add_argument(
        "--base-url", default=os.environ.get("NEXUS_EXCHANGE_API_URL", DEFAULT_BASE_URL),
        help="API gateway base; also read from NEXUS_EXCHANGE_API_URL",
    )
    parser.add_argument("--timeout", type=float, default=20.0, metavar="SECONDS")
    parser.add_argument("--attempts", type=int, default=3, metavar="N",
                        help="attempts per request; only transient failures retry")
    parser.add_argument("--cache-ttl", type=float, default=300.0, metavar="SECONDS",
                        help="how long a cached response stays usable (default: 300)")
    parser.add_argument("--no-cache", action="store_true",
                        help="always fetch, and write nothing to the cache")
    parser.add_argument(
        "--strict", action="store_true",
        help="exit non-zero if any series had a data-quality issue. For running "
        "this on a schedule, where a silently degraded feed is the thing you "
        "want to hear about.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # argparse ran `parse_window` over the string default too, so this is an int
    # whether or not --window was passed.
    window_ms: int = args.window
    if args.attempts < 1:
        print("error: --attempts must be at least 1", file=sys.stderr)
        return EX_USAGE

    if args.timeframe == "auto":
        timeframe, step_ms, limit, window_buckets = choose_timeframe(window_ms)
    else:
        timeframe = str(args.timeframe)
        step_ms = TIMEFRAMES[timeframe]
        window_buckets = math.ceil(window_ms / step_ms) + 1
        limit = min(CANDLE_LIMIT_CAP, window_buckets)

    cache = None if args.no_cache else Cache(Path(".cache"), args.cache_ttl)
    try:
        api = Api(
            args.base_url,
            timeout=args.timeout,
            attempts=args.attempts,
            cache=cache,
        )
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EX_USAGE

    now_ms = int(time.time() * 1000)

    # The shared reads. A failure here is not "one market is missing", it is "the
    # venue could not be read", so it ends the run with its own exit code rather
    # than producing an empty report that looks like a quiet market.
    try:
        # Three routes, because they disagree about which markets exist — see
        # `merge_market_sources`. Note the first path: the market catalog is the
        # one endpoint here that is *not* under /api/v1.
        catalog_payload = api.get_json("/markets")
        summaries_payload = api.get_json("/api/v1/markets/summary")
        tickers_payload = api.get_json("/api/v1/tickers")
        stats_payload = api.get_json("/api/v1/stats")
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EX_HOST

    catalog = parse_catalog(catalog_payload)
    summaries = parse_summaries(summaries_payload)
    tickers = parse_tickers(tickers_payload)
    snapshots = merge_market_sources(catalog, summaries, tickers)
    if not snapshots:
        print("error: no route listed a recognisable market", file=sys.stderr)
        return EX_HOST
    venue_stats = parse_venue_stats(stats_payload)

    # `/stats/history` is a nice-to-have: the report is still a report without
    # the activity chart, so a failure here is a note rather than an exit.
    fill_history: list[int] = []
    try:
        history_payload = api.get_json("/api/v1/stats/history")
    except ApiError as exc:
        print(f"warning: /api/v1/stats/history unavailable ({exc})", file=sys.stderr)
    else:
        history_step = max(1, window_ms // FILL_HISTORY_BUCKETS)
        fill_history = bucket_fill_history(
            history_payload,
            step_ms=history_step,
            now_ms=now_ms,
            buckets=FILL_HISTORY_BUCKETS,
        )

    wanted = [name.strip() for name in args.markets.split(",") if name.strip()]
    if wanted:
        unknown = [name for name in wanted if name not in snapshots]
        if unknown:
            print(
                f"error: not listed on this venue: {', '.join(unknown)}. "
                f"Available: {', '.join(sorted(snapshots))}",
                file=sys.stderr,
            )
            return EX_USAGE
        markets = wanted
    else:
        markets = sorted(snapshots)

    analyses: list[MarketAnalysis] = []
    failed: list[str] = []
    for market in markets:
        snapshot = snapshots[market]
        try:
            candles_payload = api.get_json(
                f"/api/v1/markets/{market}/candles",
                {"timeframe": timeframe, "limit": str(limit)},
            )
            funding_payload = api.get_json(
                f"/api/v1/markets/{market}/funding",
                {"limit": str(_funding_limit(window_ms))},
            )
        except ApiError as exc:
            # One market failing is not the venue failing. It is reported by
            # name, and the failure is attached to the row as a finding rather
            # than only logged — otherwise the CSV shows a market with no numbers
            # and no reason, which is indistinguishable from a quiet market.
            print(f"warning: {market}: {exc}", file=sys.stderr)
            failed.append(market)
            analyses.append(
                dataclasses.replace(
                    analyze_market(snapshot, tickers.get(market), None, None),
                    derived_issues=(
                        Issue("fetch_failed", str(exc), severity="fatal"),
                    ),
                )
            )
            continue

        series = parse_candles(
            candles_payload,
            market=market,
            requested_timeframe=timeframe,
            limit=limit,
            window_buckets=window_buckets,
            now_ms=now_ms,
        )
        funding = parse_funding(funding_payload, market=market)
        # Keep only the funding samples inside the window, so the mean describes
        # the same period as everything next to it in the row.
        in_window = tuple(
            point for point in funding.points if point.timestamp_ms >= now_ms - window_ms
        )
        funding = dataclasses.replace(funding, points=in_window)
        analyses.append(analyze_market(snapshot, tickers.get(market), series, funding))

    meta = ReportMeta(
        base_url=api.base_url,
        api_version=API_VERSION,
        generated_at=datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%SZ"
        ),
        window_label=_window_label(window_ms),
        timeframe=timeframe,
        buckets_requested=limit,
        requests_made=api.request_count,
        cache_hits=api.cache_hits,
        strict=bool(args.strict),
    )

    if args.format in ("all", "text"):
        print(text_report(meta, venue_stats, analyses))
        # Flushed because the "wrote ..." notes below go to stderr, which is
        # unbuffered: without this the notes appear above the report whenever
        # stdout is a pipe rather than a terminal.
        sys.stdout.flush()

    out_dir: Path = args.out
    if args.format in ("all", "csv"):
        csv_path = out_dir / "report.csv"
        write_csv(csv_path, analyses)
        print(f"\nwrote {csv_path}", file=sys.stderr)
    if args.format in ("all", "html"):
        html_path = out_dir / "report.html"
        html_path.parent.mkdir(parents=True, exist_ok=True)
        html_path.write_text(
            html_report(meta, venue_stats, analyses, fill_history), encoding="utf-8"
        )
        print(f"wrote {html_path}", file=sys.stderr)

    usable = [analysis for analysis in analyses if analysis.has_series]
    if not usable:
        print(
            "error: no market produced a usable candle series — see the data "
            "quality section above",
            file=sys.stderr,
        )
        return EX_NO_DATA

    if failed:
        print(f"warning: {len(failed)} market(s) could not be fetched: {', '.join(failed)}",
              file=sys.stderr)

    if args.strict:
        # `alertable` rather than "has any issue at all". A dropped forming
        # bucket is normal on every single run, so a strict mode that counted it
        # would fail always — and a check that always fails is a check nobody
        # looks at.
        flagged = [
            analysis.market
            for analysis in analyses
            if any(issue.alertable for issue in analysis.issues)
        ]
        if flagged:
            print(
                f"error: --strict and {len(flagged)} market(s) had a degraded feed: "
                f"{', '.join(flagged)}",
                file=sys.stderr,
            )
            return EX_QUALITY

    return EX_OK


def _window_label(window_ms: int) -> str:
    """The window as a human would have typed it.

    Hours up to two days, then days: "24h" rather than "1d", because that is
    what the flag said and a report that renames its own input invites a second
    look at whether it used the value it was given.
    """
    if window_ms % 86_400_000 == 0 and window_ms >= 2 * 86_400_000:
        return f"{window_ms // 86_400_000}d"
    if window_ms % 3_600_000 == 0:
        return f"{window_ms // 3_600_000}h"
    return f"{window_ms // 60_000}m"


def _funding_limit(window_ms: int) -> int:
    """Enough funding samples to cover the window, whatever the interval is.

    The interval is not assumed — it is measured from the timestamps that come
    back — so the request has to be generous rather than exact: one per minute
    of the window would be wasteful, one per hour would come up short if the
    venue moved to a finer schedule. Hourly plus a day of slack, capped.
    """
    hours = math.ceil(window_ms / 3_600_000)
    return max(2, min(CANDLE_LIMIT_CAP, hours + 24))


if __name__ == "__main__":
    sys.exit(main())
