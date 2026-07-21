from __future__ import annotations

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class PremiumDiscountDetector(Detector):
    """Detects premium and discount zones from swing-based dealing ranges.

    For each consecutive alternating pair of swing points (SL→SH or SH→SL)
    two Patterns are emitted:

        Premium zone  — upper half of the range: [equilibrium, range_high]
                        Price here is "expensive"; bias is bearish.
        Discount zone — lower half of the range: [range_low, equilibrium]
                        Price here is "cheap"; bias is bullish.

    Equilibrium (50%) is the Pattern.mid of both zones and stored in
    meta["equilibrium"].

    Pattern fields:
        start_time = time of the later of the two swing candles that define
                     the range (when the range became fully formed).
        end_time   = None  (zones do not expire on their own).
        high / low = bounds of the zone half.

    meta fields:
        zone        : "premium" | "discount"
        direction   : "bullish" (SL came first → price rose into range)
                    | "bearish" (SH came first → price fell into range)
        range_high  : float — top of the full dealing range (swing high price)
        range_low   : float — bottom of the full dealing range (swing low price)
        equilibrium : float — 50% midpoint of the range
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

        sh_indices = self._swing_high_indices(candles)
        sl_indices = self._swing_low_indices(candles)

        if not sh_indices or not sl_indices:
            return []

        all_swings: list[tuple[str, int]] = (
            [("high", i) for i in sh_indices]
            + [("low",  i) for i in sl_indices]
        )
        all_swings.sort(key=lambda x: x[1])

        patterns: list[Pattern] = []

        for k in range(len(all_swings) - 1):
            kind1, idx1 = all_swings[k]
            kind2, idx2 = all_swings[k + 1]

            if kind1 == kind2:
                continue  # two highs or two lows in a row — no range yet

            if kind1 == "low":
                sl_price = float(candles["low"].iloc[idx1])
                sh_price = float(candles["high"].iloc[idx2])
                direction = "bullish"
            else:
                sh_price = float(candles["high"].iloc[idx1])
                sl_price = float(candles["low"].iloc[idx2])
                direction = "bearish"

            if sl_price >= sh_price:
                continue  # degenerate range

            eq = (sh_price + sl_price) / 2
            start_time = candles.index[max(idx1, idx2)]

            common = {
                "direction": direction,
                "range_high": sh_price,
                "range_low": sl_price,
                "equilibrium": eq,
            }

            patterns.append(
                Pattern(
                    type=PatternType.PREMIUM_DISCOUNT,
                    timeframe=self.timeframe,
                    start_time=start_time,
                    end_time=None,
                    high=sh_price,
                    low=eq,
                    meta={"zone": "premium", **common},
                )
            )
            patterns.append(
                Pattern(
                    type=PatternType.PREMIUM_DISCOUNT,
                    timeframe=self.timeframe,
                    start_time=start_time,
                    end_time=None,
                    high=eq,
                    low=sl_price,
                    meta={"zone": "discount", **common},
                )
            )

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
