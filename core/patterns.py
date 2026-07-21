from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class PatternType(Enum):
    ORDER_BLOCK = "order_block"
    FVG = "fvg"
    LIQUIDITY = "liquidity"
    BOS = "bos"
    CHOCH = "choch"
    PREMIUM_DISCOUNT = "premium_discount"
    KILLZONE = "killzone"
    SNR = "snr"
    FRACTAL = "fractal"
    INITIAL_BALANCE = "initial_balance"


@dataclass
class Pattern:
    type: PatternType
    timeframe: str
    start_time: datetime
    end_time: datetime | None
    high: float
    low: float
    meta: dict = field(default_factory=dict)

    @property
    def mid(self) -> float:
        return (self.high + self.low) / 2

    def is_active(self, current_time: datetime) -> bool:
        return self.end_time is None or current_time <= self.end_time
