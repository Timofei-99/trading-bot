from __future__ import annotations

from datetime import datetime, timezone

import pytest

from core.signal import Direction, Signal


def make_long_signal(entry: float, stop_loss: float, take_profit: float) -> Signal:
    return Signal(
        symbol="BTC/USDT",
        direction=Direction.LONG,
        entry=entry,
        stop_loss=stop_loss,
        take_profit=take_profit,
        timeframe="1h",
        timestamp=datetime(2024, 1, 1, tzinfo=timezone.utc),
        strategy_name="test",
        strategy_version="1.0",
    )


def make_short_signal(entry: float, stop_loss: float, take_profit: float) -> Signal:
    return Signal(
        symbol="BTC/USDT",
        direction=Direction.SHORT,
        entry=entry,
        stop_loss=stop_loss,
        take_profit=take_profit,
        timeframe="1h",
        timestamp=datetime(2024, 1, 1, tzinfo=timezone.utc),
        strategy_name="test",
        strategy_version="1.0",
    )


def test_risk_amount_long():
    s = make_long_signal(entry=100.0, stop_loss=90.0, take_profit=130.0)
    assert s.risk_amount == 10.0


def test_risk_amount_short():
    s = make_short_signal(entry=100.0, stop_loss=110.0, take_profit=70.0)
    assert s.risk_amount == 10.0


def test_reward_amount_long():
    s = make_long_signal(entry=100.0, stop_loss=90.0, take_profit=130.0)
    assert s.reward_amount == 30.0


def test_reward_amount_short():
    s = make_short_signal(entry=100.0, stop_loss=110.0, take_profit=70.0)
    assert s.reward_amount == 30.0


def test_risk_reward_long():
    s = make_long_signal(entry=100.0, stop_loss=90.0, take_profit=130.0)
    assert s.risk_reward == pytest.approx(3.0)


def test_risk_reward_short():
    s = make_short_signal(entry=100.0, stop_loss=110.0, take_profit=70.0)
    assert s.risk_reward == pytest.approx(3.0)


def test_risk_reward_is_positive():
    s = make_long_signal(entry=100.0, stop_loss=95.0, take_profit=120.0)
    assert s.risk_reward > 0
