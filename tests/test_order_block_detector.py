from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.order_blocks import OrderBlockDetector


def make_candles(
    opens: list[float],
    highs: list[float],
    lows: list[float],
    closes: list[float],
) -> pd.DataFrame:
    n = len(opens)
    timestamps = pd.date_range("2024-01-01", periods=n, freq="1h")
    return pd.DataFrame(
        {
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": [1000.0] * n,
        },
        index=timestamps,
    )


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_not_enough_candles_returns_empty():
    # swing_length=2 requires 2*2+1=5 bars; 4 bars → []
    df = make_candles([10, 9, 8, 7], [11, 10, 9, 8], [9, 8, 7, 6], [9, 8, 7, 8])
    assert OrderBlockDetector(swing_length=2).detect(df) == []


def test_no_ob_when_no_opposite_candle_in_lookback():
    # All bullish candles into swing low → no bearish candidate → no bullish OB.
    #
    # swing_length=1, lookback=3
    # Swing low at i=3 (L=86) — confirmed since L[2]=88>86 and L[4]=91>86.
    # But ALL candles i=0..3 are bullish (close > open) → no bearish OB found.
    #
    #  i:  0    1    2    3    4    5
    #  O: 88   89   88   86   91   95
    #  H: 92   93   92   91   95   99
    #  L: 87   88   87   85   90   94    ← swing low at i=3 (L=85)
    #  C: 91   92   91   89   94   98    ← all bullish
    df = make_candles(
        opens  = [88, 89, 88, 86, 91, 95],
        highs  = [92, 93, 92, 91, 95, 99],
        lows   = [87, 88, 87, 85, 90, 94],
        closes = [91, 92, 91, 89, 94, 98],
    )
    patterns = OrderBlockDetector(swing_length=1, lookback=3).detect(df)
    bullish_obs = [p for p in patterns if p.meta["direction"] == "bullish"]
    assert bullish_obs == []


# ---------------------------------------------------------------------------
# Bullish OB detection and zone
# ---------------------------------------------------------------------------
#
# Layout (swing_length=1, lookback=5):
#
#   i:  0    1    2    3    4    5    6    7    8
#   O: 100   97   93   89   94   98  102  106  110
#   H: 101   98   94   93   98  102  106  110  114
#   L:  96   92   88   87   94   98  102  106  110
#   C:  97   93   89   92   97  101  105  109  113
#
# Directions: i=0..2 bearish, i=3..8 bullish.
# Swing low: L[3]=87 < L[2]=88 ✓  and  L[3]=87 < L[4]=94 ✓  → swing low at i=3.
# Last bearish in [0..3]: i=2 (C=89 < O=93).
# Bullish OB zone: high = O[2] = 93, low = C[2] = 89.
# Recovery lows: 94, 98, 102, 106, 110 — all > 93 → never return to ob_high → unmitigated.

_BULL_OPENS  = [100, 97, 93, 89, 94,  98, 102, 106, 110]
_BULL_HIGHS  = [101, 98, 94, 93, 98, 102, 106, 110, 114]
_BULL_LOWS   = [ 96, 92, 88, 87, 94,  98, 102, 106, 110]
_BULL_CLOSES = [ 97, 93, 89, 92, 97, 101, 105, 109, 113]


def test_bullish_ob_detected_at_swing_low():
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    patterns = OrderBlockDetector(swing_length=1, lookback=5).detect(df)
    obs = [p for p in patterns if p.meta["direction"] == "bullish"]
    assert len(obs) == 1


def test_bullish_ob_type_is_order_block():
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1).detect(df)[0]
    assert p.type == PatternType.ORDER_BLOCK


def test_bullish_ob_zone_uses_body_of_bearish_candle():
    # OB is the bearish candle at i=2: O=93, C=89 → high=93, low=89
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1).detect(df)[0]
    assert p.high == pytest.approx(93.0)
    assert p.low == pytest.approx(89.0)


def test_bullish_ob_start_time_is_ob_candle():
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1).detect(df)[0]
    assert p.start_time == df.index[2]   # the bearish OB candle


def test_bullish_ob_unmitigated_has_no_end_time():
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1).detect(df)[0]
    assert p.end_time is None
    assert p.meta["mitigated"] is False


def test_bullish_ob_mitigated_when_price_returns():
    # Same down-leg and swing low as above, but then price PULLS BACK into the OB.
    #
    # After the swing low at i=3, price rallies to i=6 (close=105 > ob_high=93 → above=True).
    # At i=7: L=91 ≤ ob_high=93 → MITIGATED at i=7.
    #
    #  i:  0    1    2    3    4    5    6    7    8
    #  O: 100   97   93   89   94   98  102   97   93
    #  H: 101   98   94   93   98  102  107  100   96
    #  L:  96   92   88   87   94   98  102   91   88
    #  C:  97   93   89   92   97  101  105   94   90   ← pullback at i=7,8
    df = make_candles(
        opens  = [100, 97, 93, 89, 94,  98, 102,  97,  93],
        highs  = [101, 98, 94, 93, 98, 102, 107, 100,  96],
        lows   = [ 96, 92, 88, 87, 94,  98, 102,  91,  88],
        closes = [ 97, 93, 89, 92, 97, 101, 105,  94,  90],
    )
    p = OrderBlockDetector(swing_length=1).detect(df)[0]
    assert p.meta["mitigated"] is True
    assert p.end_time == df.index[7]


# ---------------------------------------------------------------------------
# Bearish OB detection and zone
# ---------------------------------------------------------------------------
#
# Layout (swing_length=1, lookback=5):
#
#   i:  0    1    2    3    4    5    6    7    8
#   O: 100  103  107  111  106  100   94   88   82
#   H: 104  108  112  113  107  101   95   89   83
#   L:  99  102  106  106   99   93   87   81   75
#   C: 103  107  111  107  100   94   88   82   76
#
# Directions: i=0..2 bullish, i=3..8 bearish (reversal at i=3).
# Swing high: H[3]=113 > H[2]=112 ✓  and  H[3]=113 > H[4]=107 ✓  → swing high at i=3.
# Last bullish in [0..3]: i=2 (C=111 > O=107).
# Bearish OB zone: high = C[2] = 111, low = O[2] = 107.
#
# Mitigation (starts from i=4):
#   Phase 1 needs C < ob_low=107.
#   i=4: check above (below=False) → no mit. C=100 < 107 → below=True.
#   i=5..8: H stays 101, 95, 89, 83 — all < 107 → never re-enter OB → unmitigated.

_BEAR_OPENS  = [100, 103, 107, 111, 106, 100, 94, 88, 82]
_BEAR_HIGHS  = [104, 108, 112, 113, 107, 101, 95, 89, 83]
_BEAR_LOWS   = [ 99, 102, 106, 106,  99,  93, 87, 81, 75]
_BEAR_CLOSES = [103, 107, 111, 107, 100,  94, 88, 82, 76]


def test_bearish_ob_detected_at_swing_high():
    df = make_candles(_BEAR_OPENS, _BEAR_HIGHS, _BEAR_LOWS, _BEAR_CLOSES)
    patterns = OrderBlockDetector(swing_length=1).detect(df)
    obs = [p for p in patterns if p.meta["direction"] == "bearish"]
    assert len(obs) == 1


def test_bearish_ob_zone_uses_body_of_bullish_candle():
    # OB is the bullish candle at i=2: O=107, C=111 → low=107, high=111
    df = make_candles(_BEAR_OPENS, _BEAR_HIGHS, _BEAR_LOWS, _BEAR_CLOSES)
    obs = [p for p in OrderBlockDetector(swing_length=1).detect(df) if p.meta["direction"] == "bearish"]
    p = obs[0]
    assert p.high == pytest.approx(111.0)
    assert p.low == pytest.approx(107.0)


def test_bearish_ob_start_time_is_ob_candle():
    df = make_candles(_BEAR_OPENS, _BEAR_HIGHS, _BEAR_LOWS, _BEAR_CLOSES)
    obs = [p for p in OrderBlockDetector(swing_length=1).detect(df) if p.meta["direction"] == "bearish"]
    assert obs[0].start_time == df.index[2]


def test_bearish_ob_unmitigated_has_no_end_time():
    df = make_candles(_BEAR_OPENS, _BEAR_HIGHS, _BEAR_LOWS, _BEAR_CLOSES)
    obs = [p for p in OrderBlockDetector(swing_length=1).detect(df) if p.meta["direction"] == "bearish"]
    assert obs[0].end_time is None
    assert obs[0].meta["mitigated"] is False


def test_bearish_ob_mitigated_when_price_rallies_back():
    # Same up-leg and swing high as above, but then price RALLIES back into the OB.
    #
    # After the swing high at i=3, price drops (i=4..6), then recovers.
    # Phase 1: C[4]=100 < ob_low=107 → below=True.
    # Phase 2: H[7]=109 ≥ ob_low=107 → MITIGATED at i=7.
    #
    #  i:  0    1    2    3    4    5    6    7    8
    #  O: 100  103  107  111   98   94   96  104  108
    #  H: 104  108  112  113  101   97  100  109  112
    #  L:  99  102  106  106   94   90   93  102  106
    #  C: 103  107  111  107  100   94   98  108  111
    df = make_candles(
        opens  = [100, 103, 107, 111,  98,  94,  96, 104, 108],
        highs  = [104, 108, 112, 113, 101,  97, 100, 109, 112],
        lows   = [ 99, 102, 106, 106,  94,  90,  93, 102, 106],
        closes = [103, 107, 111, 107, 100,  94,  98, 108, 111],
    )
    obs = [p for p in OrderBlockDetector(swing_length=1).detect(df) if p.meta["direction"] == "bearish"]
    assert obs[0].meta["mitigated"] is True
    assert obs[0].end_time == df.index[7]


# ---------------------------------------------------------------------------
# Miscellaneous
# ---------------------------------------------------------------------------


def test_timeframe_propagated_to_pattern():
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1, timeframe="4h").detect(df)[0]
    assert p.timeframe == "4h"


def test_ob_candle_can_be_swing_candle_itself():
    # If the swing low bar is bearish (close < open), it becomes the OB itself.
    #
    #  i:  0    1    2    3    4    5
    #  O: 100   97   93   95   98  102    ← i=2: bearish (C=89<O=93), i=3: bearish swing low
    #  H: 101   98   94   96   99  103
    #  L:  96   92   88   84   94   98    ← swing low at i=3 (L=84 < L[2]=88 and < L[4]=94)
    #  C:  97   93   89   86   97  101    ← i=3: C=86 < O=95 → bearish, so i=3 is the OB
    df = make_candles(
        opens  = [100, 97, 93, 95, 98, 102],
        highs  = [101, 98, 94, 96, 99, 103],
        lows   = [ 96, 92, 88, 84, 94,  98],
        closes = [ 97, 93, 89, 86, 97, 101],
    )
    patterns = OrderBlockDetector(swing_length=1, lookback=5).detect(df)
    bullish_obs = [p for p in patterns if p.meta["direction"] == "bullish"]
    assert len(bullish_obs) >= 1
    # The OB is i=3 (the swing low bar) because it's the LAST bearish candle
    p = bullish_obs[-1]
    assert p.high == pytest.approx(95.0)   # open of i=3
    assert p.low  == pytest.approx(86.0)   # close of i=3


def test_lookback_limits_search_window():
    # With lookback=1, only i=3 itself is searched for a bearish candle.
    # i=3 is bearish (C=86 < O=95) → OB found at i=3.
    # With lookback=0, only i=3 checked — same result here.
    df = make_candles(
        opens  = [100, 97, 93, 95, 98, 102],
        highs  = [101, 98, 94, 96, 99, 103],
        lows   = [ 96, 92, 88, 84, 94,  98],
        closes = [ 97, 93, 89, 86, 97, 101],
    )
    # lookback=0 → only the swing candle itself is searched
    patterns_0 = OrderBlockDetector(swing_length=1, lookback=0).detect(df)
    obs_0 = [p for p in patterns_0 if p.meta["direction"] == "bullish"]
    assert len(obs_0) == 1
    assert obs_0[0].start_time == df.index[3]

    # lookback=5 → earlier candles also searched; last bearish is still i=3
    patterns_5 = OrderBlockDetector(swing_length=1, lookback=5).detect(df)
    obs_5 = [p for p in patterns_5 if p.meta["direction"] == "bullish"]
    assert obs_5[-1].start_time == df.index[3]


def test_use_body_false_uses_full_candle_range():
    # With use_body=False, OB zone = full candle (H, L) instead of body (O, C).
    df = make_candles(_BULL_OPENS, _BULL_HIGHS, _BULL_LOWS, _BULL_CLOSES)
    p = OrderBlockDetector(swing_length=1, use_body=False).detect(df)[0]
    # OB candle is i=2: H=94, L=88
    assert p.high == pytest.approx(94.0)
    assert p.low == pytest.approx(88.0)
