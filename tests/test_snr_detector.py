from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.snr import SNRDetector


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
# Resistance test data
# ---------------------------------------------------------------------------
#
# swing_length=1
#
#  i:  0   1   2   3   4   5   6
#  H: 10  20  18  14  20  16  10
#  L:  7  16  12  10  16  12   7
#
# SH at i=1: H=20 > H[0]=10 ✓ and H=20 > H[2]=18 ✓
# SH at i=4: H=20 > H[3]=14 ✓ and H=20 > H[5]=16 ✓
# SL: i=2: L=12 < L[1]=16 ✓ but L=12 > L[3]=10 ✗ — not SL
#     i=3: L=10 < L[2]=12 ✓ but L=10 > L[4]=16? No, 10 < 16 ✓ → SL at i=3
#
# SL at i=3 (1 touch) → no support zone with min_touches=2.
# SH at i=1, i=4 (both H=20, 0% apart) → resistance zone [20, 20], 2 touches.

_RES_HIGHS = [10, 20, 18, 14, 20, 16, 10]
_RES_LOWS  = [ 7, 16, 12, 10, 16, 12,  7]


# ---------------------------------------------------------------------------
# Support test data
# ---------------------------------------------------------------------------
#
# swing_length=1
#
#  i:  0   1   2   3   4   5   6
#  H: 20  14  16  20  14  16  20
#  L: 15  10  12  15  10  12  15
#
# SL at i=1: L=10 < L[0]=15 ✓ and L=10 < L[2]=12 ✓
# SL at i=4: L=10 < L[3]=15 ✓ and L=10 < L[5]=12 ✓
# SH at i=3: H=20 > H[2]=16 ✓ and H=20 > H[4]=14 ✓  (1 touch — no resistance)
#
# → support zone [10, 10], 2 touches; no resistance zone.

_SUP_HIGHS = [20, 14, 16, 20, 14, 16, 20]
_SUP_LOWS  = [15, 10, 12, 15, 10, 12, 15]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_not_enough_candles_returns_empty():
    df = make_candles([10, 20, 15], [7, 15, 10])
    assert SNRDetector(swing_length=2).detect(df) == []


def test_no_zone_when_only_one_touch():
    # Only 1 SH — below min_touches=2 → no resistance zone emitted.
    df = make_candles(
        highs=[10, 20, 18, 14, 12, 10],
        lows= [ 7, 16, 12, 10,  8,  6],
    )
    assert SNRDetector(swing_length=1, min_touches=2).detect(df) == []


def test_no_zone_when_levels_too_far_apart():
    # SH at H=20 and H=21 → 5% apart, tolerance=0.002 → no cluster → each 1 touch.
    df = make_candles(
        highs=[10, 20, 18, 14, 21, 16, 10],
        lows= [ 7, 16, 12, 10, 16, 12,  7],
    )
    assert SNRDetector(swing_length=1, tolerance=0.002, min_touches=2).detect(df) == []


# ---------------------------------------------------------------------------
# Resistance zone
# ---------------------------------------------------------------------------


def test_resistance_zone_detected():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    zones = [p for p in SNRDetector(swing_length=1).detect(df)
             if p.meta["side"] == "resistance"]
    assert len(zones) == 1


def test_resistance_pattern_type():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    p = SNRDetector(swing_length=1).detect(df)[0]
    assert p.type == PatternType.SNR


def test_resistance_zone_bounds():
    # Both SH at exactly H=20 → zone [20, 20]
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.high == pytest.approx(20.0)
    assert p.low  == pytest.approx(20.0)


def test_resistance_touches():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.meta["touches"] == 2


def test_resistance_start_time_is_first_touch():
    # First SH at i=1
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.start_time == df.index[1]


def test_resistance_unbroken():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.end_time is None
    assert p.meta["broken"] is False


def test_resistance_broken_by_close_above_zone():
    # After last SH at i=4, append a candle that closes above 20.
    #  i=7: H=22, L=21 → close = 21.5 > 20.0 → broken
    df = make_candles(
        highs=[10, 20, 18, 14, 20, 16, 10, 22],
        lows= [ 7, 16, 12, 10, 16, 12,  7, 21],
    )
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.meta["broken"] is True
    assert p.end_time == df.index[7]


def test_resistance_not_broken_by_wick_only():
    # H=21 at i=7 but low=18 → close=(21+18)/2=19.5 < 20 → NOT broken.
    df = make_candles(
        highs=[10, 20, 18, 14, 20, 16, 10, 21],
        lows= [ 7, 16, 12, 10, 16, 12,  7, 18],
    )
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "resistance")
    assert p.meta["broken"] is False
    assert p.end_time is None


# ---------------------------------------------------------------------------
# Support zone
# ---------------------------------------------------------------------------


def test_support_zone_detected():
    df = make_candles(_SUP_HIGHS, _SUP_LOWS)
    zones = [p for p in SNRDetector(swing_length=1).detect(df)
             if p.meta["side"] == "support"]
    assert len(zones) == 1


def test_support_zone_bounds():
    # Both SL at exactly L=10 → zone [10, 10]
    df = make_candles(_SUP_HIGHS, _SUP_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "support")
    assert p.high == pytest.approx(10.0)
    assert p.low  == pytest.approx(10.0)


def test_support_unbroken():
    df = make_candles(_SUP_HIGHS, _SUP_LOWS)
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "support")
    assert p.end_time is None
    assert p.meta["broken"] is False


def test_support_broken_by_close_below_zone():
    # After last SL at i=4, append a candle that closes below 10.
    #  i=7: H=9, L=8 → close = 8.5 < 10.0 → broken
    df = make_candles(
        highs=[20, 14, 16, 20, 14, 16, 20,  9],
        lows= [15, 10, 12, 15, 10, 12, 15,  8],
    )
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "support")
    assert p.meta["broken"] is True
    assert p.end_time == df.index[7]


def test_support_not_broken_by_wick_only():
    # L=9 at i=7 but close = (11+9)/2 = 10 — exactly at zone boundary,
    # not strictly below → NOT broken.
    df = make_candles(
        highs=[20, 14, 16, 20, 14, 16, 20, 11],
        lows= [15, 10, 12, 15, 10, 12, 15,  9],
    )
    p = next(z for z in SNRDetector(swing_length=1).detect(df)
             if z.meta["side"] == "support")
    assert p.meta["broken"] is False


# ---------------------------------------------------------------------------
# Tolerance clustering
# ---------------------------------------------------------------------------
#
#  SH at i=1 (H=20.0) and i=4 (H=20.3).
#  |20.3 - 20.0| / 20.0 = 1.5 % → within tolerance=0.02 → single cluster.


def test_tolerance_clusters_nearby_levels():
    df = make_candles(
        highs=[10.0, 20.0, 18.0, 14.0, 20.3, 16.0, 10.0],
        lows= [ 7.0, 16.0, 12.0, 10.0, 16.0, 12.0,  7.0],
    )
    zones = [p for p in SNRDetector(swing_length=1, tolerance=0.02).detect(df)
             if p.meta["side"] == "resistance"]
    assert len(zones) == 1
    assert zones[0].meta["touches"] == 2


def test_tolerance_zone_bounds_span_both_prices():
    # zone_high = max(20.0, 20.3) = 20.3, zone_low = min = 20.0
    df = make_candles(
        highs=[10.0, 20.0, 18.0, 14.0, 20.3, 16.0, 10.0],
        lows= [ 7.0, 16.0, 12.0, 10.0, 16.0, 12.0,  7.0],
    )
    p = next(z for z in SNRDetector(swing_length=1, tolerance=0.02).detect(df)
             if z.meta["side"] == "resistance")
    assert p.high == pytest.approx(20.3)
    assert p.low  == pytest.approx(20.0)


# ---------------------------------------------------------------------------
# min_touches
# ---------------------------------------------------------------------------


def test_min_touches_3_requires_three_swings():
    # Only 2 SH → with min_touches=3 → no zone
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    assert SNRDetector(swing_length=1, min_touches=3).detect(df) == []


def test_min_touches_3_satisfied():
    # Three SH at the same level → zone emitted with touches=3.
    #
    #  i:  0   1   2   3   4   5   6   7   8
    #  H: 10  20  18  14  20  18  14  20  16
    #  L:  7  16  12  10  16  12  10  16  12
    #
    # SH at i=1,4,7 all H=20
    df = make_candles(
        highs=[10, 20, 18, 14, 20, 18, 14, 20, 16],
        lows= [ 7, 16, 12, 10, 16, 12, 10, 16, 12],
    )
    zones = [p for p in SNRDetector(swing_length=1, min_touches=3).detect(df)
             if p.meta["side"] == "resistance"]
    assert len(zones) == 1
    assert zones[0].meta["touches"] == 3


# ---------------------------------------------------------------------------
# Both support and resistance
# ---------------------------------------------------------------------------
#
#  i:  0   1   2   3   4   5   6   7   8
#  H: 12  20  15  12  18  20  15  12  18
#  L:  8  15  10   8  14  15  10   8  14
#
# SH at i=1 (H=20) and i=5 (H=20) → resistance [20, 20]
# SL at i=3 (L=8)  and i=7 (L=8)  → support    [ 8,  8]


_BOTH_HIGHS = [12, 20, 15, 12, 18, 20, 15, 12, 18]
_BOTH_LOWS  = [ 8, 15, 10,  8, 14, 15, 10,  8, 14]


def test_both_sides_detected():
    df = make_candles(_BOTH_HIGHS, _BOTH_LOWS)
    patterns = SNRDetector(swing_length=1).detect(df)
    sides = {p.meta["side"] for p in patterns}
    assert sides == {"support", "resistance"}


def test_both_sides_one_zone_each():
    df = make_candles(_BOTH_HIGHS, _BOTH_LOWS)
    patterns = SNRDetector(swing_length=1).detect(df)
    assert len([p for p in patterns if p.meta["side"] == "resistance"]) == 1
    assert len([p for p in patterns if p.meta["side"] == "support"]) == 1


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


def test_sorted_by_start_time():
    df = make_candles(_BOTH_HIGHS, _BOTH_LOWS)
    patterns = SNRDetector(swing_length=1).detect(df)
    times = [p.start_time for p in patterns]
    assert times == sorted(times)


def test_timeframe_propagated():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    for p in SNRDetector(swing_length=1, timeframe="4h").detect(df):
        assert p.timeframe == "4h"


def test_mid_is_midpoint():
    df = make_candles(_RES_HIGHS, _RES_LOWS)
    for p in SNRDetector(swing_length=1).detect(df):
        assert p.mid == pytest.approx((p.high + p.low) / 2)
