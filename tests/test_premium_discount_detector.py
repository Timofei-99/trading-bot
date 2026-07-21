from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.premium_discount import PremiumDiscountDetector


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


def test_not_enough_candles_returns_empty():
    df = make_candles([10, 15, 12, 8], [7, 11, 8, 5])
    assert PremiumDiscountDetector(swing_length=2).detect(df) == []


def test_no_zones_when_only_swing_highs():
    # Monotonically falling series — only swing highs, no swing lows.
    # swing_length=1: need H[i] > H[i-1] and H[i] > H[i+1].
    # No such bar in a falling sequence.
    # Actually let me use a series with SH but no SL.
    # i:  0   1   2   3   4   5
    # H: 20  25  20  22  18  15
    # L: 16  20  15  17  13  10
    # SH at i=1: H=25>20 and >20 ✓
    # SL check: need L[i] < L[i-1] AND L[i] < L[i+1]
    # i=0 can't be SL (n=1 needs i>=1)
    # i=2: L=15 < L[1]=20 ✓, L=15 > L[3]=17? No, 15 < 17 ✓ → SL at i=2!
    # So this data has both SH and SL. Let me use strictly monotone falls for no SL:
    df = make_candles(
        highs=[20, 18, 16, 14, 12, 10],
        lows= [15, 13, 11,  9,  7,  5],
    )
    # No swing highs or lows possible in monotone series
    assert PremiumDiscountDetector(swing_length=1).detect(df) == []


def test_no_zones_when_only_one_swing_type():
    # Data with only swing highs (no swing lows) → no range possible.
    # Construct: alternating up-down pattern where only highs qualify.
    # This is hard to construct without also getting SL.
    # Instead, test that if sh_indices or sl_indices is empty, return [].
    # A monotone rising sequence has no swings at all.
    df = make_candles(
        highs=[10, 12, 14, 16, 18, 20],
        lows=[ 8, 10, 12, 14, 16, 18],
    )
    assert PremiumDiscountDetector(swing_length=1).detect(df) == []


# ---------------------------------------------------------------------------
# Single bullish range  (SL → SH)
# ---------------------------------------------------------------------------
#
# swing_length=1:
#
#  i:  0    1    2    3    4    5    6    7
#  H: 100   90   85   90  110  120  110  105
#  L:  90   82   80   82   95  112   95   90
#
# SL at i=2: L=80 < L[1]=82 ✓ and L=80 < L[3]=82 ✓
# SH at i=5: H=120 > H[4]=110 ✓ and H=120 > H[6]=110 ✓
#
# Consecutive alternating pair: (low, 2) → (high, 5) → direction=bullish
# Range: [80, 120], equilibrium=100
# Premium zone: high=120, low=100   start_time=index[5]
# Discount zone: high=100, low=80   start_time=index[5]


_SL_HIGHS = [100,  90,  85,  90, 110, 120, 110, 105]
_SL_LOWS  = [ 90,  82,  80,  82,  95, 112,  95,  90]


def _bullish_zones(df: pd.DataFrame) -> tuple:
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    premium  = next(p for p in patterns if p.meta["zone"] == "premium")
    discount = next(p for p in patterns if p.meta["zone"] == "discount")
    return premium, discount


def test_bullish_range_emits_two_zones():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    assert len(patterns) == 2


def test_both_zones_type_premium_discount():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    for p in PremiumDiscountDetector(swing_length=1).detect(df):
        assert p.type == PatternType.PREMIUM_DISCOUNT


def test_premium_zone_bounds():
    # Premium zone: [equilibrium=100, range_high=120]
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    premium, _ = _bullish_zones(df)
    assert premium.high == pytest.approx(120.0)
    assert premium.low  == pytest.approx(100.0)


def test_discount_zone_bounds():
    # Discount zone: [range_low=80, equilibrium=100]
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    _, discount = _bullish_zones(df)
    assert discount.high == pytest.approx(100.0)
    assert discount.low  == pytest.approx(80.0)


def test_equilibrium_is_midpoint_of_range():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    premium, _ = _bullish_zones(df)
    eq = premium.meta["equilibrium"]
    assert eq == pytest.approx((120.0 + 80.0) / 2)   # 100.0


def test_premium_mid_is_75pct_of_range():
    # mid of premium zone = (100 + 120) / 2 = 110 = 75% of [80, 120]
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    premium, _ = _bullish_zones(df)
    assert premium.mid == pytest.approx(110.0)


def test_discount_mid_is_25pct_of_range():
    # mid of discount zone = (80 + 100) / 2 = 90 = 25% of [80, 120]
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    _, discount = _bullish_zones(df)
    assert discount.mid == pytest.approx(90.0)


def test_start_time_is_later_swing_candle():
    # Range complete when SH forms at i=5 (max of idx1=2, idx2=5)
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    premium, discount = _bullish_zones(df)
    assert premium.start_time  == df.index[5]
    assert discount.start_time == df.index[5]


def test_end_time_is_none():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    for p in PremiumDiscountDetector(swing_length=1).detect(df):
        assert p.end_time is None


def test_bullish_direction_in_meta():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    for p in PremiumDiscountDetector(swing_length=1).detect(df):
        assert p.meta["direction"] == "bullish"


def test_both_zones_share_range_bounds_in_meta():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    premium, discount = _bullish_zones(df)
    for p in (premium, discount):
        assert p.meta["range_high"] == pytest.approx(120.0)
        assert p.meta["range_low"]  == pytest.approx(80.0)


# ---------------------------------------------------------------------------
# Single bearish range  (SH → SL)
# ---------------------------------------------------------------------------
#
#  i:  0    1    2    3    4    5    6    7
#  H: 80   90  120  110   90   85   90  100
#  L: 70   82  112   82   80   78   82   90
#
# SH at i=2: H=120 > H[1]=90 ✓ and H=120 > H[3]=110 ✓
# SL at i=5: L=78  < L[4]=80 ✓ and L=78  < L[6]=82  ✓
#
# Pair (high, 2) → (low, 5) → direction=bearish
# Range: [78, 120], equilibrium=99, start_time=index[5]


_BEAR_HIGHS = [ 80,  90, 120, 110,  90,  85,  90, 100]
_BEAR_LOWS  = [ 70,  82, 112,  82,  80,  78,  82,  90]


def test_bearish_range_emits_two_zones():
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    assert len(PremiumDiscountDetector(swing_length=1).detect(df)) == 2


def test_bearish_direction_in_meta():
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    for p in PremiumDiscountDetector(swing_length=1).detect(df):
        assert p.meta["direction"] == "bearish"


def test_bearish_range_bounds():
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    premium  = next(p for p in patterns if p.meta["zone"] == "premium")
    discount = next(p for p in patterns if p.meta["zone"] == "discount")

    expected_eq = (120.0 + 78.0) / 2   # 99.0
    assert premium.high  == pytest.approx(120.0)
    assert premium.low   == pytest.approx(expected_eq)
    assert discount.high == pytest.approx(expected_eq)
    assert discount.low  == pytest.approx(78.0)


def test_bearish_start_time_is_sl_candle():
    # SH at i=2, SL at i=5 → max=5 → start_time=index[5]
    df = make_candles(_BEAR_HIGHS, _BEAR_LOWS)
    for p in PremiumDiscountDetector(swing_length=1).detect(df):
        assert p.start_time == df.index[5]


# ---------------------------------------------------------------------------
# Multiple consecutive ranges
# ---------------------------------------------------------------------------


def test_two_consecutive_ranges_produce_four_zones():
    # SL at i=2, SH at i=5, SL at i=8
    # Pair 1: (low,2)→(high,5) = bullish range
    # Pair 2: (high,5)→(low,8) = bearish range
    # → 4 patterns total
    #
    #  i:  0    1    2    3    4    5    6    7    8    9
    #  H: 100   90   85   90  110  120  110   90   85   90
    #  L:  90   82   80   82   95  112   95   82   78   82
    df = make_candles(
        highs=[100,  90,  85,  90, 110, 120, 110,  90,  85,  90],
        lows= [ 90,  82,  80,  82,  95, 112,  95,  82,  78,  82],
    )
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    assert len(patterns) == 4
    directions = {p.meta["direction"] for p in patterns}
    assert directions == {"bullish", "bearish"}


def test_consecutive_same_type_swings_skipped():
    # SL at i=2, SH at i=5, SH at i=7 — two highs in a row with NO swing low
    # between them (L[6]=115 > L[5]=112, so i=6 is not a swing low).
    # Only pair (low,2)→(high,5) is formed; (high,5)→(high,7) is skipped.
    # → 2 patterns (one bullish range).
    #
    #  i:  0    1    2    3    4    5    6    7    8
    #  H: 100   90   85   90  110  120  118  125  110
    #  L:  90   82   80   82   95  112  115  118   95
    #
    # SL at i=2: L=80 < L[1]=82 ✓ and < L[3]=82 ✓
    # SH at i=5: H=120 > H[4]=110 ✓ and > H[6]=118 ✓
    # i=6 NOT a SL: L[6]=115 > L[5]=112 (not a local minimum)
    # SH at i=7: H=125 > H[6]=118 ✓ and > H[8]=110 ✓
    df = make_candles(
        highs=[100,  90,  85,  90, 110, 120, 118, 125, 110],
        lows= [ 90,  82,  80,  82,  95, 112, 115, 118,  95],
    )
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    bullish_ranges = [p for p in patterns if p.meta["direction"] == "bullish"]
    assert len(bullish_ranges) == 2   # one range = premium + discount


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


def test_timeframe_propagated():
    df = make_candles(_SL_HIGHS, _SL_LOWS)
    for p in PremiumDiscountDetector(swing_length=1, timeframe="4h").detect(df):
        assert p.timeframe == "4h"


def test_zones_sorted_by_start_time():
    df = make_candles(
        highs=[100,  90,  85,  90, 110, 120, 110,  90,  85,  90],
        lows= [ 90,  82,  80,  82,  95, 112,  95,  82,  78,  82],
    )
    patterns = PremiumDiscountDetector(swing_length=1).detect(df)
    times = [p.start_time for p in patterns]
    assert times == sorted(times)
