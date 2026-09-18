"""The scan, written the way a CCXT user already has it.

This is the half of the example you are meant to recognise. It calls
``load_markets``, ``fetch_tickers``, ``fetch_order_book``, ``fetch_ohlcv`` and
``fetch_trades``; it indexes unified dicts by their unified key names; it treats
book levels as ``[price, amount]`` pairs and candles as ``[ts, o, h, l, c, v]``
rows; and every number it touches is a ``float``. Nothing in here is written
*for* Nexus. That is the point — it is the code a freqtrade or hummingbot user
would paste in, and the only Nexus-specific line in the module is the import.

`native_path.py` computes the identical figures against the typed SDK, and
`parity.py` diffs the two. Read them together: what changes between them is what
the unified layer costs.

Four things in here are workarounds, not style, and each is marked at the point
it happens:

* ``timeframe`` must be one of four values (:data:`STEP_MS`), not CCXT's usual
  open set — and it is the adapter, not this code, that enforces it.
* The candle series really does arrive with a ``timestamp == 0`` row on this
  venue, which the adapter passes through unchanged.
* The final candle is still being written when you fetch it.
* Trades come back **newest first**, which is the opposite of CCXT's ascending
  convention, so nothing here indexes a trade list positionally.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from nexus_exchange.ccxt_adapter import NexusExchange

#: Milliseconds per bucket, for each timeframe the adapter accepts.
#:
#: The adapter's own ``TIMEFRAMES`` is the authority on *which* strings are
#: accepted; this maps them to a duration, which is what annualising needs. Four
#: values, and that is the whole set: the venue serves ``1s``, ``1m``, ``5m`` and
#: ``1h`` and nothing else. A CCXT port that assumes ``1d`` exists is the single
#: likeliest thing to break, so see the README's timeframe row before reaching
#: for a daily bar.
STEP_MS: dict[str, int] = {"1s": 1_000, "1m": 60_000, "5m": 300_000, "1h": 3_600_000}

#: Milliseconds in the 365-day year every annualised figure here is scaled to.
#: A convention, not a fact, which is why it is named — the same one
#: `analytics/market-report` uses, so the two catalogs' volatility numbers are
#: comparable.
YEAR_MS = 365 * 24 * 60 * 60 * 1000

#: How far from the mid to sum book depth, in basis points.
DEFAULT_DEPTH_BPS = 10.0


def as_float(value: Any) -> float | None:
    """One number off a unified dict, or ``None``.

    CCXT's structures are untyped by nature — every value is whatever the venue
    sent — so a port needs exactly this function at the boundary whether or not
    it is typechecked. Nothing downstream then has to wonder.

    ``bool`` is rejected ahead of the numeric test because ``isinstance(True,
    int)`` is ``True`` in Python, and a flag silently becoming the price ``1.0``
    is the kind of bug that produces a plausible number instead of an error.
    Non-finite values are rejected for the same reason: ``nan`` compares false
    against every threshold, so it would quietly disable any check made against
    it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


@dataclass(frozen=True, slots=True)
class Scan:
    """One market's figures, as the unified layer can express them."""

    symbol: str
    last: float | None
    change_pct: float | None
    spread_bps: float | None
    depth_quote: float | None
    rvol_pct: float | None
    taker_buy_share: float | None
    candles_used: int
    trades_used: int
    #: `market["precision"]["price"]`, straight out of the unified market dict.
    #:
    #: Carried here so `parity.py` can compare it against the exact
    #: `Market.tick_size`, and because it is a trap in its own right: CCXT's
    #: `precision` is a **digit count** under the default `DECIMAL_PLACES`
    #: precision mode, and what is in this field is a tick *size* — `0.5`, not
    #: `1`. The adapter advertises no `precisionMode` either way, so
    #: `round(price, market["precision"]["price"])` — ordinary CCXT code —
    #: raises `TypeError` here rather than rounding wrongly.
    tick_size: float | None = None
    notes: list[str] = field(default_factory=list)


def _levels(raw: Any) -> list[tuple[float, float]]:
    """``[price, amount]`` pairs off a unified order book.

    This is the flattening the README calls out, in the one place it costs
    something: the native SDK hands back ``PriceLevel`` objects with named
    ``price`` and ``amount`` attributes, and here the same information is a
    two-element list whose meaning is positional. Get the index the wrong way
    round and you get a number, not an error.
    """
    out: list[tuple[float, float]] = []
    if not isinstance(raw, list):
        return out
    for level in raw:
        if not isinstance(level, (list, tuple)) or len(level) < 2:
            continue
        price = as_float(level[0])
        amount = as_float(level[1])
        if price is not None and amount is not None and price > 0 and amount > 0:
            out.append((price, amount))
    return out


def _book_figures(
    book: dict[str, Any], depth_bps: float
) -> tuple[float | None, float | None, list[str]]:
    """Top-of-book spread in bps, and quote-notional depth within ``depth_bps``."""
    notes: list[str] = []
    bids = _levels(book.get("bids"))
    asks = _levels(book.get("asks"))
    if not bids or not asks:
        notes.append("empty book side — no spread or depth")
        return None, None, notes

    # The adapter documents bids descending and asks ascending, which is CCXT's
    # convention, but the best level is taken by `max`/`min` rather than by
    # index. An ordering assumption that is right today and wrong after a server
    # change produces a negative spread, not an exception.
    best_bid = max(price for price, _ in bids)
    best_ask = min(price for price, _ in asks)
    if best_ask <= best_bid:
        notes.append(f"crossed book: bid {best_bid} >= ask {best_ask}")
        return None, None, notes

    mid = (best_bid + best_ask) / 2
    spread_bps = (best_ask - best_bid) / mid * 10_000
    window = mid * depth_bps / 10_000
    depth = sum(
        price * amount for price, amount in bids if price >= mid - window
    ) + sum(price * amount for price, amount in asks if price <= mid + window)
    return spread_bps, depth, notes


def _closes(
    rows: Sequence[Sequence[float]], step_ms: int
) -> tuple[list[tuple[int, float]], list[str]]:
    """Usable closes from ``[ts, o, h, l, c, v]`` rows, oldest first, timestamped.

    The timestamp is carried out with the close rather than discarded, and that
    is the whole point of this function's return type. A close-to-close return is
    only a return *over one bucket* if the two buckets are adjacent; a bare list
    of closes cannot say whether they were, so anything computed from one
    silently treats a gap as an ordinary step. See :func:`realized_vol_pct`.

    Five refusals, all of them things this venue actually does:

    * **A ``timestamp == 0`` row.** The 5m and 1h series each start with one.
      Plotted it lands in 1970; averaged it moves everything. The adapter passes
      it straight through — ``_parse_ohlcv`` only requires six numeric fields —
      so the unified layer does not save you from this one.
    * **The newest bucket is still forming.** Its close and volume are partial,
      so including it makes the most recent return wrong in the direction that
      looks like news. Dropped, always, and counted.
    * **A repeated timestamp.** Two rows for one bucket are one bucket. Kept
      first-wins rather than last-wins because the series is sorted ascending and
      a stable choice is what makes the two paths agree; either way a duplicate
      must not become a return of its own, which is what it would be if both
      copies survived — a spurious zero return, dragging the volatility down.
    * **Non-positive closes.** A log return needs a positive price, and a zero
      close is a gap in the feed rather than a market at zero.
    * **Missing buckets.** Not dropped — they cannot be, they are not there — but
      counted here and refused as return boundaries downstream.
    """
    notes: list[str] = []
    dated = [(int(row[0]), row) for row in rows if len(row) >= 6]
    zeroed = [ts for ts, _ in dated if ts <= 0]
    if zeroed:
        notes.append(f"dropped {len(zeroed)} candle(s) with a non-positive timestamp")
    dated = sorted(((ts, row) for ts, row in dated if ts > 0), key=lambda pair: pair[0])
    if dated:
        dated.pop()  # the forming bucket
        notes.append("dropped the newest candle: still forming")

    unique: list[tuple[int, Sequence[float]]] = []
    duplicates = 0
    for ts, row in dated:
        if unique and unique[-1][0] == ts:
            duplicates += 1
            continue
        unique.append((ts, row))
    if duplicates:
        notes.append(f"dropped {duplicates} candle(s) with a duplicate timestamp")

    series: list[tuple[int, float]] = []
    for ts, row in unique:
        close = as_float(row[4])
        if close is not None and close > 0:
            series.append((ts, close))
    dropped = len(unique) - len(series)
    if dropped:
        notes.append(f"dropped {dropped} candle(s) with an unusable close")

    skipped = _gap_count(series, step_ms)
    if skipped:
        notes.append(
            f"{skipped} gap(s) in the series: the return across each is not one "
            f"bucket and was skipped"
        )
    return series, notes


def _gap_count(series: Sequence[tuple[int, float]], step_ms: int) -> int:
    """Adjacent pairs that are not exactly one bucket apart."""
    return sum(
        1
        for (first, _), (second, _) in zip(series, series[1:])
        if second - first != step_ms
    )


def realized_vol_pct(series: Sequence[tuple[int, float]], step_ms: int) -> float | None:
    """Annualised realized volatility, in percent, or ``None``.

    The convention, in full, because every part of it is a choice: the sample
    standard deviation (n−1) of close-to-close **simple** returns over adjacent
    buckets, about their own mean, scaled by the square root of the number of
    buckets in a 365-day year.

    **Only adjacent buckets.** A pair whose timestamps are not exactly
    ``step_ms`` apart spans a gap, and the move across it took longer than one
    bucket. Annualising it with this timeframe's step would scale a 10-minute
    move as though it were a 5-minute one — inflating the figure, silently, on
    the one input nobody inspects. Such a pair contributes no return, rather than
    a wrong one. `_closes` counts them and says so in the notes.

    Returns ``None`` rather than a small number when there are fewer than two
    returns to work with. A standard deviation of one sample is zero, and a
    volatility of zero reported next to a real one is worse than a blank.
    """
    if step_ms <= 0:
        return None
    returns = [
        (later - earlier) / earlier
        for (first, earlier), (second, later) in zip(series, series[1:])
        if second - first == step_ms
    ]
    if len(returns) < 2:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    per_year = YEAR_MS / step_ms
    return math.sqrt(variance) * math.sqrt(per_year) * 100


def _flow(trades: Sequence[dict[str, Any]]) -> tuple[float | None, int, list[str]]:
    """Taker buy share by base amount, over the trades that came back.

    Nothing here indexes the list. The adapter documents ``fetch_trades`` as
    **newest first**, which is the reverse of CCXT's ascending convention, so
    ``trades[-1]`` is the *oldest* trade rather than the latest one. It is also
    the server's order passed through unchanged rather than something the
    adapter imposes, so it is not a thing to rely on either way — a sum over the
    whole list does not care, and that is why the figure is a sum.
    """
    notes: list[str] = []
    buy = 0.0
    total = 0.0
    used = 0
    unknown_side = 0
    for trade in trades:
        amount = as_float(trade.get("amount"))
        side = trade.get("side")
        if amount is None or amount <= 0:
            continue
        if side not in ("buy", "sell"):
            unknown_side += 1
            continue
        total += amount
        used += 1
        if side == "buy":
            buy += amount
    if unknown_side:
        notes.append(f"skipped {unknown_side} trade(s) with an unrecognised side")
    if total <= 0:
        return None, used, notes
    return buy / total, used, notes


def scan_market(
    exchange: NexusExchange,
    symbol: str,
    ticker: dict[str, Any] | None,
    market: dict[str, Any] | None,
    timeframe: str,
    candle_limit: int,
    trade_limit: int,
    depth_bps: float,
) -> Scan:
    """Every figure for one market, through the unified surface only."""
    notes: list[str] = []
    tick_size = None
    if market is not None:
        precision = market.get("precision")
        if isinstance(precision, dict):
            tick_size = as_float(precision.get("price"))
    last = change_pct = None
    if ticker is None:
        notes.append("no ticker: absent from fetch_tickers")
    else:
        last = as_float(ticker.get("last"))
        change_pct = as_float(ticker.get("percentage"))

    book = exchange.fetch_order_book(symbol)
    spread_bps, depth_quote, book_notes = _book_figures(book, depth_bps)
    notes.extend(book_notes)

    # `timeframe` is validated by the adapter, which raises `ValueError` on
    # anything outside its four-entry table. That is worth knowing because the
    # native client does *not*: it forwards the string, and this venue answers an
    # unsupported timeframe with the 1m series and no indication it substituted.
    # Here, then, the unified layer is the safer of the two.
    rows = exchange.fetch_ohlcv(symbol, timeframe, limit=candle_limit)
    step_ms = STEP_MS[timeframe]
    closes, candle_notes = _closes(rows, step_ms)
    notes.extend(candle_notes)
    rvol_pct = realized_vol_pct(closes, step_ms)

    trades = exchange.fetch_trades(symbol, limit=trade_limit)
    taker_buy_share, trades_used, trade_notes = _flow(trades)
    notes.extend(trade_notes)

    return Scan(
        symbol=symbol,
        last=last,
        change_pct=change_pct,
        spread_bps=spread_bps,
        depth_quote=depth_quote,
        rvol_pct=rvol_pct,
        taker_buy_share=taker_buy_share,
        candles_used=len(closes),
        trades_used=trades_used,
        tick_size=tick_size,
        notes=notes,
    )


def scan(
    exchange: NexusExchange,
    symbols: Sequence[str],
    timeframe: str,
    candle_limit: int,
    trade_limit: int,
    depth_bps: float = DEFAULT_DEPTH_BPS,
) -> list[Scan]:
    """Scan every symbol, one ``fetch_tickers`` call plus three per market.

    ``fetch_tickers`` rather than a ``fetch_ticker`` per market, which is the
    N+1 a port inherits for free: CCXT-shaped code usually loops over symbols
    calling ``fetch_ticker``, and the adapter offers the batch form. The
    filtering is client-side either way — ``fetch_tickers`` fetches the whole
    venue and then selects — so this is one request instead of N, not less data
    off the wire.

    ``load_markets`` is called for its cache, which is the one piece of state
    the adapter keeps: the first call fetches, every later call returns the same
    dict, and ``reload=True`` is the only way to refetch. Measured — a second
    ``load_markets()`` makes no request at all. A long-running port that never
    reloads will keep trading against a market list from process start.
    """
    markets = exchange.load_markets()
    tickers = exchange.fetch_tickers(list(symbols))
    return [
        scan_market(
            exchange, symbol, tickers.get(symbol), markets.get(symbol), timeframe,
            candle_limit, trade_limit, depth_bps,
        )
        for symbol in symbols
    ]
