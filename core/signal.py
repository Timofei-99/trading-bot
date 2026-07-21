from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Direction(Enum):
    LONG = "long"
    SHORT = "short"


@dataclass
class Signal:
    symbol: str
    direction: Direction
    entry: float
    stop_loss: float
    take_profit: float
    timeframe: str
    timestamp: datetime
    strategy_name: str
    strategy_version: str
    triggered_by: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    expiry_time: datetime | None = None

    @property
    def risk_amount(self) -> float:
        return abs(self.entry - self.stop_loss)

    @property
    def reward_amount(self) -> float:
        return abs(self.take_profit - self.entry)

    @property
    def risk_reward(self) -> float:
        return self.reward_amount / self.risk_amount
