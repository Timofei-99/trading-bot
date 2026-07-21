from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from core.market_context import MarketContext

if TYPE_CHECKING:
    from core.signal import Signal
    from execution.base import Trade


class Strategy(ABC):
    name: str = ""
    version: str = ""

    @abstractmethod
    def check_entry(self, context: MarketContext) -> Signal | None:
        ...

    def check_exit(self, context: MarketContext, trade: Trade) -> bool:
        return False
