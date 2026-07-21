from __future__ import annotations

import uuid
from datetime import datetime

from core.signal import Direction, Signal
from execution.base import ExecutionAdapter, Trade


class BacktestAdapter(ExecutionAdapter):
    def __init__(self, initial_balance: float = 10000.0, risk_per_trade: float = 0.01) -> None:
        self.balance = initial_balance
        self.risk_per_trade = risk_per_trade
        self._open_positions: dict[str, Trade] = {}
        self._closed_trades: list[Trade] = []

    def place_order(self, signal: Signal) -> str:
        order_id = str(uuid.uuid4())
        size = (self.balance * self.risk_per_trade) / signal.risk_amount
        trade = Trade(
            signal=signal,
            order_id=order_id,
            entry_time=signal.timestamp,
            entry_price=signal.entry,
            position_size=size,
        )
        self._open_positions[signal.symbol] = trade
        return order_id

    def get_position(self, symbol: str) -> dict | None:
        trade = self._open_positions.get(symbol)
        if trade is None:
            return None
        return {
            "symbol": symbol,
            "order_id": trade.order_id,
            "entry_price": trade.entry_price,
            "position_size": trade.position_size,
            "direction": trade.signal.direction,
        }

    def close_position(self, symbol: str) -> None:
        trade = self._open_positions.get(symbol)
        if trade is None:
            return
        self._close_trade(symbol, trade.signal.stop_loss, datetime.utcnow(), "manual")

    def update(
        self,
        symbol: str,
        candle_high: float,
        candle_low: float,
        candle_time: datetime,
        candle_close: float | None = None,
    ) -> None:
        trade = self._open_positions.get(symbol)
        if trade is None:
            return

        sl = trade.signal.stop_loss
        tp = trade.signal.take_profit
        direction = trade.signal.direction

        if direction == Direction.LONG:
            hit_tp = candle_high >= tp
            hit_sl = candle_low <= sl
        else:
            hit_tp = candle_low <= tp
            hit_sl = candle_high >= sl

        if hit_tp:
            self._close_trade(symbol, tp, candle_time, "tp")
            return
        if hit_sl:
            self._close_trade(symbol, sl, candle_time, "sl")
            return

        expiry = trade.signal.expiry_time
        if expiry is not None and candle_time >= expiry:
            price = candle_close if candle_close is not None else (candle_high + candle_low) / 2
            self._close_trade(symbol, price, candle_time, "expiry")

    @property
    def trades(self) -> list[Trade]:
        return list(self._closed_trades)

    @property
    def open_trades(self) -> list[Trade]:
        return list(self._open_positions.values())

    def report(self) -> dict:
        closed = self._closed_trades
        if not closed:
            return {
                "total_trades": 0,
                "winners": 0,
                "losers": 0,
                "win_rate": 0.0,
                "profit_factor": 0.0,
                "total_pnl_pct": 0.0,
                "max_drawdown_pct": 0.0,
            }

        winners = [t for t in closed if t.is_winner]
        losers = [t for t in closed if not t.is_winner]

        gross_profit = sum(t.pnl_pct for t in winners if t.pnl_pct is not None)
        gross_loss = abs(sum(t.pnl_pct for t in losers if t.pnl_pct is not None))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        cumulative = 0.0
        peak = 0.0
        max_dd = 0.0
        for t in closed:
            pnl = t.pnl_pct or 0.0
            cumulative += pnl
            if cumulative > peak:
                peak = cumulative
            dd = peak - cumulative
            if dd > max_dd:
                max_dd = dd

        return {
            "total_trades": len(closed),
            "winners": len(winners),
            "losers": len(losers),
            "win_rate": len(winners) / len(closed),
            "profit_factor": profit_factor,
            "total_pnl_pct": sum(t.pnl_pct for t in closed if t.pnl_pct is not None),
            "max_drawdown_pct": max_dd,
        }

    def _close_trade(self, symbol: str, price: float, time: datetime, reason: str) -> None:
        trade = self._open_positions.pop(symbol, None)
        if trade is None:
            return
        trade.exit_price = price
        trade.exit_time = time
        trade.exit_reason = reason
        if trade.signal.direction == Direction.LONG:
            dollar_pnl = trade.position_size * (price - trade.entry_price)
        else:
            dollar_pnl = trade.position_size * (trade.entry_price - price)
        self.balance += dollar_pnl
        self._closed_trades.append(trade)
