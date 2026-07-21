from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from core.market_context import MarketContext
from core.signal import Direction
from strategies.frankfurt_ib_50 import FrankfurtIB50Strategy


SYMBOL = "FDAX"

# 08:00 Berlin winter == 07:00 UTC ; 09:00 Berlin == 08:00 UTC ;
# 10:00 Berlin (session end) == 09:00 UTC.


def make_candles(
    highs: list[float],
    lows: list[float],
    closes: list[float] | None = None,
    start_utc: str = "2024-01-15 06:00",
) -> pd.DataFrame:
    """Build 1m OHLC bars starting at start_utc.

    open = close = provided close (or (high+low)/2); volume = 1.
    """
    assert len(highs) == len(lows)
    n = len(highs)
    idx = pd.date_range(start_utc, periods=n, freq="1min", tz="UTC")
    if closes is None:
        closes = [(h + l) / 2 for h, l in zip(highs, lows)]
    return pd.DataFrame(
        {
            "open":   closes,
            "high":   highs,
            "low":    lows,
            "close":  closes,
            "volume": [1.0] * n,
        },
        index=idx,
    )


def make_context(df: pd.DataFrame) -> MarketContext:
    ctx = MarketContext(symbol=SYMBOL, timeframes=["1m"], max_candles=10_000)
    ctx.load("1m", df)
    return ctx


# ---------------------------------------------------------------------------
# Timing gates
# ---------------------------------------------------------------------------


def test_no_signal_before_ib_ends():
    """During IB window (07:00–07:59 UTC == 08:00–08:59 Berlin) no entry."""
    df = make_candles(
        highs=[100.0] * 30 + [110.0] * 30,
        lows=[95.0] * 30 + [90.0] * 30,
        closes=[97.5] * 30 + [100.0] * 30,
        start_utc="2024-01-15 06:00",
    )
    # Cut off inside the IB window (08:30 Berlin == 07:30 UTC → 91 bars total,
    # but the last visible bar is at 07:30 UTC)
    df = df.loc[df.index <= "2024-01-15 07:30"]
    ctx = make_context(df)
    strat = FrankfurtIB50Strategy()
    assert strat.check_entry(ctx) is None


def test_no_signal_after_session_end():
    """After 10:00 Berlin (== 09:00 UTC) — entry cut off even on valid cross."""
    df = make_candles(
        highs=[100.0] * 60 + [200.0] * 121,  # push high above mid mid-way
        lows=[90.0] * 60 + [100.0] * 121,
        closes=[95.0] * 60 + [150.0] * 121,
        start_utc="2024-01-15 06:00",
    )
    ctx = make_context(df)
    strat = FrankfurtIB50Strategy()
    # Walk bar-by-bar: since the cross happens at bar 60 (08:00 UTC, 09:00 Berlin)
    # we'll get a signal.  Skip to after session end (09:00 UTC) and confirm none.
    late_ctx = MarketContext(symbol=SYMBOL, timeframes=["1m"], max_candles=10_000)
    late_ctx.load("1m", df.loc[df.index >= "2024-01-15 09:00"])
    strat_late = FrankfurtIB50Strategy()
    assert strat_late.check_entry(late_ctx) is None


# ---------------------------------------------------------------------------
# Cross triggers entry
# ---------------------------------------------------------------------------


def test_long_signal_on_upward_cross_of_mid():
    """IB high=105, low=95 → mid=100.  After IB, close moves from 99 to 101."""
    # Bars 0..59 = IB (07:00–07:59 UTC == 08:00–08:59 Berlin, winter)
    # Bar 60 at 08:00 UTC == 09:00 Berlin, first post-IB bar → cross candle
    highs  = [105.0] * 60 + [102.0]
    lows   = [ 95.0] * 60 + [ 99.0]
    closes = [100.0] * 59 + [99.0, 101.0]
    df = make_candles(highs, lows, closes, start_utc="2024-01-15 07:00")
    ctx = make_context(df)

    strat = FrankfurtIB50Strategy()
    signal = strat.check_entry(ctx)

    assert signal is not None
    assert signal.direction is Direction.LONG
    assert signal.entry == pytest.approx(101.0)
    assert signal.meta["ib_high"] == pytest.approx(105.0)
    assert signal.meta["ib_low"] == pytest.approx(95.0)
    assert signal.meta["ib_mid"] == pytest.approx(100.0)
    assert signal.take_profit == pytest.approx(115.0)
    assert signal.stop_loss <= signal.entry
    assert signal.expiry_time == datetime(2024, 1, 15, 9, 0, tzinfo=timezone.utc)


def test_short_signal_on_downward_cross_of_mid():
    highs  = [105.0] * 60 + [100.0]
    lows   = [ 95.0] * 60 + [ 98.0]
    closes = [100.0] * 59 + [101.0, 99.0]
    df = make_candles(highs, lows, closes, start_utc="2024-01-15 07:00")
    ctx = make_context(df)

    signal = FrankfurtIB50Strategy().check_entry(ctx)
    assert signal is not None
    assert signal.direction is Direction.SHORT
    assert signal.entry == pytest.approx(99.0)
    assert signal.take_profit == pytest.approx(85.0)
    assert signal.stop_loss >= signal.entry


def test_no_signal_when_close_stays_on_same_side_of_mid():
    """Both post-IB closes stay below mid — no cross, no signal."""
    highs  = [105.0] * 60 + [98.0]
    lows   = [ 95.0] * 60 + [96.0]
    closes = [100.0] * 59 + [97.0, 98.0]
    df = make_candles(highs, lows, closes, start_utc="2024-01-15 07:00")
    ctx = make_context(df)
    assert FrankfurtIB50Strategy().check_entry(ctx) is None


# ---------------------------------------------------------------------------
# One entry per session
# ---------------------------------------------------------------------------


def test_second_call_after_entry_returns_none():
    """After a valid entry, the same strategy instance does not fire again."""
    highs  = [105.0] * 60 + [102.0, 103.0]
    lows   = [ 95.0] * 60 + [ 99.0, 100.5]
    closes = [100.0] * 59 + [99.0, 101.0, 102.0]  # cross at bar 60
    df = make_candles(highs, lows, closes, start_utc="2024-01-15 07:00")

    strat = FrankfurtIB50Strategy()

    ctx1 = make_context(df.iloc[:61])   # bars 0..60 — cross at bar 60
    assert strat.check_entry(ctx1) is not None

    ctx2 = make_context(df)             # bars 0..61
    assert strat.check_entry(ctx2) is None


# ---------------------------------------------------------------------------
# Session TZ / DST behaviour
# ---------------------------------------------------------------------------


def test_summer_session_uses_0600_utc():
    """08:00 Berlin CEST (July) == 06:00 UTC."""
    highs = [105.0] * 60 + [99.0, 101.0]
    lows  = [ 95.0] * 60 + [98.0, 100.0]
    closes = [100.0] * 60 + [99.0, 101.0]
    # Start at 05:00 UTC (07:00 Berlin CEST) so bar 60 is at 06:00 UTC (08:00 Berlin CEST)?
    # Actually we need bar 60 to be at 07:00 UTC == 09:00 Berlin CEST (post-IB).
    # IB in summer: 06:00–06:59 UTC.  So start at 06:00 UTC → 60 bars → bar 60 at 07:00 UTC.
    df = make_candles(highs, lows, closes, start_utc="2024-07-15 05:00")

    strat = FrankfurtIB50Strategy()
    # Only supply candles up to bar 62 to trigger cross at last bar; but we need
    # start = 06:00 UTC.  Rebuild:
    highs = [105.0] * 60 + [99.0, 101.0]
    lows  = [ 95.0] * 60 + [98.0, 100.0]
    closes = [100.0] * 60 + [99.0, 101.0]
    df = make_candles(highs, lows, closes, start_utc="2024-07-15 06:00")
    ctx = make_context(df)
    signal = strat.check_entry(ctx)
    assert signal is not None
    assert signal.direction is Direction.LONG
    # 10:00 Berlin CEST == 08:00 UTC
    assert signal.expiry_time == datetime(2024, 7, 15, 8, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Construction validation
# ---------------------------------------------------------------------------


def test_invalid_session_ordering_rejected():
    with pytest.raises(ValueError):
        FrankfurtIB50Strategy(session_start="10:00", session_end="09:00")


def test_ib_extends_past_session_end_rejected():
    with pytest.raises(ValueError):
        FrankfurtIB50Strategy(
            session_start="08:00", ib_duration_minutes=180, session_end="09:00"
        )
