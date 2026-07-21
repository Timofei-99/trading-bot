from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.killzones import KillzoneDetector

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
#
# make_hourly_candles(n_days) builds n_days*24 one-hour candles starting at
# 2024-01-01 00:00 UTC.  Candle at absolute-hour index i has:
#   high  = i + 1
#   low   = i
#
# Default killzones (UTC, half-open):
#   asian        [01, 05)  →  hours 1,2,3,4     →  4 candles / day
#   london_open  [07, 10)  →  hours 7,8,9       →  3 candles / day
#   ny_open      [12, 15)  →  hours 12,13,14    →  3 candles / day
#   london_close [15, 17)  →  hours 15,16       →  2 candles / day


def make_hourly_candles(n_days: int = 1, tz: str | None = None) -> pd.DataFrame:
    timestamps = pd.date_range(
        "2024-01-01 00:00", periods=n_days * 24, freq="1h", tz=tz
    )
    n = len(timestamps)
    highs  = [float(i + 1) for i in range(n)]
    lows   = [float(i)     for i in range(n)]
    closes = [(h + l) / 2  for h, l in zip(highs, lows)]
    return pd.DataFrame(
        {
            "open":   closes,
            "high":   highs,
            "low":    lows,
            "close":  closes,
            "volume": [1000.0] * n,
        },
        index=timestamps,
    )


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_dataframe_returns_empty():
    df = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    assert KillzoneDetector().detect(df) == []


def test_no_candles_in_any_window_returns_empty():
    # Only candles at hour 00 UTC — outside all default killzone windows.
    timestamps = pd.date_range("2024-01-01 00:00", periods=3, freq="1D")
    df = pd.DataFrame(
        {"open": [100.0]*3, "high": [101.0]*3, "low": [99.0]*3,
         "close": [100.0]*3, "volume": [1000.0]*3},
        index=timestamps,
    )
    assert KillzoneDetector().detect(df) == []


# ---------------------------------------------------------------------------
# Single day — pattern count and names
# ---------------------------------------------------------------------------


def test_four_killzones_detected_in_one_day():
    df = make_hourly_candles(n_days=1)
    assert len(KillzoneDetector().detect(df)) == 4


def test_killzone_names_present():
    df = make_hourly_candles(n_days=1)
    names = {p.meta["name"] for p in KillzoneDetector().detect(df)}
    assert names == {"asian", "london_open", "ny_open", "london_close"}


def test_pattern_type_is_killzone():
    df = make_hourly_candles(n_days=1)
    for p in KillzoneDetector().detect(df):
        assert p.type == PatternType.KILLZONE


# ---------------------------------------------------------------------------
# Asian killzone  (hours 1–4, 4 candles)
# ---------------------------------------------------------------------------
#   hour 1: high=2, low=1
#   hour 4: high=5, low=4
#   window high = 5, window low = 1


def _asian(df: pd.DataFrame) -> object:
    return next(p for p in KillzoneDetector().detect(df) if p.meta["name"] == "asian")


def test_asian_candle_count():
    df = make_hourly_candles(n_days=1)
    assert _asian(df).meta["candle_count"] == 4


def test_asian_high():
    df = make_hourly_candles(n_days=1)
    assert _asian(df).high == pytest.approx(5.0)   # hour-4 candle high = 4+1


def test_asian_low():
    df = make_hourly_candles(n_days=1)
    assert _asian(df).low == pytest.approx(1.0)    # hour-1 candle low = 1


def test_asian_start_time():
    df = make_hourly_candles(n_days=1)
    assert _asian(df).start_time == df.index[1]    # 01:00


def test_asian_end_time():
    df = make_hourly_candles(n_days=1)
    assert _asian(df).end_time == df.index[4]      # 04:00


# ---------------------------------------------------------------------------
# london_open (hours 7–9, 3 candles) and others — spot checks
# ---------------------------------------------------------------------------


def test_london_open_candle_count():
    df = make_hourly_candles(n_days=1)
    p = next(p for p in KillzoneDetector().detect(df) if p.meta["name"] == "london_open")
    assert p.meta["candle_count"] == 3


def test_ny_open_high_low():
    # ny_open hours 12,13,14 → highs=[13,14,15], lows=[12,13,14]
    df = make_hourly_candles(n_days=1)
    p = next(p for p in KillzoneDetector().detect(df) if p.meta["name"] == "ny_open")
    assert p.high == pytest.approx(15.0)
    assert p.low  == pytest.approx(12.0)


def test_london_close_candle_count():
    # london_close hours 15,16 → 2 candles
    df = make_hourly_candles(n_days=1)
    p = next(p for p in KillzoneDetector().detect(df) if p.meta["name"] == "london_close")
    assert p.meta["candle_count"] == 2


# ---------------------------------------------------------------------------
# end_time is never None (killzones have a definite end)
# ---------------------------------------------------------------------------


def test_end_time_is_not_none():
    df = make_hourly_candles(n_days=1)
    for p in KillzoneDetector().detect(df):
        assert p.end_time is not None


# ---------------------------------------------------------------------------
# Multi-day
# ---------------------------------------------------------------------------


def test_two_days_produce_eight_patterns():
    df = make_hourly_candles(n_days=2)
    assert len(KillzoneDetector().detect(df)) == 8


def test_sorted_by_start_time():
    df = make_hourly_candles(n_days=2)
    times = [p.start_time for p in KillzoneDetector().detect(df)]
    assert times == sorted(times)


def test_second_day_asian_high():
    # Day 2 absolute hour 25 (01:00): high=26; hour 28 (04:00): high=29
    df = make_hourly_candles(n_days=2)
    asians = [p for p in KillzoneDetector().detect(df) if p.meta["name"] == "asian"]
    assert len(asians) == 2
    assert asians[1].high == pytest.approx(29.0)   # hour 28 → high = 28+1 = 29


# ---------------------------------------------------------------------------
# Custom killzones
# ---------------------------------------------------------------------------


def test_custom_killzone_single_window():
    # Only detect candles at hours 5,6 (not in any default window)
    df = make_hourly_candles(n_days=1)
    patterns = KillzoneDetector(killzones=[("custom", 5, 7)]).detect(df)
    assert len(patterns) == 1
    p = patterns[0]
    assert p.meta["name"] == "custom"
    assert p.meta["candle_count"] == 2   # hours 5,6


def test_custom_killzone_empty_window():
    # Candles only at hours 07–10; window [00, 06) has no matching candles → empty.
    timestamps = pd.date_range("2024-01-01 07:00", periods=4, freq="1h")
    df = pd.DataFrame(
        {"open": [100.]*4, "high": [101.]*4, "low": [99.]*4,
         "close": [100.]*4, "volume": [1000.]*4},
        index=timestamps,
    )
    assert KillzoneDetector(killzones=[("night", 0, 6)]).detect(df) == []


# ---------------------------------------------------------------------------
# Timezone-aware index
# ---------------------------------------------------------------------------


def test_tz_aware_index_detected():
    # tz="UTC" — should produce same count as tz-naive
    df = make_hourly_candles(n_days=1, tz="UTC")
    assert len(KillzoneDetector().detect(df)) == 4


def test_tz_aware_non_utc_converted_correctly():
    # Candles tagged as US/Eastern (UTC-5); hour 1–4 UTC = 20:00–23:00 Eastern
    # (previous day).  With tz_convert("UTC") the detector must still find the
    # asian session at the correct UTC hours.
    df = make_hourly_candles(n_days=2, tz="UTC")
    df_eastern = df.tz_convert("US/Eastern")
    # Same underlying moments in time — just re-labelled.  Count should match.
    assert len(KillzoneDetector().detect(df_eastern)) == 8


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


def test_timeframe_propagated():
    df = make_hourly_candles(n_days=1)
    for p in KillzoneDetector(timeframe="1h").detect(df):
        assert p.timeframe == "1h"


def test_mid_is_midpoint_of_high_low():
    # Pattern.mid property = (high + low) / 2
    df = make_hourly_candles(n_days=1)
    for p in KillzoneDetector().detect(df):
        assert p.mid == pytest.approx((p.high + p.low) / 2)
