from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from core.interfaces import ExecutionAdapter
from core.signal import Direction, Signal

__all__ = ["ExecutionAdapter", "Trade"]


@dataclass
class Trade:
    signal: Signal
    order_id: str
    entry_time: datetime
    entry_price: float
    position_size: float
    exit_time: datetime | None = None
    exit_price: float | None = None
    exit_reason: str | None = None

    @property
    def pnl_pct(self) -> float | None:
        if self.exit_price is None:
            return None
        if self.signal.direction == Direction.LONG:
            return (self.exit_price - self.entry_price) / self.entry_price
        return (self.entry_price - self.exit_price) / self.entry_price

    @property
    def pnl_r(self) -> float | None:
        if self.exit_price is None:
            return None
        risk = self.signal.risk_amount
        if risk == 0:
            return None
        if self.signal.direction == Direction.LONG:
            return (self.exit_price - self.entry_price) / risk
        return (self.entry_price - self.exit_price) / risk

    @property
    def is_winner(self) -> bool | None:
        pnl = self.pnl_pct
        if pnl is None:
            return None
        return pnl > 0
