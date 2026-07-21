"""Tests for OB4hFVG15mStrategy.

The strategy requires three conditions simultaneously:
  1. Unmitigated bullish OB on HTF whose mid is in the discount zone.
  2. Bullish FVG on LTF being mitigated on the current (last) bar,
     with its zone overlapping the OB.
  3. At least one SSL swept on LTF within the lookback window.

Fixture construction strategy
------------------------------
Rather than loading real market data we build synthetic candle series that
deterministically satisfy (or violate) each condition.  Each test patches
exactly one condition and asserts the correct outcome.
"""
from __future__ import annotations

import pandas as pd
import pytest

from core.market_context import MarketContext
from core.signal import Direction
from strategies.ob_4h_fvg_15m import OB4hFVG15mStrategy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _candles(
    opens, highs, lows, closes, freq: str = "4h"
) -> pd.DataFrame:
    n = len(opens)
    return pd.DataFrame(
        {
            "open":   opens,
            "high":   highs,
            "low":    lows,
            "close":  closes,
            "volume": [1000.0] * n,
        },
        index=pd.date_range("2024-01-01", periods=n, freq=freq),
    )


def _make_context(htf_df: pd.DataFrame, ltf_df: pd.DataFrame) -> MarketContext:
    ctx = MarketContext(symbol="BTCUSDT", timeframes=["4h", "15m"])
    ctx.load("4h",  htf_df)
    ctx.load("15m", ltf_df)
    return ctx


# ---------------------------------------------------------------------------
# Minimal valid scenario builder
#
# HTF (4h) — 14 bars:
#   Bullish dealing range: SL at i=3 (L=80), SH at i=7 (H=120).
#   Equilibrium = (80+120)/2 = 100.
#   Bullish OB = last bearish candle before the swing low at i=3
#     → i=2: open=95, close=90 (bearish body).  OB zone = [90, 95].
#   OB.mid = 92.5 < 100 → in discount ✓
#   OB is unmitigated because price never closes above 95 and returns
#   within the dataset (we skip mitigation bars).
#
# LTF (15m) — 30 bars:
#   SSL sweep: swing low at i=10 (L=91), swept at i=22 (low=90.5).
#   Bullish FVG at bars [24, 25, 26]:
#     C[24].high = 91.5,  C[26].low = 93.0  → gap = 91.5–93.0
#     FVG zone = [91.5, 93.0] — inside OB zone [90, 95] ✓
#   Mitigation (current bar, i=29): low = 92.5 ≤ fvg_high=93.0 ✓
# ---------------------------------------------------------------------------

def _make_htf() -> pd.DataFrame:
    # 14-bar 4h series.  Properties we need:
    #   SL at i=3 (L=80)  — swing_length=3: L[0:3]>80 and L[4:7]>80 ✓
    #   SH at i=7 (H=120) — H[4:7]<120 and H[8:11]<120 ✓
    #   Bullish OB = last bearish candle at or before i=3 within lookback=5.
    #     i=3: open=93, close=87 → bearish → OB zone [87, 93], mid=90.
    #   OB unmitigated: phase-1 of mitigation (close > ob_high=93) never fires
    #     because all closes from i=4 onward are 87 ≤ 93.
    #   Dealing range: SL=80, SH=120, equilibrium=100.
    #   OB.mid=90 ≤ 100 → in discount ✓
    #
    #  i:  0    1    2    3    4    5    6    7    8–13
    # O: 105  100   95   93   93   93   93   93   93
    # H: 110  105   98   93   93   93   93  120   93
    # L: 100   95   88   80   85   85   85   85   85
    # C: 108   98   90   87   87   87   87   87   87
    opens  = [105, 100,  95,  93,  93,  93,  93,  93,  93,  93,  93,  93,  93,  93]
    highs  = [110, 105,  98,  93,  93,  93,  93, 120,  93,  93,  93,  93,  93,  93]
    lows   = [100,  95,  88,  80,  85,  85,  85,  85,  85,  85,  85,  85,  85,  85]
    closes = [108,  98,  90,  87,  87,  87,  87,  87,  87,  87,  87,  87,  87,  87]
    return _candles(opens, highs, lows, closes, freq="4h")


def _make_ltf_valid() -> pd.DataFrame:
    """30-bar 15min series satisfying all LTF conditions.

    SSL: swing low at i=10 (L=91.0), swept at i=22 (low=90.5).
    FVG: bullish gap between C[24].high=91.5 and C[26].low=93.0.
         Mitigated on current bar i=29 (low=92.5 ≤ fvg_high=93.0).
    FVG zone [91.5, 93.0] overlaps OB zone [87, 93]: 91.5<93 and 93.0>87 ✓
    """
    n = 30
    opens  = [94.0] * n
    highs  = [96.0] * n
    lows   = [92.0] * n
    closes = [95.0] * n

    # SSL: swing low at i=10 (L=91) — needs L[7:10] > 91 and L[11:14] > 91
    for i in [7, 8, 9]:
        lows[i]   = 92.5
        opens[i]  = 93.0
        highs[i]  = 96.0
        closes[i] = 95.0
    opens[10]  = 94.0
    highs[10]  = 95.0
    lows[10]   = 91.0    # swing low
    closes[10] = 94.5
    for i in [11, 12, 13]:
        lows[i]   = 92.5

    # SSL sweep at i=22: low < 91.0
    lows[22]   = 90.5
    closes[22] = 94.0

    # FVG at bars 24, 25, 26:
    #   C[24].high = 91.5  C[26].low = 93.0  → gap exists (bullish)
    highs[24]  = 91.5
    closes[24] = 91.0
    opens[24]  = 90.5
    lows[24]   = 90.0
    # C[25] = impulse candle, large bullish
    opens[25]  = 91.0
    highs[25]  = 94.5
    lows[25]   = 90.8
    closes[25] = 94.0
    # C[26]: low = 93.0 → gap = [91.5, 93.0]
    opens[26]  = 93.5
    highs[26]  = 95.0
    lows[26]   = 93.0
    closes[26] = 94.5

    # Bars 27, 28: price stays above 93 (does NOT trigger mitigation)
    for i in [27, 28]:
        opens[i]  = 94.0
        highs[i]  = 95.0
        lows[i]   = 93.1   # strictly above fvg_high=93.0
        closes[i] = 94.5

    # Bar 29 (current): low = 92.5 ≤ fvg_high=93.0 → mitigation triggered
    opens[29]  = 94.0
    highs[29]  = 94.5
    lows[29]   = 92.5
    closes[29] = 93.0

    return _candles(opens, highs, lows, closes, freq="15min")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_valid_setup_produces_long_signal():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    strat = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
        ob_lookback=5, liquidity_sweep_lookback=20,
    )
    signal = strat.check_entry(ctx)

    assert signal is not None
    assert signal.direction == Direction.LONG
    assert signal.symbol == "BTCUSDT"
    assert signal.strategy_name == "OB_4h_FVG_15m"


def test_signal_entry_equals_fvg_high():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
    ).check_entry(ctx)

    assert signal is not None
    assert signal.entry == pytest.approx(93.0)  # fvg_high = C[26].low = 93.0


def test_signal_stop_below_ob_low():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
    ).check_entry(ctx)

    assert signal is not None
    # OB is the bearish candle at i=3: open=93, close=87 → ob.low = 87
    assert signal.stop_loss == pytest.approx(87.0)


def test_signal_take_profit_above_entry():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
        min_rr=2.0,
    ).check_entry(ctx)

    assert signal is not None
    assert signal.take_profit > signal.entry


def test_min_rr_fallback_when_no_bsl():
    """When no unswept BSL is found, TP = entry + min_rr * risk."""
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    strat = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
        min_rr=3.0,
    )
    signal = strat.check_entry(ctx)

    if signal is not None:
        # At minimum, TP must be at least min_rr * risk above entry
        min_tp = signal.entry + strat.min_rr * signal.risk_amount
        assert signal.take_profit >= min_tp - 1e-9


def test_no_signal_when_ltf_empty():
    htf = _make_htf()
    ctx = MarketContext(symbol="BTCUSDT", timeframes=["4h", "15m"])
    ctx.load("4h", htf)
    ctx.load("15m", pd.DataFrame())

    signal = OB4hFVG15mStrategy(htf="4h", ltf="15m").check_entry(ctx)
    assert signal is None


def test_no_signal_when_htf_empty():
    ltf = _make_ltf_valid()
    ctx = MarketContext(symbol="BTCUSDT", timeframes=["4h", "15m"])
    ctx.load("4h", pd.DataFrame())
    ctx.load("15m", ltf)

    signal = OB4hFVG15mStrategy(htf="4h", ltf="15m").check_entry(ctx)
    assert signal is None


def test_no_signal_when_no_ssl_sweep():
    """All SSL sweeps are older than the lookback window → no signal.

    The valid fixture has sweeps at bars 22 and 24 (both within lookback=20).
    With lookback=4 (only bars 26-29), neither sweep falls in the window.
    Bar 24's SSL (L=90.0) is not swept at all within bars 25-29 (all lows >90).
    Bar 10's SSL (L=91.0) is swept at bar 22 — outside the 4-bar window.
    """
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
        liquidity_sweep_lookback=4,
    ).check_entry(ctx)

    assert signal is None


def test_no_signal_when_fvg_not_being_mitigated_now():
    """FVG exists but not being touched on the current bar → no signal."""
    ltf = _make_ltf_valid().copy()
    # Change current bar (i=29) so its low stays above fvg_high=93.0
    ltf.at[ltf.index[29], "low"] = 93.5

    ctx = _make_context(_make_htf(), ltf)
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
    ).check_entry(ctx)

    assert signal is None


def test_triggered_by_contains_expected_labels():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
    ).check_entry(ctx)

    assert signal is not None
    assert "4h_ob" in signal.triggered_by
    assert "15m_fvg" in signal.triggered_by
    assert "15m_ssl_sweep" in signal.triggered_by


def test_meta_contains_zone_info():
    ctx = _make_context(_make_htf(), _make_ltf_valid())
    signal = OB4hFVG15mStrategy(
        htf="4h", ltf="15m",
        swing_length_htf=3, swing_length_ltf=3,
    ).check_entry(ctx)

    assert signal is not None
    assert "ob_zone" in signal.meta
    assert "fvg_zone" in signal.meta
    assert len(signal.meta["ob_zone"]) == 2
    assert len(signal.meta["fvg_zone"]) == 2
