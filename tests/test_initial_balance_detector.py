from __future__ import annotations

import pandas as pd
import pytest

from core.patterns import PatternType
from detectors.initial_balance import InitialBalanceDetector


def make_minute_candles(
    start: str = "2024-01-01 00:00",
    periods: int = 60 * 24,
    tz: str | None = "UTC",
) -> pd.DataFrame:
    """Build one-minute candles.

    Row i has open=close=i, high=i+0.5, low=i-0.5 — so wick highs/lows are
    predictable and monotonic across the day.
    """
    timestamps = pd.date_range(start, periods=periods, freq="1min", tz=tz)
    n = len(timestamps)
    return pd.DataFrame(
        {
            "open":   [float(i) for i in range(n)],
            "high":   [float(i) + 0.5 for i in range(n)],
            "low":    [float(i) - 0.5 for i in range(n)],
            "close":  [float(i) for i in range(n)],
            "volume": [1.0] * n,
        },
        index=timestamps,
    )


# ---------------------------------------------------------------------------
# Basic behaviour
# ---------------------------------------------------------------------------


def test_empty_dataframe_returns_empty():
    assert InitialBalanceDetector().detect(pd.DataFrame()) == []


def test_default_frankfurt_window_winter_is_0700_utc():
    """Default (08:00 Europe/Berlin, 60 min) on a January date == 07:00–07:59 UTC."""
    candles = make_minute_candles(periods=60 * 24)
    patterns = InitialBalanceDetector().detect(candles)

    assert len(patterns) == 1
    p = patterns[0]

    assert p.type is PatternType.INITIAL_BALANCE
    assert p.start_time == pd.Timestamp("2024-01-01 07:00", tz="UTC")
    assert p.end_time == pd.Timestamp("2024-01-01 07:59", tz="UTC")
    # highs run from 420.5 (minute 420 == 07:00) to 479.5 (minute 479 == 07:59)
    assert p.high == pytest.approx(479.5)
    assert p.low == pytest.approx(419.5)
    assert p.meta["session"] == "frankfurt"
    assert p.meta["duration_minutes"] == 60
    assert p.meta["mid"] == pytest.approx((479.5 + 419.5) / 2)
    assert p.meta["session_date"] == pd.Timestamp("2024-01-01").date()


def test_default_frankfurt_window_summer_is_0600_utc():
    """08:00 Europe/Berlin in July == 06:00 UTC (CEST is UTC+2)."""
    candles = make_minute_candles(start="2024-07-01 00:00", periods=60 * 24)
    p = InitialBalanceDetector().detect(candles)[0]

    assert p.start_time == pd.Timestamp("2024-07-01 06:00", tz="UTC")
    assert p.end_time == pd.Timestamp("2024-07-01 06:59", tz="UTC")


def test_no_candles_in_window_yields_nothing():
    """Data only covers 20:00–08:00 UTC — no bars in the 07:00–08:00 UTC window."""
    candles = make_minute_candles(start="2024-01-01 08:00", periods=60 * 12)
    assert InitialBalanceDetector().detect(candles) == []


def test_multi_day_produces_one_pattern_per_day():
    candles = make_minute_candles(periods=60 * 24 * 3)
    patterns = InitialBalanceDetector().detect(candles)
    assert len(patterns) == 3
    assert [p.meta["session_date"] for p in patterns] == [
        pd.Timestamp("2024-01-01").date(),
        pd.Timestamp("2024-01-02").date(),
        pd.Timestamp("2024-01-03").date(),
    ]


def test_tz_naive_index_treated_as_utc():
    naive = make_minute_candles(periods=60 * 24, tz=None)
    aware = make_minute_candles(periods=60 * 24, tz="UTC")

    p_naive = InitialBalanceDetector().detect(naive)[0]
    p_aware = InitialBalanceDetector().detect(aware)[0]

    assert p_naive.high == p_aware.high
    assert p_naive.low == p_aware.low
    assert p_naive.meta["mid"] == p_aware.meta["mid"]


def test_source_index_in_berlin_tz_normalizes_correctly():
    """Index in Europe/Berlin — 08:00 Berlin is the same instant, IB should catch it."""
    berlin = make_minute_candles(periods=60 * 24, tz="Europe/Berlin")
    p = InitialBalanceDetector().detect(berlin)[0]
    assert p.start_time.tz_convert("UTC") == pd.Timestamp("2024-01-01 07:00", tz="UTC")


def test_custom_session_start_and_duration():
    candles = make_minute_candles(periods=60 * 24)
    detector = InitialBalanceDetector(
        session_start="13:00",
        session_tz="Europe/Berlin",
        duration_minutes=30,
        session="ny_open",
    )
    p = detector.detect(candles)[0]

    # 13:00 Berlin CET (winter) == 12:00 UTC == minute 720..749
    assert p.start_time == pd.Timestamp("2024-01-01 12:00", tz="UTC")
    assert p.end_time == pd.Timestamp("2024-01-01 12:29", tz="UTC")
    assert p.high == pytest.approx(749.5)
    assert p.low == pytest.approx(719.5)
    assert p.meta["session"] == "ny_open"
    assert p.meta["duration_minutes"] == 30


def test_utc_session_tz_uses_fixed_hour():
    """Passing session_tz='UTC' makes the window a fixed UTC window (no DST)."""
    winter = make_minute_candles(start="2024-01-15 00:00", periods=60 * 24)
    summer = make_minute_candles(start="2024-07-15 00:00", periods=60 * 24)

    det = InitialBalanceDetector(session_start="06:00", session_tz="UTC")
    pw = det.detect(winter)[0]
    ps = det.detect(summer)[0]

    assert pw.start_time.hour == 6
    assert ps.start_time.hour == 6


def test_mid_is_arithmetic_mean():
    candles = make_minute_candles(periods=60 * 24)
    p = InitialBalanceDetector().detect(candles)[0]
    assert p.meta["mid"] == (p.high + p.low) / 2


# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------


def test_invalid_session_start_rejected():
    with pytest.raises(ValueError):
        InitialBalanceDetector(session_start="25:00")
    with pytest.raises(ValueError):
        InitialBalanceDetector(session_start="bogus")


def test_invalid_duration_rejected():
    with pytest.raises(ValueError):
        InitialBalanceDetector(duration_minutes=0)


def test_window_crossing_midnight_rejected():
    with pytest.raises(ValueError):
        InitialBalanceDetector(session_start="23:30", duration_minutes=120).detect(
            make_minute_candles(periods=60 * 24)
        )


# ---------------------------------------------------------------------------
# Wick-based extremes (not body)
# ---------------------------------------------------------------------------


def test_high_low_use_wicks_not_bodies():
    """Two 30-min candles inside 08:00–09:00 Berlin: one with a huge upper wick,
    one with a huge lower wick. Detector must return wick extremes.
    """
    idx = pd.DatetimeIndex(
        [
            pd.Timestamp("2024-01-01 07:00", tz="UTC"),  # == 08:00 Berlin winter
            pd.Timestamp("2024-01-01 07:30", tz="UTC"),
        ]
    )
    df = pd.DataFrame(
        {
            "open":   [100.0, 101.0],
            "high":   [110.0, 101.5],
            "low":    [99.0, 90.0],
            "close":  [100.5, 101.0],
            "volume": [1.0, 1.0],
        },
        index=idx,
    )
    p = InitialBalanceDetector().detect(df)[0]
    assert p.high == pytest.approx(110.0)
    assert p.low == pytest.approx(90.0)
