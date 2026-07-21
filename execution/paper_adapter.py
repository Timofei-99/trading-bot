from __future__ import annotations

from core.signal import Signal
from execution.base import ExecutionAdapter


class PaperAdapter(ExecutionAdapter):
    def place_order(self, signal: Signal) -> str:
        raise NotImplementedError("PaperAdapter not yet implemented")

    def get_position(self, symbol: str) -> dict | None:
        raise NotImplementedError("PaperAdapter not yet implemented")

    def close_position(self, symbol: str) -> None:
        raise NotImplementedError("PaperAdapter not yet implemented")
