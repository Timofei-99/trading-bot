from __future__ import annotations

from core.signal import Signal


class RiskManager:
    def __init__(self, risk_per_trade: float = 0.01, max_daily_drawdown: float = 0.03) -> None:
        self.risk_per_trade = risk_per_trade
        self.max_daily_drawdown = max_daily_drawdown

    def position_size(self, balance: float, entry: float, stop_loss: float) -> float:
        return (balance * self.risk_per_trade) / abs(entry - stop_loss)

    def validate_signal(self, signal: Signal, balance: float, daily_pnl: float) -> bool:
        if daily_pnl < -self.max_daily_drawdown:
            return False
        return True
