from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

import pandas as pd

if TYPE_CHECKING:
    from core.patterns import Pattern
    from core.signal import Signal


class Detector(ABC):
    @abstractmethod
    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        ...


class ExecutionAdapter(ABC):
    @abstractmethod
    def place_order(self, signal: Signal) -> str:
        ...

    @abstractmethod
    def get_position(self, symbol: str) -> dict | None:
        ...

    @abstractmethod
    def close_position(self, symbol: str) -> None:
        ...
