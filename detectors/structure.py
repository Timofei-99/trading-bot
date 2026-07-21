from __future__ import annotations

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class StructureDetector(Detector):
    """Detects BOS (Break of Structure) and CHOCH (Change of Character).

    BOS  = price closes beyond a confirmed swing level in the direction of the
           current trend → trend continuation.
    CHOCH = price closes beyond a confirmed swing level against the current
            trend → potential reversal.

    The first structural break (when no trend is yet established) is always
    classified as CHOCH.

    A swing high/low at bar j is only considered confirmed after swing_length
    bars have closed on the right side (i.e., starting from bar j+swing_length+1).
    """

    def __init__(self, swing_length: int = 3, timeframe: str = "") -> None:
        self.swing_length = swing_length
        self.timeframe = timeframe

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        min_bars = self.swing_length * 2 + 2
        if len(candles) < min_bars:
            return []

        sh_indices = self._swing_high_indices(candles)
        sl_indices = self._swing_low_indices(candles)

        return self._scan(candles, sh_indices, sl_indices)

    # ------------------------------------------------------------------
    # Swing pivot detection
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

    # ------------------------------------------------------------------
    # Bar-by-bar structure scan
    # ------------------------------------------------------------------

    def _scan(
        self,
        candles: pd.DataFrame,
        sh_indices: list[int],
        sl_indices: list[int],
    ) -> list[Pattern]:
        patterns: list[Pattern] = []
        n = self.swing_length
        times = candles.index
        closes = candles["close"].to_numpy()
        highs = candles["high"].to_numpy()
        lows = candles["low"].to_numpy()

        sh_ptr = 0
        sl_ptr = 0
        current_sh: int | None = None  # index of last confirmed, unbroken swing high
        current_sl: int | None = None  # index of last confirmed, unbroken swing low
        trend: str | None = None       # "bullish", "bearish", or None

        for i in range(len(candles)):
            # A pivot at index j is confirmed once n bars have closed after it,
            # i.e., bar j+n has closed, meaning we are now at bar i > j+n.
            while sh_ptr < len(sh_indices) and sh_indices[sh_ptr] + n < i:
                current_sh = sh_indices[sh_ptr]
                sh_ptr += 1

            while sl_ptr < len(sl_indices) and sl_indices[sl_ptr] + n < i:
                current_sl = sl_indices[sl_ptr]
                sl_ptr += 1

            if current_sh is None or current_sl is None:
                continue

            close = closes[i]
            sh_price = highs[current_sh]
            sl_price = lows[current_sl]

            if close > sh_price:
                pat_type = PatternType.BOS if trend == "bullish" else PatternType.CHOCH
                patterns.append(
                    Pattern(
                        type=pat_type,
                        timeframe=self.timeframe,
                        start_time=times[current_sh],
                        end_time=times[i],
                        high=float(sh_price),
                        low=float(sh_price),
                        meta={
                            "direction": "bullish",
                            "broken_level": float(sh_price),
                        },
                    )
                )
                trend = "bullish"
                current_sh = None  # consumed; wait for the next swing high

            elif close < sl_price:
                pat_type = PatternType.BOS if trend == "bearish" else PatternType.CHOCH
                patterns.append(
                    Pattern(
                        type=pat_type,
                        timeframe=self.timeframe,
                        start_time=times[current_sl],
                        end_time=times[i],
                        high=float(sl_price),
                        low=float(sl_price),
                        meta={
                            "direction": "bearish",
                            "broken_level": float(sl_price),
                        },
                    )
                )
                trend = "bearish"
                current_sl = None  # consumed; wait for the next swing low

        return patterns
