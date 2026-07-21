from __future__ import annotations

import numpy as np
import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class FVGDetector(Detector):
    """Detects Fair Value Gaps (FVG) — 3-candle imbalance patterns.

    A Fair Value Gap is an area where price moved so quickly that it left an
    unfilled gap between candle 1 and candle 3, with candle 2 as the impulse.

    Bullish FVG: C[i-1].high < C[i+1].low
        Zone = [C[i-1].high, C[i+1].low]   (Pattern.low, Pattern.high)
        Mitigated when a subsequent candle's LOW reaches back to Pattern.high.

    Bearish FVG: C[i+1].high < C[i-1].low
        Zone = [C[i+1].high, C[i-1].low]   (Pattern.low, Pattern.high)
        Mitigated when a subsequent candle's HIGH reaches back to Pattern.low.

    Mitigation is single-phase: any candle touching the zone boundary after
    bar 3 closes counts, since the FVG is already confirmed and price has
    already departed from the zone by definition.

    Pattern.start_time = time of candle 1 (first bound of the zone).
    Pattern.end_time   = time of first mitigation candle, or None if unfilled.
    Pattern.mid        = 50% equilibrium of the gap (useful for entry targeting).
    """

    def __init__(self, timeframe: str = "", min_gap: float = 0.0) -> None:
        self.timeframe = timeframe
        self.min_gap = min_gap

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        if len(candles) < 3:
            return []

        highs = candles["high"].to_numpy()
        lows = candles["low"].to_numpy()
        patterns: list[Pattern] = []

        for i in range(1, len(candles) - 1):
            c1_high = highs[i - 1]
            c1_low = lows[i - 1]
            c3_high = highs[i + 1]
            c3_low = lows[i + 1]

            if c3_low > c1_high:                   # bullish gap
                gap = float(c3_low - c1_high)
                if gap < self.min_gap:
                    continue
                fvg_low = float(c1_high)
                fvg_high = float(c3_low)
                mit = self._mitigation_bullish(candles, fvg_high, i + 2)
                patterns.append(
                    Pattern(
                        type=PatternType.FVG,
                        timeframe=self.timeframe,
                        start_time=candles.index[i - 1],
                        end_time=mit,
                        high=fvg_high,
                        low=fvg_low,
                        meta={
                            "direction": "bullish",
                            "impulse_time": candles.index[i],
                            "gap_size": gap,
                            "mitigated": mit is not None,
                        },
                    )
                )

            elif c3_high < c1_low:                 # bearish gap
                gap = float(c1_low - c3_high)
                if gap < self.min_gap:
                    continue
                fvg_low = float(c3_high)
                fvg_high = float(c1_low)
                mit = self._mitigation_bearish(candles, fvg_low, i + 2)
                patterns.append(
                    Pattern(
                        type=PatternType.FVG,
                        timeframe=self.timeframe,
                        start_time=candles.index[i - 1],
                        end_time=mit,
                        high=fvg_high,
                        low=fvg_low,
                        meta={
                            "direction": "bearish",
                            "impulse_time": candles.index[i],
                            "gap_size": gap,
                            "mitigated": mit is not None,
                        },
                    )
                )

        return patterns

    # ------------------------------------------------------------------
    # Mitigation helpers
    # ------------------------------------------------------------------

    def _mitigation_bullish(
        self, candles: pd.DataFrame, fvg_high: float, start_idx: int
    ) -> pd.Timestamp | None:
        lows = candles["low"].to_numpy()[start_idx:]
        mask = lows <= fvg_high
        if not mask.any():
            return None
        return candles.index[start_idx + int(np.argmax(mask))]

    def _mitigation_bearish(
        self, candles: pd.DataFrame, fvg_low: float, start_idx: int
    ) -> pd.Timestamp | None:
        highs = candles["high"].to_numpy()[start_idx:]
        mask = highs >= fvg_low
        if not mask.any():
            return None
        return candles.index[start_idx + int(np.argmax(mask))]
