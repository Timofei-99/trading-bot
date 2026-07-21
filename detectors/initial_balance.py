from __future__ import annotations

from datetime import time as dtime

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType


class InitialBalanceDetector(Detector):
    """Detects the session Initial Balance (IB) — high/low/mid of the first
    N minutes of a fixed local-time session window.

    Default: Frankfurt (FDAX) session, 08:00–09:00 Europe/Berlin, which
    automatically resolves to 07:00 UTC in winter and 06:00 UTC in summer.

    One Pattern is emitted per calendar day (in the session timezone) that has
    at least one candle inside the window.

    Pattern fields:
        start_time = timestamp of the first candle inside the window (UTC-aware)
        end_time   = timestamp of the last candle inside the window
        high / low = highest high / lowest low across all window candles (wicks)

    meta fields:
        session          : str — session identifier
        session_date     : datetime.date — calendar day in session_tz
        mid              : float — 50 % midpoint of the IB range
        duration_minutes : int
    """

    def __init__(
        self,
        session_start: str = "08:00",
        session_tz: str = "Europe/Berlin",
        duration_minutes: int = 60,
        session: str = "frankfurt",
        timeframe: str = "",
    ) -> None:
        if duration_minutes <= 0:
            raise ValueError("duration_minutes must be positive")
        self._start = _parse_hhmm(session_start)
        self.duration_minutes = duration_minutes
        self.session_tz = session_tz
        self.session = session
        self.timeframe = timeframe
        self.session_start = session_start

    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        if candles.empty:
            return []

        idx = candles.index
        if idx.tz is None:
            utc_idx = idx.tz_localize("UTC")
        else:
            utc_idx = idx.tz_convert("UTC")

        local_idx = utc_idx.tz_convert(self.session_tz)

        start_min = self._start.hour * 60 + self._start.minute
        end_min = start_min + self.duration_minutes
        if end_min > 24 * 60:
            raise ValueError("Session window must not cross local midnight")

        local_minutes = local_idx.hour * 60 + local_idx.minute
        in_window = (local_minutes >= start_min) & (local_minutes < end_min)
        if not in_window.any():
            return []

        window = candles[in_window]
        local_days = local_idx[in_window].normalize()

        patterns: list[Pattern] = []
        for day in sorted(local_days.unique()):
            day_mask = local_days == day
            day_candles = window[day_mask]
            if day_candles.empty:
                continue

            high = float(day_candles["high"].max())
            low = float(day_candles["low"].min())

            patterns.append(
                Pattern(
                    type=PatternType.INITIAL_BALANCE,
                    timeframe=self.timeframe,
                    start_time=day_candles.index[0],
                    end_time=day_candles.index[-1],
                    high=high,
                    low=low,
                    meta={
                        "session": self.session,
                        "session_date": pd.Timestamp(day).date(),
                        "mid": (high + low) / 2,
                        "duration_minutes": self.duration_minutes,
                    },
                )
            )

        return patterns


def _parse_hhmm(value: str) -> dtime:
    try:
        h_str, m_str = value.split(":")
        h, m = int(h_str), int(m_str)
    except (ValueError, AttributeError):
        raise ValueError(f"session_start must be HH:MM, got {value!r}") from None
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ValueError(f"session_start out of range: {value!r}")
    return dtime(hour=h, minute=m)
