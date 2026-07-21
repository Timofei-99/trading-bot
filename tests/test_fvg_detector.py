from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.fvg import FVGDetector


def make_candles(highs: list[float], lows: list[float]) -> pd.DataFrame:
    closes = [(h + l) / 2 for h, l in zip(highs, lows)]
    timestamps = pd.date_range("2024-01-01", periods=len(highs), freq="1h")
    return pd.DataFrame(
        {
            "open": closes,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": [1000.0] * len(highs),
        },
        index=timestamps,
    )


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_less_than_3_candles_returns_empty():
    df = make_candles([10, 15], [5, 10])
    assert FVGDetector().detect(df) == []


def test_no_fvg_when_candles_overlap():
    # All triplets have overlapping ranges — no gap in any direction.
    #
    # For each triplet (i-1, i, i+1):
    #   bullish gap requires C[i+1].low  > C[i-1].high  → all pairs overlap here
    #   bearish gap requires C[i+1].high < C[i-1].low   → not the case here
    #
    #  i:  0   1   2   3   4
    #  H: 10  15  13  18  16
    #  L:  5   8   9  12  11
    #
    # Triplet (0,1,2): C[2].L=9  vs C[0].H=10 → 9  < 10 → no bullish gap ✓
    # Triplet (1,2,3): C[3].L=12 vs C[1].H=15 → 12 < 15 → no bullish gap ✓
    # Triplet (2,3,4): C[4].L=11 vs C[2].H=13 → 11 < 13 → no bullish gap ✓
    df = make_candles(
        highs=[10, 15, 13, 18, 16],
        lows=[ 5,  8,  9, 12, 11],
    )
    assert FVGDetector().detect(df) == []


# ---------------------------------------------------------------------------
# Bullish FVG
# ---------------------------------------------------------------------------
#
# 3-candle pattern:
#  C1: H=10, L=5       ← gap boundary (low side): H=10
#  C2: H=18, L=11      ← impulse candle
#  C3: H=20, L=12      ← gap boundary (high side): L=12 > C1.H=10 → gap!
#
# Bullish FVG zone: [10, 12]   Pattern.low=10, Pattern.high=12
# FVG forms at i=1 (C2 is the middle). start_time = index[0] (C1).
#
# Subsequent bars (i=3 onwards) with steadily rising lows never touch the zone:
#  C4: H=22, L=13 → L=13 > fvg_high=12 → no mitigation
#  C5: H=25, L=15 → L=15 > 12          → no mitigation
# → unmitigated FVG.


_BULL_HIGHS = [10, 18, 20, 22, 25]
_BULL_LOWS  = [ 5, 11, 12, 13, 15]


def test_bullish_fvg_detected():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    patterns = FVGDetector().detect(df)
    bullish = [p for p in patterns if p.meta["direction"] == "bullish"]
    assert len(bullish) == 1


def test_bullish_fvg_type():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.type == PatternType.FVG


def test_bullish_fvg_zone_bounds():
    # Pattern.low = C1.high = 10,  Pattern.high = C3.low = 12
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.low  == pytest.approx(10.0)
    assert p.high == pytest.approx(12.0)


def test_bullish_fvg_mid_is_50pct_of_gap():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.mid == pytest.approx(11.0)


def test_bullish_fvg_start_time_is_candle1():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.start_time == df.index[0]   # C1's timestamp


def test_bullish_fvg_impulse_time_in_meta():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.meta["impulse_time"] == df.index[1]   # C2 = the middle candle


def test_bullish_fvg_gap_size_in_meta():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.meta["gap_size"] == pytest.approx(2.0)   # 12 - 10


def test_bullish_fvg_unmitigated():
    # Lows after C3 all stay above fvg_high=12 → unmitigated
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.end_time is None
    assert p.meta["mitigated"] is False


def test_bullish_fvg_mitigated_when_low_touches_gap():
    # Append a pullback bar whose low=11 ≤ fvg_high=12 → mitigated.
    #
    #  i:  0   1   2   3   4   5
    #  H: 10  18  20  22  25  14
    #  L:  5  11  12  13  15  11   ← i=5: L=11 ≤ 12 → mitigated
    df = make_candles(
        highs=[10, 18, 20, 22, 25, 14],
        lows=[ 5, 11, 12, 13, 15, 11],
    )
    p = FVGDetector().detect(df)[0]
    assert p.meta["mitigated"] is True
    assert p.end_time == df.index[5]


def test_bullish_fvg_mitigation_requires_bar_after_c3():
    # Even if C3 itself has L == fvg_high (edge case), mitigation starts from
    # the bar AFTER C3 (start_idx = i+2).  With no further bars, unmitigated.
    #
    #  C1.H=10, C3.L=10 → gap=0 ... actually this would be no gap.
    # Instead: C3.L=12, and no additional bars exist after the 3-candle pattern.
    df = make_candles([10, 18, 20], [5, 11, 12])   # exactly 3 bars
    p = FVGDetector().detect(df)[0]
    assert p.end_time is None


# ---------------------------------------------------------------------------
# Bearish FVG
# ---------------------------------------------------------------------------
#
# 3-candle pattern:
#  C1: H=20, L=15      ← gap boundary (high side): L=15
#  C2: H=14, L=10      ← impulse candle (bearish)
#  C3: H=12, L=8       ← gap boundary (low side): H=12 < C1.L=15 → gap!
#
# Bearish FVG zone: [12, 15]   Pattern.low=12, Pattern.high=15
#
# Subsequent bars with steadily falling highs never touch the zone:
#  C4: H=11  → H=11 < fvg_low=12 → no mitigation
#  C5: H=10  → H=10 < 12         → no mitigation
# → unmitigated FVG.


_BEAR_HIGHS = [20, 14, 12, 11, 10]
_BEAR_LOWS  = [15, 10,  8,  7,  5]


def test_bearish_fvg_detected():
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    patterns = FVGDetector().detect(df)
    bearish = [p for p in patterns if p.meta["direction"] == "bearish"]
    assert len(bearish) == 1


def test_bearish_fvg_zone_bounds():
    # Pattern.low = C3.high = 12,  Pattern.high = C1.low = 15
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.low  == pytest.approx(12.0)
    assert p.high == pytest.approx(15.0)


def test_bearish_fvg_unmitigated():
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    p = FVGDetector().detect(df)[0]
    assert p.end_time is None
    assert p.meta["mitigated"] is False


def test_bearish_fvg_mitigated_when_high_touches_gap():
    # Append a rally bar whose high=13 ≥ fvg_low=12 → mitigated.
    #
    #  i:  0   1   2   3   4   5
    #  H: 20  14  12  11  10  13
    #  L: 15  10   8   7   5   9   ← i=5: H=13 ≥ fvg_low=12 → mitigated
    df = make_candles(
        highs=[20, 14, 12, 11, 10, 13],
        lows= [15, 10,  8,  7,  5,  9],
    )
    p = FVGDetector().detect(df)[0]
    assert p.meta["mitigated"] is True
    assert p.end_time == df.index[5]


# ---------------------------------------------------------------------------
# min_gap filter
# ---------------------------------------------------------------------------


def test_min_gap_filters_out_small_fvg():
    # Gap = 12 - 10 = 2.  With min_gap=3 → filtered out.
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    assert FVGDetector(min_gap=3.0).detect(df) == []


def test_min_gap_allows_fvg_at_exact_threshold():
    # Gap = 2.  With min_gap=2 → allowed (gap >= min_gap).
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    assert len(FVGDetector(min_gap=2.0).detect(df)) == 1


# ---------------------------------------------------------------------------
# Multiple FVGs and misc
# ---------------------------------------------------------------------------


def test_multiple_fvgs_detected_in_sequence():
    # Two independent bullish FVGs with a bridge candle that prevents accidental
    # additional FVGs from overlapping triplets.
    #
    # FVG #1 at triplet (0,1,2): C[0].H=10 < C[2].L=12 → gap [10, 12]
    # Bridge  at i=3:  H=24, L=10  (C[2].H=20 vs C[4].L=18 → 18<20, no gap; also
    #                               C[3].H=24 vs C[5].L=24 → 24=24, not strictly >, no gap)
    # FVG #2 at triplet (4,5,6): C[4].H=22 < C[6].L=26 → gap [22, 26]
    #
    #  i:  0   1   2   3   4   5   6
    #  H: 10  18  20  24  22  30  35
    #  L:  5  11  12  10  18  24  26
    df = make_candles(
        highs=[10, 18, 20, 24, 22, 30, 35],
        lows=[ 5, 11, 12, 10, 18, 24, 26],
    )
    bullish = [p for p in FVGDetector().detect(df) if p.meta["direction"] == "bullish"]
    assert len(bullish) == 2
    assert bullish[0].low == pytest.approx(10.0)
    assert bullish[0].high == pytest.approx(12.0)
    assert bullish[1].low == pytest.approx(22.0)
    assert bullish[1].high == pytest.approx(26.0)


def test_timeframe_propagated():
    df = make_candles(_BULL_HIGHS, _BULL_LOWS)
    p = FVGDetector(timeframe="15m").detect(df)[0]
    assert p.timeframe == "15m"
