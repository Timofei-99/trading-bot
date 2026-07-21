from __future__ import annotations

from datetime import datetime, timezone

import pytest

from core.signal import Direction, Signal
from execution.backtest_adapter import BacktestAdapter


def make_signal(
    direction: Direction = Direction.LONG,
    entry: float = 100.0,
    stop_loss: float = 90.0,
    take_profit: float = 130.0,
) -> Signal:
    return Signal(
        symbol="BTC/USDT",
        direction=direction,
        entry=entry,
        stop_loss=stop_loss,
        take_profit=take_profit,
        timeframe="1h",
        timestamp=datetime(2024, 1, 1, tzinfo=timezone.utc),
        strategy_name="test",
        strategy_version="1.0",
    )


def test_place_order_creates_open_trade():
    adapter = BacktestAdapter()
    signal = make_signal()
    order_id = adapter.place_order(signal)
    assert adapter.get_position("BTC/USDT") is not None
    assert len(adapter.open_trades) == 1
    assert len(adapter.trades) == 0


def test_update_closes_trade_on_tp_hit_long():
    adapter = BacktestAdapter()
    signal = make_signal(direction=Direction.LONG, entry=100.0, stop_loss=90.0, take_profit=130.0)
    adapter.place_order(signal)
    adapter.update("BTC/USDT", candle_high=135.0, candle_low=105.0, candle_time=datetime(2024, 1, 2, tzinfo=timezone.utc))
    assert len(adapter.trades) == 1
    assert adapter.trades[0].exit_reason == "tp"
    assert adapter.trades[0].exit_price == 130.0


def test_update_closes_trade_on_sl_hit_long():
    adapter = BacktestAdapter()
    signal = make_signal(direction=Direction.LONG, entry=100.0, stop_loss=90.0, take_profit=130.0)
    adapter.place_order(signal)
    adapter.update("BTC/USDT", candle_high=105.0, candle_low=85.0, candle_time=datetime(2024, 1, 2, tzinfo=timezone.utc))
    assert len(adapter.trades) == 1
    assert adapter.trades[0].exit_reason == "sl"
    assert adapter.trades[0].exit_price == 90.0


def test_tp_priority_over_sl_same_candle():
    adapter = BacktestAdapter()
    signal = make_signal(direction=Direction.LONG, entry=100.0, stop_loss=90.0, take_profit=130.0)
    adapter.place_order(signal)
    adapter.update("BTC/USDT", candle_high=135.0, candle_low=85.0, candle_time=datetime(2024, 1, 2, tzinfo=timezone.utc))
    assert len(adapter.trades) == 1
    assert adapter.trades[0].exit_reason == "tp"


def test_report_correct_win_rate():
    adapter = BacktestAdapter()

    win_signal = make_signal(direction=Direction.LONG, entry=100.0, stop_loss=90.0, take_profit=130.0)
    adapter.place_order(win_signal)
    adapter.update("BTC/USDT", candle_high=135.0, candle_low=105.0, candle_time=datetime(2024, 1, 2, tzinfo=timezone.utc))

    loss_signal = make_signal(direction=Direction.LONG, entry=100.0, stop_loss=90.0, take_profit=130.0)
    adapter.place_order(loss_signal)
    adapter.update("BTC/USDT", candle_high=105.0, candle_low=85.0, candle_time=datetime(2024, 1, 3, tzinfo=timezone.utc))

    report = adapter.report()
    assert report["total_trades"] == 2
    assert report["winners"] == 1
    assert report["losers"] == 1
    assert report["win_rate"] == pytest.approx(0.5)
