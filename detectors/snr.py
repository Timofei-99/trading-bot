from __future__ import annotations

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class SNRDetector(Detector):
    """Support and Resistance zone detector.

    Clusters swing highs (resistance) and swing lows (support) whose prices
    fall within `tolerance` of each other into a single price zone.  A zone
    must accumulate at least `min_touches` touches to be emitted.

    A zone is broken when a candle CLOSES through it (checked from the bar
    immediately after the last touch that formed the zone):
        resistance broken : close > zone_high
        support    broken : close < zone_low

    Pattern fields:
        high / low  = price bounds of the zone
        start_time  = timestamp of the first qualifying touch
        end_time    = timestamp of the breaking candle; None if zone is intact

    meta fields:
        side    : "support" | "resistance"
        touches : int — number of swing points inside the zone
        broken  : bool
    """

    def __init__(
        self,
        swing_length: int = 3,
        tolerance: float = 0.002,   # fraction of price, e.g. 0.002 = 0.2 %
        min_touches: int = 2,
        timeframe: str = "",
    ) -> None:
        self.swing_length = swing_length
        self.tolerance = tolerance
        self.min_touches = min_touches
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

        patterns: list[Pattern] = []

        highs_with_idx = [(i, float(candles["high"].iloc[i])) for i in sh_indices]
        for cluster in self._cluster(highs_with_idx):
            if len(cluster) >= self.min_touches:
                patterns.append(self._make_zone(candles, cluster, "resistance"))

        lows_with_idx = [(i, float(candles["low"].iloc[i])) for i in sl_indices]
        for cluster in self._cluster(lows_with_idx):
            if len(cluster) >= self.min_touches:
                patterns.append(self._make_zone(candles, cluster, "support"))

        patterns.sort(key=lambda p: p.start_time)
        return patterns

    # ------------------------------------------------------------------
    # Zone construction
    # ------------------------------------------------------------------

    def _make_zone(
        self,
        candles: pd.DataFrame,
        cluster: list[tuple[int, float]],
        side: str,
    ) -> Pattern:
        prices  = [p for _, p in cluster]
        indices = [i for i, _ in cluster]

        zone_high  = max(prices)
        zone_low   = min(prices)
        first_idx  = min(indices)
        last_idx   = max(indices)

        if side == "resistance":
            break_time = self._break_resistance(candles, zone_high, last_idx + 1)
        else:
            break_time = self._break_support(candles, zone_low, last_idx + 1)

        return Pattern(
            type=PatternType.SNR,
            timeframe=self.timeframe,
            start_time=candles.index[first_idx],
            end_time=break_time,
            high=zone_high,
            low=zone_low,
            meta={
                "side": side,
                "touches": len(cluster),
                "broken": break_time is not None,
            },
        )

    # ------------------------------------------------------------------
    # Break detection (close-based)
    # ------------------------------------------------------------------

    def _break_resistance(
        self, candles: pd.DataFrame, zone_high: float, start_idx: int
    ) -> pd.Timestamp | None:
        closes = candles["close"].to_numpy()
        for i in range(start_idx, len(closes)):
            if closes[i] > zone_high:
                return candles.index[i]
        return None

    def _break_support(
        self, candles: pd.DataFrame, zone_low: float, start_idx: int
    ) -> pd.Timestamp | None:
        closes = candles["close"].to_numpy()
        for i in range(start_idx, len(closes)):
            if closes[i] < zone_low:
                return candles.index[i]
        return None

    # ------------------------------------------------------------------
    # Clustering — greedy, sorted by price
    # ------------------------------------------------------------------

    def _cluster(
        self, levels: list[tuple[int, float]]
    ) -> list[list[tuple[int, float]]]:
        if not levels:
            return []

        by_price = sorted(levels, key=lambda x: x[1])
        clusters: list[list[tuple[int, float]]] = [[by_price[0]]]

        for idx, price in by_price[1:]:
            cluster_prices = [p for _, p in clusters[-1]]
            center = sum(cluster_prices) / len(cluster_prices)
            if abs(price - center) / center <= self.tolerance:
                clusters[-1].append((idx, price))
            else:
                clusters.append([(idx, price)])

        return clusters

    # ------------------------------------------------------------------
    # Swing pivot detection (strict: no equal neighbours)
    # ------------------------------------------------------------------

    def _swing_high_indices(self, candles: pd.DataFrame) -> list[int]:
        n = self.swing_length
        highs = candles["high"].to_numpy()
        result: list[int] = []
        for i in range(n, len(highs) - n):
            pivot = highs[i]
            if pivot > max(highs[i - n:i]) and pivot > max(highs[i + 1:i + n + 1]):
                result.append(i)
        return result

    def _swing_low_indices(self, candles: pd.DataFrame) -> list[int]:
        n = self.swing_length
        lows = candles["low"].to_numpy()
        result: list[int] = []
        for i in range(n, len(lows) - n):
            pivot = lows[i]
            if pivot < min(lows[i - n:i]) and pivot < min(lows[i + 1:i + n + 1]):
                result.append(i)
        return result
