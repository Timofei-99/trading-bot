from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.liquidity import LiquidityDetector


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
    # swing_length=2 needs at least 2*2+1=5 bars
    df = make_candles([10, 15, 12, 8], [7, 11, 8, 5])
    assert LiquidityDetector(swing_length=2).detect(df) == []


def test_no_levels_when_no_swing_points():
    # Monotonically rising series — no swing highs or lows possible.
    #  i:  0   1   2   3   4   5
    #  H: 10  12  14  16  18  20
    #  L:  8  10  12  14  16  18
    # With n=1, swing high needs H[i] > H[i-1] AND H[i] > H[i+1].
    # No bar satisfies this in a strictly rising sequence.
    df = make_candles(
        highs=[10, 12, 14, 16, 18, 20],
        lows=[ 8, 10, 12, 14, 16, 18],
    )
    assert LiquidityDetector(swing_length=1).detect(df) == []


# ---------------------------------------------------------------------------
# BSL (Buy Side Liquidity) — swing highs
# ---------------------------------------------------------------------------
#
# swing_length=1:
#
#  i:  0   1   2   3   4   5   6
#  H: 10  15  20  14  12  12  18     ← swing high at i=2 (H=20 > 15 and > 14)
#  L:  7  12  17  10   8   8  14
#
# BSL at i=2, price=20. Bars i=3..6 have H: 14, 12, 12, 18 — all ≤ 20 → UNSWEPT.


_BSL_HIGHS = [10, 15, 20, 14, 12, 12, 18]
_BSL_LOWS  = [ 7, 12, 17, 10,  8,  8, 14]


def test_bsl_detected_at_swing_high():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    levels = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"]
    assert len(levels) == 1


def test_bsl_type_is_liquidity():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.type == PatternType.LIQUIDITY


def test_bsl_price_equals_swing_high():
    # BSL level = the exact high of the swing candle (i=2, H=20)
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.high == pytest.approx(20.0)
    assert p.low  == pytest.approx(20.0)   # price line: high == low


def test_bsl_start_time_is_swing_candle():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.start_time == df.index[2]


def test_bsl_unswept():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.end_time is None
    assert p.meta["swept"] is False


def test_bsl_swept_when_wick_exceeds_level():
    # Append bar with H=21 > BSL=20 → swept at that bar.
    # Note: the bar may CLOSE below 20 (close = (21+17)/2 = 19) — wick only is enough.
    #
    #  i:  0   1   2   3   4   5   6   7
    #  H: 10  15  20  14  12  12  18  21   ← i=7: H=21 > 20 → SWEPT
    #  L:  7  12  17  10   8   8  14  17
    df = make_candles(
        highs=[10, 15, 20, 14, 12, 12, 18, 21],
        lows=[ 7, 12, 17, 10,  8,  8, 14, 17],
    )
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.meta["swept"] is True
    assert p.end_time == df.index[7]


def test_bsl_wick_sweep_close_can_be_below_level():
    # Sweep is detected by HIGH, not by close.  Close=19 < BSL=20, yet swept.
    #
    #  The bar at i=7 in the test above has: H=21, L=17 → close=(21+17)/2=19 < 20.
    #  Despite the close being below the BSL, the wick (H=21) triggers the sweep.
    df = make_candles(
        highs=[10, 15, 20, 14, 12, 12, 18, 21],
        lows=[ 7, 12, 17, 10,  8,  8, 14, 17],   # close[7] = 19 < BSL = 20
    )
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    close_at_sweep = (21 + 17) / 2   # = 19
    assert close_at_sweep < 20.0     # confirm close is below BSL
    assert p.meta["swept"] is True   # but sweep still triggered


def test_bsl_equal_high_does_not_sweep():
    # A candle whose HIGH == BSL price does NOT count as a sweep (strict >).
    #  i=7: H=20 == BSL=20 → no sweep.  i=8: H=21 > 20 → swept.
    df = make_candles(
        highs=[10, 15, 20, 14, 12, 12, 18, 20, 21],
        lows=[ 7, 12, 17, 10,  8,  8, 14, 16, 17],
    )
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "buy"][0]
    assert p.end_time == df.index[8]   # swept at i=8, not i=7


# ---------------------------------------------------------------------------
# SSL (Sell Side Liquidity) — swing lows
# ---------------------------------------------------------------------------
#
# swing_length=1:
#
#  i:  0   1   2   3   4   5   6
#  H: 20  15  10  14  18  18  12     ← swing low at i=2 (L=6 < 10 and < 10)
#  L: 14  10   6  10  14  14   8
#
# SSL at i=2, price=6. Bars i=3..6 have L: 10, 14, 14, 8 — all ≥ 6 → UNSWEPT.


_SSL_HIGHS = [20, 15, 10, 14, 18, 18, 12]
_SSL_LOWS  = [14, 10,  6, 10, 14, 14,  8]


def test_ssl_detected_at_swing_low():
    df = make_candles(_SSL_HIGHS, _SSL_LOWS)
    levels = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "sell"]
    assert len(levels) == 1


def test_ssl_price_equals_swing_low():
    df = make_candles(_SSL_HIGHS, _SSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "sell"][0]
    assert p.high == pytest.approx(6.0)
    assert p.low  == pytest.approx(6.0)


def test_ssl_unswept():
    df = make_candles(_SSL_HIGHS, _SSL_LOWS)
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "sell"][0]
    assert p.end_time is None
    assert p.meta["swept"] is False


def test_ssl_swept_when_wick_goes_below_level():
    # Append bar with L=5 < SSL=6 → swept.
    df = make_candles(
        highs=[20, 15, 10, 14, 18, 18, 12,  9],
        lows= [14, 10,  6, 10, 14, 14,  8,  5],
    )
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "sell"][0]
    assert p.meta["swept"] is True
    assert p.end_time == df.index[7]


def test_ssl_equal_low_does_not_sweep():
    # L == SSL price → no sweep (strict <).
    df = make_candles(
        highs=[20, 15, 10, 14, 18, 18, 12,  9,  8],
        lows= [14, 10,  6, 10, 14, 14,  8,  6,  5],
    )
    p = [p for p in LiquidityDetector(swing_length=1).detect(df) if p.meta["side"] == "sell"][0]
    assert p.end_time == df.index[8]   # swept at i=8 (L=5), not i=7 (L=6)


# ---------------------------------------------------------------------------
# Mixed and misc
# ---------------------------------------------------------------------------


def test_both_bsl_and_ssl_detected_in_same_series():
    # Series with both a swing high (BSL) and a swing low (SSL).
    #
    #  i:  0   1   2   3   4   5   6
    #  H: 10  20  18  14  16  10   8     ← swing high at i=1 (H=20 > 10 and > 18)
    #  L:  7  15  12   6   8   5   3     ← swing low  at i=3 (L=6  < 12 and < 8)
    df = make_candles(
        highs=[10, 20, 18, 14, 16, 10, 8],
        lows=[ 7, 15, 12,  6,  8,  5, 3],
    )
    patterns = LiquidityDetector(swing_length=1).detect(df)
    bsl = [p for p in patterns if p.meta["side"] == "buy"]
    ssl = [p for p in patterns if p.meta["side"] == "sell"]
    assert len(bsl) >= 1
    assert len(ssl) >= 1


def test_levels_sorted_by_start_time():
    # Multiple levels should be returned in chronological order.
    df = make_candles(
        highs=[10, 20, 18, 14, 16, 10, 8],
        lows=[ 7, 15, 12,  6,  8,  5, 3],
    )
    patterns = LiquidityDetector(swing_length=1).detect(df)
    times = [p.start_time for p in patterns]
    assert times == sorted(times)


def test_price_line_has_equal_high_and_low():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    for p in LiquidityDetector(swing_length=1).detect(df):
        assert p.high == p.low


def test_timeframe_propagated():
    df = make_candles(_BSL_HIGHS, _BSL_LOWS)
    patterns = LiquidityDetector(swing_length=1, timeframe="1h").detect(df)
    assert all(p.timeframe == "1h" for p in patterns)
