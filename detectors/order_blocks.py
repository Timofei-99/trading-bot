from __future__ import annotations

import numpy as np
import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class OrderBlockDetector(Detector):
    """Detects ICT Order Blocks at confirmed swing highs and swing lows.

    Bullish OB: the last bearish candle (close < open) within `lookback` bars
                before a swing low.  Zone = body [close, open] of that candle.
    Bearish OB: the last bullish candle (close > open) within `lookback` bars
                before a swing high.  Zone = body [open, close] of that candle.

    Pattern.end_time is set to the timestamp of the first candle where price
    re-enters the OB zone after having cleared it (mitigation).  None means
    the OB is still unmitigated.

    Mitigation logic (two-phase, one direction at a time):
      Bullish OB: price must first CLOSE ABOVE ob_high, then a subsequent
                  candle's LOW must reach back to ob_high or below.
      Bearish OB: price must first CLOSE BELOW ob_low, then a subsequent
                  candle's HIGH must reach back to ob_low or above.
    This prevents the departure candle itself from triggering mitigation.
    """

    def __init__(
        self,
        swing_length: int = 3,
        lookback: int = 5,
        timeframe: str = "",
        use_body: bool = True,
    ) -> None:
        self.swing_length = swing_length
        self.lookback = lookback
        self.timeframe = timeframe
        self.use_body = use_body

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        n = self.swing_length
        if len(candles) < n * 2 + 1:
            return []

        patterns: list[Pattern] = []

        for j in self._swing_low_indices(candles):
            ob = self._bullish_ob(candles, j)
            if ob is not None:
                patterns.append(ob)

        for j in self._swing_high_indices(candles):
            ob = self._bearish_ob(candles, j)
            if ob is not None:
                patterns.append(ob)

        patterns.sort(key=lambda p: p.start_time)
        return patterns

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

    # ------------------------------------------------------------------
    # Order block identification
    # ------------------------------------------------------------------

    def _bullish_ob(self, candles: pd.DataFrame, swing_low_idx: int) -> Pattern | None:
        """Last bearish candle at or before the swing low."""
        start = max(0, swing_low_idx - self.lookback)
        ob_idx: int | None = None
        for i in range(start, swing_low_idx + 1):
            if candles["close"].iloc[i] < candles["open"].iloc[i]:
                ob_idx = i

        if ob_idx is None:
            return None

        if self.use_body:
            ob_high = float(candles["open"].iloc[ob_idx])   # top of bearish body
            ob_low = float(candles["close"].iloc[ob_idx])   # bottom of bearish body
        else:
            ob_high = float(candles["high"].iloc[ob_idx])
            ob_low = float(candles["low"].iloc[ob_idx])

        mit_time = self._mitigation_bullish(candles, ob_high, swing_low_idx + 1)

        return Pattern(
            type=PatternType.ORDER_BLOCK,
            timeframe=self.timeframe,
            start_time=candles.index[ob_idx],
            end_time=mit_time,
            high=ob_high,
            low=ob_low,
            meta={
                "direction": "bullish",
                "swing_time": candles.index[swing_low_idx],
                "mitigated": mit_time is not None,
            },
        )

    def _bearish_ob(self, candles: pd.DataFrame, swing_high_idx: int) -> Pattern | None:
        """Last bullish candle at or before the swing high."""
        start = max(0, swing_high_idx - self.lookback)
        ob_idx: int | None = None
        for i in range(start, swing_high_idx + 1):
            if candles["close"].iloc[i] > candles["open"].iloc[i]:
                ob_idx = i

        if ob_idx is None:
            return None

        if self.use_body:
            ob_high = float(candles["close"].iloc[ob_idx])  # top of bullish body
            ob_low = float(candles["open"].iloc[ob_idx])    # bottom of bullish body
        else:
            ob_high = float(candles["high"].iloc[ob_idx])
            ob_low = float(candles["low"].iloc[ob_idx])

        mit_time = self._mitigation_bearish(candles, ob_low, swing_high_idx + 1)

        return Pattern(
            type=PatternType.ORDER_BLOCK,
            timeframe=self.timeframe,
            start_time=candles.index[ob_idx],
            end_time=mit_time,
            high=ob_high,
            low=ob_low,
            meta={
                "direction": "bearish",
                "swing_time": candles.index[swing_high_idx],
                "mitigated": mit_time is not None,
            },
        )

    # ------------------------------------------------------------------
    # Mitigation detection (two-phase: clear zone first, then re-enter)
    # ------------------------------------------------------------------

    def _mitigation_bullish(
        self,
        candles: pd.DataFrame,
        ob_high: float,
        start_idx: int,
    ) -> pd.Timestamp | None:
        """Two-phase: first close > ob_high (departure), then low ≤ ob_high (return)."""
        closes = candles["close"].to_numpy()[start_idx:]
        lows   = candles["low"].to_numpy()[start_idx:]

        phase1 = closes > ob_high
        if not phase1.any():
            return None
        p1 = int(np.argmax(phase1))

        phase2 = lows[p1 + 1:] <= ob_high
        if not phase2.any():
            return None
        p2 = int(np.argmax(phase2))
        return candles.index[start_idx + p1 + 1 + p2]

    def _mitigation_bearish(
        self,
        candles: pd.DataFrame,
        ob_low: float,
        start_idx: int,
    ) -> pd.Timestamp | None:
        """Two-phase: first close < ob_low (departure), then high ≥ ob_low (return)."""
        closes = candles["close"].to_numpy()[start_idx:]
        highs  = candles["high"].to_numpy()[start_idx:]

        phase1 = closes < ob_low
        if not phase1.any():
            return None
        p1 = int(np.argmax(phase1))

        phase2 = highs[p1 + 1:] >= ob_low
        if not phase2.any():
            return None
        p2 = int(np.argmax(phase2))
        return candles.index[start_idx + p1 + 1 + p2]
