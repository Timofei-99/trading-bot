from __future__ import annotations

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class FractalDetector(Detector):
    """3-candle swing fractal detector.

    A fractal HIGH at bar[i]: high[i] > high[i-1] AND high[i] > high[i+1]
    A fractal LOW  at bar[i]: low[i]  < low[i-1]  AND low[i]  < low[i+1]

    The fractal is CONFIRMED when bar[i+1] closes (end_time = index[i+1]).
    The last two bars of any slice can never form a confirmed fractal —
    this ensures zero look-ahead bias when the detector is called on a
    rolling window.

    Pattern fields:
        start_time  = timestamp of the fractal bar itself
        end_time    = timestamp of the confirmation bar (i+1)
        high = low  = fractal price level
        meta["fractal_type"] : "high" | "low"
        meta["level"]        : float — the fractal price
    """

    def __init__(self, timeframe: str = "") -> None:
        self.timeframe = timeframe

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        if len(candles) < 3:
            return []

        highs = candles["high"].to_numpy()
        lows  = candles["low"].to_numpy()
        n = len(candles)
        patterns: list[Pattern] = []

        for i in range(1, n - 1):
            if highs[i] > highs[i - 1] and highs[i] > highs[i + 1]:
                level = float(highs[i])
                patterns.append(Pattern(
                    type=PatternType.FRACTAL,
                    timeframe=self.timeframe,
                    start_time=candles.index[i],
                    end_time=candles.index[i + 1],
                    high=level,
                    low=level,
                    meta={"fractal_type": "high", "level": level},
                ))

            if lows[i] < lows[i - 1] and lows[i] < lows[i + 1]:
                level = float(lows[i])
                patterns.append(Pattern(
                    type=PatternType.FRACTAL,
                    timeframe=self.timeframe,
                    start_time=candles.index[i],
                    end_time=candles.index[i + 1],
                    high=level,
                    low=level,
                    meta={"fractal_type": "low", "level": level},
                ))

        return patterns
