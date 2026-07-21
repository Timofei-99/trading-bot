from __future__ import annotations

import numpy as np
import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class LiquidityDetector(Detector):
    """Detects BSL (Buy Side Liquidity) and SSL (Sell Side Liquidity) levels.

    BSL rests above swing highs — accumulated stop-loss and limit-buy orders
    that price must grab before reversing or continuing down.
    SSL rests below swing lows — accumulated stop-loss and limit-sell orders.

    Key distinction from BOS/CHOCH: a liquidity SWEEP is triggered by a wick
    (candle high/low), not a close.  Price only needs to touch the level,
    not close through it.

    Pattern.high == Pattern.low == the price level (a horizontal line, not a zone).
    Pattern.start_time = time of the swing candle that created the level.
    Pattern.end_time   = time of the first candle that swept the level; None if intact.
    meta["side"]       = "buy" (BSL) or "sell" (SSL)
    meta["swept"]      = bool
    """

    def __init__(self, swing_length: int = 3, timeframe: str = "") -> None:
        self.swing_length = swing_length
        self.timeframe = timeframe

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        n = self.swing_length
        if len(candles) < n * 2 + 1:
            return []

        patterns: list[Pattern] = []

        for j in self._swing_high_indices(candles):
            patterns.append(self._bsl(candles, j))

        for j in self._swing_low_indices(candles):
            patterns.append(self._ssl(candles, j))

        patterns.sort(key=lambda p: p.start_time)
        return patterns

    # ------------------------------------------------------------------
    # Level construction
    # ------------------------------------------------------------------

    def _bsl(self, candles: pd.DataFrame, swing_idx: int) -> Pattern:
        price = float(candles["high"].iloc[swing_idx])
        swept_time = self._sweep_high(candles, price, swing_idx + 1)
        return Pattern(
            type=PatternType.LIQUIDITY,
            timeframe=self.timeframe,
            start_time=candles.index[swing_idx],
            end_time=swept_time,
            high=price,
            low=price,
            meta={"side": "buy", "swept": swept_time is not None},
        )

    def _ssl(self, candles: pd.DataFrame, swing_idx: int) -> Pattern:
        price = float(candles["low"].iloc[swing_idx])
        swept_time = self._sweep_low(candles, price, swing_idx + 1)
        return Pattern(
            type=PatternType.LIQUIDITY,
            timeframe=self.timeframe,
            start_time=candles.index[swing_idx],
            end_time=swept_time,
            high=price,
            low=price,
            meta={"side": "sell", "swept": swept_time is not None},
        )

    # ------------------------------------------------------------------
    # Sweep detection (wick-based, not close-based)
    # ------------------------------------------------------------------

    def _sweep_high(
        self, candles: pd.DataFrame, price: float, start_idx: int
    ) -> pd.Timestamp | None:
        highs = candles["high"].to_numpy()[start_idx:]
        mask = highs > price
        if not mask.any():
            return None
        return candles.index[start_idx + int(np.argmax(mask))]

    def _sweep_low(
        self, candles: pd.DataFrame, price: float, start_idx: int
    ) -> pd.Timestamp | None:
        lows = candles["low"].to_numpy()[start_idx:]
        mask = lows < price
        if not mask.any():
            return None
        return candles.index[start_idx + int(np.argmax(mask))]

    # ------------------------------------------------------------------
    # Swing pivot detection (strict: no equal neighbours)
    # ------------------------------------------------------------------

    def _swing_high_indices(self, candles: pd.DataFrame) -> list[int]:
        n = self.swing_length
        highs = candles["high"].to_numpy()
        result: list[int] = []
        for i in range(n, len(highs) - n):
            pivot = highs[i]
            if pivot > max(highs[i - n : i]) and pivot > max(highs[i + 1 : i + n + 1]):
                result.append(i)
        return result

    def _swing_low_indices(self, candles: pd.DataFrame) -> list[int]:
        n = self.swing_length
        lows = candles["low"].to_numpy()
        result: list[int] = []
        for i in range(n, len(lows) - n):
            pivot = lows[i]
            if pivot < min(lows[i - n : i]) and pivot < min(lows[i + 1 : i + n + 1]):
                result.append(i)
        return result
