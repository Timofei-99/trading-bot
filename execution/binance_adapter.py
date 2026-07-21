from __future__ import annotations

from core.signal import Signal
from execution.base import ExecutionAdapter


class BinanceAdapter(ExecutionAdapter):
    def place_order(self, signal: Signal) -> str:
        raise NotImplementedError("BinanceAdapter not yet implemented")

    def get_position(self, symbol: str) -> dict | None:
        raise NotImplementedError("BinanceAdapter not yet implemented")

    def close_position(self, symbol: str) -> None:
        raise NotImplementedError("BinanceAdapter not yet implemented")
