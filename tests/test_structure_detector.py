from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.structure import StructureDetector


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
    # swing_length=2 requires at least 2*2+2=6 bars
    df = make_candles([10, 20, 30, 15], [8, 18, 28, 12])
    assert StructureDetector(swing_length=2).detect(df) == []


def test_no_patterns_when_price_never_breaks_swing():
    # Price oscillates inside swings: no close ever exceeds a confirmed SH or SL.
    #
    # swing_length=1
    # SH at i=2 (H=20), SL at i=4 (L=5)
    # Subsequent closes stay between 6 and 19 → no break
    #
    #  i:  0   1   2   3   4   5   6   7   8
    #  H: 10  15  20  12   9  12  15  12  10
    #  L:  8  12  18   9   5   9  12   9   7
    #  C:  9  13  19  10   7  10  13  10   8   ← all < 20 and > 5
    highs = [10, 15, 20, 12,  9, 12, 15, 12, 10]
    lows  = [ 8, 12, 18,  9,  5,  9, 12,  9,  7]
    df = make_candles(highs, lows)
    assert StructureDetector(swing_length=1).detect(df) == []


# ---------------------------------------------------------------------------
# BOS / CHOCH classification
# ---------------------------------------------------------------------------


def test_first_bullish_break_is_choch():
    # swing_length=1
    #
    # SH at i=2 (H=20): H[2]=20 > H[1]=15 and > H[3]=12 ✓
    # SL at i=4 (L=7):  L[4]=7  < L[3]=9  and < L[5]=9  ✓
    #
    # Confirmation:
    #   SH i=2 ready when  2+1 < i  →  i ≥ 4
    #   SL i=4 ready when  4+1 < i  →  i ≥ 6
    #
    # At i=6: C=(22+19)/2=20.5  > sh_price=20  → bullish break, trend was None → CHOCH
    #
    #  i:  0   1   2   3   4   5   6
    #  H: 10  15  20  12  10  12  22
    #  L:  8  12  18   9   7   9  19
    highs = [10, 15, 20, 12, 10, 12, 22]
    lows  = [ 8, 12, 18,  9,  7,  9, 19]
    df = make_candles(highs, lows)

    patterns = StructureDetector(swing_length=1).detect(df)

    assert len(patterns) == 1
    p = patterns[0]
    assert p.type == PatternType.CHOCH
    assert p.meta["direction"] == "bullish"
    assert p.meta["broken_level"] == pytest.approx(20.0)
    assert p.start_time == df.index[2]  # swing high bar
    assert p.end_time == df.index[6]    # break bar


def test_first_bearish_break_is_choch():
    # swing_length=1
    #
    # SL at i=2 (L=18): L[2]=18 < L[1]=22 and < L[3]=20 ✓
    # SH at i=4 (H=25): H[4]=25 > H[3]=22 and > H[5]=20 ✓
    #
    # Confirmation:
    #   SL i=2 ready when  3 < i  →  i ≥ 4
    #   SH i=4 ready when  5 < i  →  i ≥ 6
    #
    # At i=6: C=(15+12)/2=13.5  < sl_price=18  → bearish break, trend was None → CHOCH
    #
    #  i:  0   1   2   3   4   5   6
    #  H: 30  25  20  22  25  20  15
    #  L: 28  22  18  20  23  18  12
    highs = [30, 25, 20, 22, 25, 20, 15]
    lows  = [28, 22, 18, 20, 23, 18, 12]
    df = make_candles(highs, lows)

    patterns = StructureDetector(swing_length=1).detect(df)

    assert len(patterns) == 1
    p = patterns[0]
    assert p.type == PatternType.CHOCH
    assert p.meta["direction"] == "bearish"
    assert p.meta["broken_level"] == pytest.approx(18.0)
    assert p.start_time == df.index[2]  # swing low bar
    assert p.end_time == df.index[6]    # break bar


def test_second_bullish_break_is_bos():
    # swing_length=1
    #
    # SH at i=2  (H=20): 20 > 15, 20 > 12  ✓
    # SL at i=4  (L=7):   7 <  9,  7 <  9  ✓
    # SH at i=8  (H=30): 30 > 23, 30 > 22  ✓
    # SL at i=9  (L=19): 19 < 27, 19 < 22  ✓  (used as guard only, not broken)
    #
    # At i=6:  C=20.5 > SH[i=2]=20  → CHOCH bullish  (trend was None)
    #          current_sh reset to None
    # At i=10: SH[i=8] confirmed (9<10). C=23.5 < 30  → no break.
    # At i=11: SL[i=9] confirmed (10<11). C=33.5 > SH[i=8]=30 → BOS bullish (trend="bullish")
    #
    #  i:  0   1   2   3   4   5   6   7   8   9  10  11
    #  H: 10  15  20  12  10  12  22  23  30  22  25  35
    #  L:  8  12  18   9   7   9  19  20  27  19  22  32
    highs = [10, 15, 20, 12, 10, 12, 22, 23, 30, 22, 25, 35]
    lows  = [ 8, 12, 18,  9,  7,  9, 19, 20, 27, 19, 22, 32]
    df = make_candles(highs, lows)

    patterns = StructureDetector(swing_length=1).detect(df)

    assert len(patterns) == 2

    choch = patterns[0]
    assert choch.type == PatternType.CHOCH
    assert choch.meta["direction"] == "bullish"
    assert choch.meta["broken_level"] == pytest.approx(20.0)
    assert choch.end_time == df.index[6]

    bos = patterns[1]
    assert bos.type == PatternType.BOS
    assert bos.meta["direction"] == "bullish"
    assert bos.meta["broken_level"] == pytest.approx(30.0)
    assert bos.start_time == df.index[8]
    assert bos.end_time == df.index[11]


def test_choch_followed_by_bos_bearish():
    # swing_length=1
    #
    # Mirror of the bullish test: establish bearish trend via CHOCH,
    # then confirm with BOS bearish.
    #
    # SH at i=4  (H=25): 25 > 22, 25 > 20  ✓
    # SL at i=2  (L=18): 18 < 22, 18 < 20  ✓   ← first break = CHOCH bearish
    # SL at i=8  (L=10): 10 < 12, 10 < 12  ✓   ← second break = BOS  bearish
    # SH at i=9  (H=18):                         ← guard (needs to be confirmed before i=11)
    #
    #  i:  0   1   2   3   4   5   6   7   8   9  10  11
    #  H: 30  25  20  22  25  20  18  17  14  18  16  12
    #  L: 28  22  18  20  23  18  15  14  10  15  13   8
    #
    # At i=6: SH[4] confirmed (5<6). C=(18+15)/2=16.5. SL[2]=18. 16.5 < 18 → CHOCH bearish.
    # At i=9: SH at i=9? H=18 > H[8]=14 ✓ and > H[10]=16 ✓ → SH at i=9. Confirmed at i=11.
    # At i=8: SL? L=10 < L[7]=14 ✓ and < L[9]=15 ✓ → SL at i=8. Confirmed at 9<i → i=10.
    # At i=10: SL[8] confirmed (9<10). C=(16+13)/2=14.5. SH: SH[4] was consumed. SH[9]: 10<10 False. No SH yet.
    # At i=11: SH[9] confirmed (10<11). current_sh=9 (H=18). SL[8]=10 (L[8]=10).
    #          C=(12+8)/2=10. SH=18, SL=10. 10 < 10? NO (not strictly less). Hmm.
    #
    # Need C < L[8]=10. C=10 is not < 10. Need to lower the close.
    # Let me adjust: lows[11]=7 so C=(12+7)/2=9.5. 9.5 < 10 → YES!
    highs = [30, 25, 20, 22, 25, 20, 18, 17, 14, 18, 16, 12]
    lows  = [28, 22, 18, 20, 23, 18, 15, 14, 10, 15, 13,  7]
    df = make_candles(highs, lows)

    patterns = StructureDetector(swing_length=1).detect(df)

    assert len(patterns) == 2

    choch = patterns[0]
    assert choch.type == PatternType.CHOCH
    assert choch.meta["direction"] == "bearish"
    assert choch.meta["broken_level"] == pytest.approx(18.0)

    bos = patterns[1]
    assert bos.type == PatternType.BOS
    assert bos.meta["direction"] == "bearish"
    assert bos.meta["broken_level"] == pytest.approx(10.0)
    assert bos.start_time == df.index[8]


# ---------------------------------------------------------------------------
# Swing pivot detection (tested indirectly via detect output)
# ---------------------------------------------------------------------------


def test_timeframe_is_propagated_to_patterns():
    highs = [10, 15, 20, 12, 10, 12, 22]
    lows  = [ 8, 12, 18,  9,  7,  9, 19]
    df = make_candles(highs, lows)

    patterns = StructureDetector(swing_length=1, timeframe="4h").detect(df)

    assert len(patterns) == 1
    assert patterns[0].timeframe == "4h"


def test_pattern_high_equals_low_equals_broken_level():
    # BOS/CHOCH is a price line, not a zone: high == low == broken_level
    highs = [10, 15, 20, 12, 10, 12, 22]
    lows  = [ 8, 12, 18,  9,  7,  9, 19]
    df = make_candles(highs, lows)

    p = StructureDetector(swing_length=1).detect(df)[0]

    assert p.high == p.low == p.meta["broken_level"]
