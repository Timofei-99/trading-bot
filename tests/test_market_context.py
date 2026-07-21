from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from core.market_context import MarketContext


def make_df(closes: list[float], start: datetime | None = None) -> pd.DataFrame:
    if start is None:
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    index = pd.date_range(start=start, periods=len(closes), freq="1min", tz="UTC")
    return pd.DataFrame(
        {
            "open": closes,
            "high": closes,
            "low": closes,
            "close": closes,
            "volume": [100.0] * len(closes),
        },
        index=index,
    )


def make_context(timeframes: list[str] | None = None) -> MarketContext:
    if timeframes is None:
        timeframes = ["1m", "1h"]
    return MarketContext(symbol="BTC/USDT", timeframes=timeframes, max_candles=500)


def test_load_and_candles():
    ctx = make_context(["1m"])
    df = make_df([100.0, 200.0])
    ctx.load("1m", df)
    result = ctx.candles("1m")
    assert len(result) == 2
    assert list(result["close"]) == [100.0, 200.0]


def test_candles_raises_for_unknown_timeframe():
    ctx = make_context(["1m"])
    with pytest.raises(KeyError):
        ctx.candles("4h")


def test_update_appends_new_candle():
    ctx = make_context(["1m"])
    df = make_df([100.0])
    ctx.load("1m", df)
    new_ts = datetime(2024, 1, 1, 0, 1, tzinfo=timezone.utc)
    ctx.update("1m", {"timestamp": new_ts, "open": 200.0, "high": 200.0, "low": 200.0, "close": 200.0, "volume": 10.0})
    result = ctx.candles("1m")
    assert len(result) == 2
    assert float(result["close"].iloc[-1]) == 200.0


def test_update_replaces_candle_with_same_timestamp():
    ctx = make_context(["1m"])
    ts = datetime(2024, 1, 1, tzinfo=timezone.utc)
    df = make_df([100.0])
    df.index = pd.DatetimeIndex([ts], tz="UTC", name="timestamp")
    ctx.load("1m", df)
    ctx.update("1m", {"timestamp": ts, "open": 999.0, "high": 999.0, "low": 999.0, "close": 999.0, "volume": 5.0})
    result = ctx.candles("1m")
    assert len(result) == 1
    assert float(result["close"].iloc[0]) == 999.0


def test_is_ready_false_when_empty():
    ctx = make_context(["1m", "1h"])
    assert ctx.is_ready() is False


def test_is_ready_true_when_all_loaded():
    ctx = make_context(["1m", "1h"])
    ctx.load("1m", make_df([100.0]))
    ctx.load("1h", make_df([100.0]))
    assert ctx.is_ready() is True


def test_is_ready_false_when_partially_loaded():
    ctx = make_context(["1m", "1h"])
    ctx.load("1m", make_df([100.0]))
    assert ctx.is_ready() is False


def test_last_price_returns_last_close_of_smallest_timeframe():
    ctx = make_context(["1m", "1h"])
    ctx.load("1m", make_df([100.0, 200.0, 300.0]))
    ctx.load("1h", make_df([500.0]))
    assert ctx.last_price() == 300.0


def test_last_price_none_when_no_data():
    ctx = make_context(["1m"])
    assert ctx.last_price() is None
