from __future__ import annotations

from datetime import datetime, timezone

import pytest

from core.patterns import Pattern, PatternType


def make_pattern(end_time: datetime | None = None) -> Pattern:
    return Pattern(
        type=PatternType.FVG,
        timeframe="15m",
        start_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
        end_time=end_time,
        high=50000.0,
        low=49000.0,
    )


def test_mid_property():
    p = make_pattern()
    assert p.mid == 49500.0


def test_is_active_no_end_time():
    p = make_pattern(end_time=None)
    assert p.is_active(datetime(2025, 1, 1, tzinfo=timezone.utc)) is True


def test_is_active_before_end_time():
    end = datetime(2024, 6, 1, tzinfo=timezone.utc)
    p = make_pattern(end_time=end)
    assert p.is_active(datetime(2024, 5, 1, tzinfo=timezone.utc)) is True


def test_is_active_at_end_time():
    end = datetime(2024, 6, 1, tzinfo=timezone.utc)
    p = make_pattern(end_time=end)
    assert p.is_active(end) is True


def test_is_active_after_end_time():
    end = datetime(2024, 6, 1, tzinfo=timezone.utc)
    p = make_pattern(end_time=end)
    assert p.is_active(datetime(2024, 7, 1, tzinfo=timezone.utc)) is False


def test_pattern_type_values():
    assert PatternType.ORDER_BLOCK.value == "order_block"
    assert PatternType.FVG.value == "fvg"
    assert PatternType.LIQUIDITY.value == "liquidity"
    assert PatternType.BOS.value == "bos"
    assert PatternType.CHOCH.value == "choch"
    assert PatternType.PREMIUM_DISCOUNT.value == "premium_discount"
    assert PatternType.KILLZONE.value == "killzone"
