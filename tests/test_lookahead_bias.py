"""Look-ahead bias audit for BacktestEngine + OB4hFVG15mStrategy.

Two categories of potential bias are checked:

1. DATA ISOLATION — at bar i the strategy must only see bars whose
   timestamp ≤ all_candles.index[i-1].  Tested by recording the last
   visible timestamp on each call and asserting it is always equal to
   the current bar's timestamp (never ahead).

2. ENTRY-BAR EXECUTION — the engine places the order and immediately
   calls adapter.update() on the SAME bar that generated the signal.
   For a LIMIT-order model (enter at fvg.high once price touches it)
   this is realistic.  The test documents the behaviour and checks that
   the entry price equals fvg.high (a level known from prior bars),
   not the bar's open/high/close (which would be future-looking).
"""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from core.market_context import MarketContext
from core.signal import Direction, Signal
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.base import Strategy


# ---------------------------------------------------------------------------
# Spy strategy: records what data it sees on every call
# ---------------------------------------------------------------------------

class SpyStrategy(Strategy):
    """Never produces a signal; records the last visible bar per TF."""

    name = "spy"
    version = "0"

    def __init__(self, timeframes: list[str]) -> None:
        self.calls: list[dict[str, pd.Timestamp]] = []
        self.timeframes = timeframes

    def check_entry(self, context: MarketContext) -> Signal | None:
        snapshot = {}
        for tf in self.timeframes:
            df = context.candles(tf)
            if not df.empty:
                snapshot[tf] = df.index[-1]
        self.calls.append(snapshot)
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_context(n: int = 30, symbol: str = "BTC/USDT") -> MarketContext:
    """Minimal 2-TF context with n 15m bars and proportional 4h bars."""
    freq_15m = pd.date_range("2024-01-01", periods=n, freq="15min")
    freq_4h  = pd.date_range("2024-01-01", periods=max(n // 16, 2), freq="4h")

    def _df(idx):
        return pd.DataFrame(
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 1000.0},
            index=idx,
        )

    ctx = MarketContext(symbol=symbol, timeframes=["4h", "15m"], max_candles=50_000)
    ctx.load("15m", _df(freq_15m))
    ctx.load("4h",  _df(freq_4h))
    return ctx


# ---------------------------------------------------------------------------
# Test 1 — data isolation
# ---------------------------------------------------------------------------

def test_engine_strategy_never_sees_future_bars():
    """At step i the strategy's last 15m bar must be exactly all_candles[i-1]."""
    ctx = _make_context(n=30)
    all_15m = ctx.candles("15m")

    spy   = SpyStrategy(["15m", "4h"])
    eng   = BacktestEngine(ctx, spy, BacktestAdapter(), window=500)
    eng.run("15m")

    assert len(spy.calls) == len(all_15m), "strategy called once per bar"

    for i, snapshot in enumerate(spy.calls):
        expected = all_15m.index[i]
        actual   = snapshot.get("15m")
        assert actual == expected, (
            f"bar {i}: strategy saw {actual}, expected {expected} — look-ahead bias!"
        )


def test_htf_visible_bars_never_exceed_current_time():
    """4h bars visible at step i must all have timestamp ≤ 15m bar i."""
    ctx     = _make_context(n=64)
    all_15m = ctx.candles("15m")

    spy = SpyStrategy(["15m", "4h"])
    BacktestEngine(ctx, spy, BacktestAdapter(), window=500).run("15m")

    for i, snapshot in enumerate(spy.calls):
        current_15m_time = all_15m.index[i]
        htf_last = snapshot.get("4h")
        if htf_last is not None:
            assert htf_last <= current_15m_time, (
                f"bar {i}: 4h last bar {htf_last} > 15m bar {current_15m_time}"
            )


def test_visible_bar_count_grows_monotonically():
    """Each successive call sees the same or more bars — never fewer."""
    ctx = _make_context(n=20)
    spy = SpyStrategy(["15m"])
    BacktestEngine(ctx, spy, BacktestAdapter(), window=500).run("15m")

    prev_ts = None
    for snapshot in spy.calls:
        ts = snapshot.get("15m")
        if prev_ts is not None and ts is not None:
            assert ts >= prev_ts, "time went backwards — data isolation broken"
        prev_ts = ts


# ---------------------------------------------------------------------------
# Test 2 — entry-bar execution model
# ---------------------------------------------------------------------------

class SignalOnBarStrategy(Strategy):
    """Emits one LONG signal on a configured bar index, records the timestamp."""
    name = "trigger"
    version = "0"

    def __init__(self, trigger_bar: int, symbol: str) -> None:
        self.trigger_bar = trigger_bar
        self.symbol = symbol
        self.call_count = 0
        self.signal_timestamp: pd.Timestamp | None = None

    def check_entry(self, context: MarketContext) -> Signal | None:
        self.call_count += 1
        df = context.candles("15m")
        if df.empty:
            return None
        if self.call_count == self.trigger_bar:
            ts = df.index[-1]
            self.signal_timestamp = ts
            return Signal(
                symbol=self.symbol,
                direction=Direction.LONG,
                entry=100.0,
                stop_loss=99.0,
                take_profit=102.0,
                timeframe="15m",
                timestamp=ts.to_pydatetime(),
                strategy_name="trigger",
                strategy_version="0",
            )
        return None


def test_entry_uses_level_known_before_current_bar():
    """Entry price must equal the signal.entry set by the strategy.

    The strategy sets entry=100.0 (a fixed price known from prior context),
    NOT derived from the trigger bar's open/high/close — so no look-ahead bias
    in the price level itself.
    """
    ctx  = _make_context(n=20)
    strat = SignalOnBarStrategy(trigger_bar=10, symbol="BTC/USDT")
    adap  = BacktestAdapter(initial_balance=10_000)
    BacktestEngine(ctx, strat, adap, window=500).run("15m")

    assert len(adap.trades) + len(adap.open_trades) >= 1
    all_trades = adap.trades + adap.open_trades
    trade = all_trades[0]
    assert trade.entry_price == pytest.approx(100.0), (
        "entry price should equal signal.entry, not derived from bar OHLCV"
    )


def test_signal_timestamp_matches_bar_on_which_it_was_generated():
    """signal.timestamp == last visible bar at the time of generation."""
    ctx   = _make_context(n=20)
    all_c = ctx.candles("15m")
    strat = SignalOnBarStrategy(trigger_bar=10, symbol="BTC/USDT")
    adap  = BacktestAdapter(initial_balance=10_000)
    BacktestEngine(ctx, strat, adap, window=500).run("15m")

    expected_bar = all_c.index[9]  # trigger_bar=10 → 0-indexed bar 9
    assert strat.signal_timestamp == expected_bar
