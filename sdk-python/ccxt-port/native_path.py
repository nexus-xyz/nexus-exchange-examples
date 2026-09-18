"""The same scan, on the native SDK.

Field for field and formula for formula, this is `ccxt_path.py`. What differs is
everything around the arithmetic:

* values arrive as :class:`~decimal.Decimal`, carrying the digits the venue
  actually sent, and stay that way;
* a book level is a :class:`~nexus_exchange.PriceLevel` with named ``price`` and
  ``amount``, not a two-element list;
* a candle is an :class:`~nexus_exchange.Ohlcv` with named fields, not a
  six-element row;
* the types are checked, so a typo in a field name is a build error rather than
  a ``None`` that turns into a blank column;
* and three things exist here that the unified structures have no place for at
  all — the exact tick size, the maintenance margin rate, and whether a trade
  was a liquidation.

The last point is the one that decides when to drop down. Everything else is
ergonomics; that one is information.

One place the native client is **worse**, and it is worth knowing before you
port anything: :meth:`Client.fetch_ohlcv` forwards ``timeframe`` to the API
without checking it, and this venue answers an unsupported value with the 1m
series and no indication it substituted. The adapter raises instead. So this
module has to repeat the check the adapter gives away free — see
:func:`check_timeframe`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, DivisionByZero, InvalidOperation, localcontext
from typing import Sequence

from nexus_exchange import Client, Market, Ohlcv, OrderBook, Ticker, Trade

from ccxt_path import STEP_MS, YEAR_MS

#: Working precision for the volatility calculation.
#:
#: `Decimal`'s default context is 28 significant digits, which is plenty for
#: money but tight once a variance has squared its inputs and a square root has
#: to come back out. Widened locally rather than globally, so nothing else in
#: the process inherits a context this module chose.
VOL_PRECISION = 50

_BPS = Decimal(10_000)
_TWO = Decimal(2)


@dataclass(frozen=True, slots=True)
class NativeScan:
    """One market's figures, plus the three the unified layer cannot carry."""

    symbol: str
    last: Decimal | None
    change_pct: Decimal | None
    spread_bps: Decimal | None
    depth_quote: Decimal | None
    rvol_pct: Decimal | None
    taker_buy_share: Decimal | None
    candles_used: int
    trades_used: int
    #: Exact, from `Market.tick_size`. The unified market dict has this as a
    #: `float` under `precision.price` — see `parity.py` for why that is not the
    #: same thing, and not what CCXT's `precision` normally means either.
    tick_size: Decimal | None
    #: Not present anywhere in the unified market structure. It survives inside
    #: `market["info"]`, which is the raw payload, so reaching it from the CCXT
    #: path means leaving the unified layer.
    maintenance_margin_rate: Decimal | None
    #: From `Trade.is_liquidation`. The unified trade dict has no field for it.
    liquidation_trades: int = 0
    notes: list[str] = field(default_factory=list)


def check_timeframe(timeframe: str) -> None:
    """Refuse a timeframe the venue does not serve, before asking for it.

    The adapter does this for you and this module has to do it by hand, which is
    a real point in the unified layer's favour rather than a formality. Asking
    the native client for ``1d`` returns a **one-minute** series on this
    deployment — no error, no field saying so — and every figure derived from it
    is then mislabelled rather than merely noisy.
    """
    if timeframe not in STEP_MS:
        raise ValueError(
            f"timeframe {timeframe!r} not supported; choose one of {sorted(STEP_MS)}. "
            f"The native client would forward it and the venue would answer with "
            f"the 1m series instead, silently."
        )


def _book_figures(
    book: OrderBook, depth_bps: Decimal
) -> tuple[Decimal | None, Decimal | None, list[str]]:
    notes: list[str] = []
    bids = [level for level in book.bids if level.price > 0 and level.amount > 0]
    asks = [level for level in book.asks if level.price > 0 and level.amount > 0]
    if not bids or not asks:
        notes.append("empty book side — no spread or depth")
        return None, None, notes

    best_bid = max(level.price for level in bids)
    best_ask = min(level.price for level in asks)
    if best_ask <= best_bid:
        notes.append(f"crossed book: bid {best_bid} >= ask {best_ask}")
        return None, None, notes

    mid = (best_bid + best_ask) / _TWO
    spread_bps = (best_ask - best_bid) / mid * _BPS
    window = mid * depth_bps / _BPS
    depth = sum(
        (level.price * level.amount for level in bids if level.price >= mid - window),
        Decimal(0),
    ) + sum(
        (level.price * level.amount for level in asks if level.price <= mid + window),
        Decimal(0),
    )
    return spread_bps, depth, notes


def _closes(candles: Sequence[Ohlcv]) -> tuple[list[Decimal], list[str]]:
    """The same three refusals as the CCXT path, over named fields.

    Identical logic, and deliberately so: if this dropped a different set of
    candles the parity report would be measuring this module's opinions rather
    than the two APIs.
    """
    notes: list[str] = []
    zeroed = [c for c in candles if c.timestamp <= 0]
    if zeroed:
        notes.append(f"dropped {len(zeroed)} candle(s) with a non-positive timestamp")
    usable = sorted(
        (c for c in candles if c.timestamp > 0), key=lambda c: c.timestamp
    )
    if usable:
        usable.pop()  # the forming bucket
        notes.append("dropped the newest candle: still forming")

    closes = [c.close for c in usable if c.close > 0]
    dropped = len(usable) - len(closes)
    if dropped:
        notes.append(f"dropped {dropped} candle(s) with an unusable close")
    return closes, notes


def realized_vol_pct(closes: Sequence[Decimal], step_ms: int) -> Decimal | None:
    """`ccxt_path.realized_vol_pct`, in exact decimal arithmetic.

    Same convention, stated once there and not restated here so the two cannot
    drift: sample standard deviation (n−1) of close-to-close simple returns over
    adjacent buckets, no mean adjustment, scaled to a 365-day year.

    The division and the square root are the only inexact steps, and both happen
    inside a widened context. A returned value is therefore correct to far more
    digits than the float path can represent — which is the entire point of
    computing it twice.
    """
    if len(closes) < 3 or step_ms <= 0:
        return None
    with localcontext() as ctx:
        ctx.prec = VOL_PRECISION
        try:
            returns = [
                (later - earlier) / earlier
                for earlier, later in zip(closes, closes[1:])
            ]
            if len(returns) < 2:
                return None
            mean = sum(returns, Decimal(0)) / len(returns)
            variance = sum(((r - mean) ** 2 for r in returns), Decimal(0)) / (
                len(returns) - 1
            )
            per_year = Decimal(YEAR_MS) / Decimal(step_ms)
            return variance.sqrt() * per_year.sqrt() * 100
        except (InvalidOperation, DivisionByZero):
            # A close of zero slipped through, or the context overflowed. Either
            # way the answer is "no figure", never a number nobody can stand
            # behind.
            return None


def _flow(trades: Sequence[Trade]) -> tuple[Decimal | None, int, int, list[str]]:
    """Taker buy share, plus the liquidation count the unified layer drops.

    ``side`` is lower-cased here, and that is not tidiness. ``Trade.from_dict``
    keeps whatever string the venue sent (``side=str(d.get("side", ""))``),
    while the adapter lower-cases it on the way out. So a venue that sends
    ``"BUY"`` gives the CCXT path ``"buy"`` and this path ``"BUY"``, and a
    native port that compares against ``"buy"`` counts every buy as an
    unrecognised side — a zero flow figure, no error. The normalisation is one
    of the things the unified layer really does do for you.
    """
    notes: list[str] = []
    buy = Decimal(0)
    total = Decimal(0)
    used = 0
    liquidations = 0
    unknown_side = 0
    for trade in trades:
        if trade.amount <= 0:
            continue
        side = trade.side.strip().lower()
        if side not in ("buy", "sell"):
            unknown_side += 1
            continue
        total += trade.amount
        used += 1
        if trade.is_liquidation:
            liquidations += 1
        if side == "buy":
            buy += trade.amount
    if unknown_side:
        notes.append(f"skipped {unknown_side} trade(s) with an unrecognised side")
    if total <= 0:
        return None, used, liquidations, notes
    return buy / total, used, liquidations, notes


def scan_market(
    client: Client,
    symbol: str,
    ticker: Ticker | None,
    market: Market | None,
    timeframe: str,
    candle_limit: int,
    trade_limit: int,
    depth_bps: Decimal,
) -> NativeScan:
    """Every figure for one market, through the typed client."""
    check_timeframe(timeframe)
    notes: list[str] = []
    last = change_pct = None
    if ticker is None:
        notes.append("no ticker: absent from fetch_tickers")
    else:
        last = ticker.last
        change_pct = ticker.percentage

    book = client.fetch_order_book(symbol)
    spread_bps, depth_quote, book_notes = _book_figures(book, depth_bps)
    notes.extend(book_notes)

    candles = client.fetch_ohlcv(symbol, timeframe, limit=candle_limit)
    closes, candle_notes = _closes(candles)
    notes.extend(candle_notes)
    rvol_pct = realized_vol_pct(closes, STEP_MS[timeframe])

    trades = client.fetch_trades(symbol, limit=trade_limit)
    taker_buy_share, trades_used, liquidations, trade_notes = _flow(trades)
    notes.extend(trade_notes)

    return NativeScan(
        symbol=symbol,
        last=last,
        change_pct=change_pct,
        spread_bps=spread_bps,
        depth_quote=depth_quote,
        rvol_pct=rvol_pct,
        taker_buy_share=taker_buy_share,
        candles_used=len(closes),
        trades_used=trades_used,
        tick_size=market.tick_size if market is not None else None,
        maintenance_margin_rate=(
            market.maintenance_margin_rate if market is not None else None
        ),
        liquidation_trades=liquidations,
        notes=notes,
    )


def scan(
    client: Client,
    symbols: Sequence[str],
    markets: dict[str, Market],
    timeframe: str,
    candle_limit: int,
    trade_limit: int,
    depth_bps: Decimal,
) -> list[NativeScan]:
    """Scan every symbol: one ``fetch_tickers`` call plus three per market.

    Exactly the request pattern `ccxt_path.scan` makes, on purpose. The two
    halves have to cost the same number of round-trips or the comparison would
    be reading data from different moments and calling the difference an API
    difference.
    """
    tickers = client.fetch_tickers()
    return [
        scan_market(
            client, symbol, tickers.get(symbol), markets.get(symbol), timeframe,
            candle_limit, trade_limit, depth_bps,
        )
        for symbol in symbols
    ]
