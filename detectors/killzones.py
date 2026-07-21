from __future__ import annotations

import pandas as pd

from core.interfaces import Detector
from core.patterns import Pattern, PatternType

# (name, start_hour_utc_inclusive, end_hour_utc_exclusive)
_DEFAULT_KILLZONES: list[tuple[str, int, int]] = [
    ("asian",        1,  5),
    ("london_open",  7, 10),
    ("ny_open",     12, 15),
    ("london_close", 15, 17),
]


class KillzoneDetector(Detector):
    """Detects ICT killzone windows — fixed UTC time bands of institutional activity.

    Default killzones (UTC hours, half-open [start, end)):
        asian        01:00 – 05:00
        london_open  07:00 – 10:00
        ny_open      12:00 – 15:00
        london_close 15:00 – 17:00

    One Pattern is emitted per (killzone, calendar day) pair that contains
    at least one candle.

    Pattern fields:
        start_time = timestamp of the first candle inside the window
        end_time   = timestamp of the last candle inside the window
        high / low = highest high / lowest low across all window candles

    meta fields:
        name         : str — killzone identifier
        candle_count : int — number of candles that fell inside the window
    """

    def __init__(
        self,
        timeframe: str = "",
        killzones: list[tuple[str, int, int]] | None = None,
    ) -> None:
        self.timeframe = timeframe
        self.killzones = killzones if killzones is not None else list(_DEFAULT_KILLZONES)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, candles: pd.DataFrame) -> list[Pattern]:
        if candles.empty:
            return []

        idx = candles.index
        if hasattr(idx, "tz") and idx.tz is not None:
            utc_idx = idx.tz_convert("UTC")
        else:
            utc_idx = idx

        hours = utc_idx.hour
        days = utc_idx.normalize()

        patterns: list[Pattern] = []

        for name, start_h, end_h in self.killzones:
            if start_h < end_h:
                in_window = (hours >= start_h) & (hours < end_h)
            else:
                # midnight-crossing window (e.g. 22:00 – 02:00)
                in_window = (hours >= start_h) | (hours < end_h)

            window = candles[in_window]
            window_days = days[in_window]

            if window.empty:
                continue

            for day in sorted(window_days.unique()):
                day_mask = window_days == day
                day_candles = window[day_mask]

                patterns.append(
                    Pattern(
                        type=PatternType.KILLZONE,
                        timeframe=self.timeframe,
                        start_time=day_candles.index[0],
                        end_time=day_candles.index[-1],
                        high=float(day_candles["high"].max()),
                        low=float(day_candles["low"].min()),
                        meta={
                            "name": name,
                            "candle_count": len(day_candles),
                        },
                    )
                )

        patterns.sort(key=lambda p: p.start_time)
        return patterns
