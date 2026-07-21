"""Frankfurt IB 50 %% breakout strategy.

Rules:
  1. Compute the Frankfurt Initial Balance (08:00–09:00 Europe/Berlin, 1 h,
     wick-based high / low).  Midpoint (mid = 50 %%) is the key trigger level.
  2. After the IB window closes, watch the current 1 m bar's close price vs.
     the previous bar's close price.  When they straddle the mid, enter in
     the direction of the newer close:
        prev_close ≤ mid < curr_close → LONG
        prev_close ≥ mid > curr_close → SHORT
     "Consolidation on the new side" — a single closing candle is enough per
     the user's spec.
  3. Stop-loss = nearest confirmed swing low (LONG) or swing high (SHORT)
     within the same session, or the IB opposite level as a fallback.
  4. Take-profit = 100 %% IB projection in trade direction:
        LONG:  IB_high + (IB_high − IB_low)
        SHORT: IB_low  − (IB_high − IB_low)
  5. Trade expires at `session_end` local (default 10:00 Berlin,
     end of the first London hour).  One entry per session date.
"""
from __future__ import annotations

from datetime import time as dtime

import pandas as pd

from core.market_context import MarketContext
from core.patterns import Pattern
from core.signal import Direction, Signal
from detectors.initial_balance import InitialBalanceDetector
from strategies.base import Strategy


class FrankfurtIB50Strategy(Strategy):
    name = "frankfurt_ib_50"
    version = "1.0"

    def __init__(
        self,
        session_start: str = "08:00",
        session_tz: str = "Europe/Berlin",
        ib_duration_minutes: int = 60,
        session_end: str = "10:00",
        swing_length: int = 3,
        timeframe: str = "1m",
    ) -> None:
        self.session_start = session_start
        self.session_tz = session_tz
        self.ib_duration_minutes = ib_duration_minutes
        self.session_end = session_end
        self.swing_length = swing_length
        self.timeframe = timeframe

        self._start_t = _hhmm(session_start)
        self._ib_end_t = _add_minutes(self._start_t, ib_duration_minutes)
        self._end_t = _hhmm(session_end)
        if not (self._start_t < self._ib_end_t <= self._end_t):
            raise ValueError("Require session_start < ib_end <= session_end (same day)")

        self._detector = InitialBalanceDetector(
            session_start=session_start,
            session_tz=session_tz,
            duration_minutes=ib_duration_minutes,
            timeframe=timeframe,
        )
        # per-session state: {date: {"entered": bool, "ib": Pattern}}
        self._session_state: dict = {}

    # ------------------------------------------------------------------

    def check_entry(self, context: MarketContext) -> Signal | None:
        candles = context.candles(self.timeframe)
        if len(candles) < 2:
            return None

        current_time_utc = candles.index[-1]
        local_now = pd.Timestamp(current_time_utc).tz_convert(self.session_tz)
        session_date = local_now.date()
        local_hm = local_now.time().replace(second=0, microsecond=0)

        state = self._session_state.setdefault(
            session_date, {"entered": False, "ib": None}
        )
        if state["entered"]:
            return None
        if local_hm < self._ib_end_t or local_hm >= self._end_t:
            return None

        if state["ib"] is None:
            state["ib"] = self._todays_ib(candles, session_date)
            if state["ib"] is None:
                return None

        ib: Pattern = state["ib"]
        mid = ib.meta["mid"]

        prev_close = float(candles["close"].iloc[-2])
        curr_close = float(candles["close"].iloc[-1])

        if prev_close <= mid < curr_close:
            direction = Direction.LONG
        elif prev_close >= mid > curr_close:
            direction = Direction.SHORT
        else:
            return None

        if direction is Direction.LONG:
            sl = self._nearest_swing_low(candles) or ib.low
            if sl >= curr_close:
                return None
        else:
            sl = self._nearest_swing_high(candles) or ib.high
            if sl <= curr_close:
                return None

        ib_range = ib.high - ib.low
        if direction is Direction.LONG:
            tp = ib.high + ib_range
        else:
            tp = ib.low - ib_range

        expiry_local = pd.Timestamp(
            f"{session_date} {self.session_end}", tz=self.session_tz
        )
        expiry_utc = expiry_local.tz_convert("UTC").to_pydatetime()

        state["entered"] = True

        return Signal(
            symbol=context.symbol,
            direction=direction,
            entry=curr_close,
            stop_loss=float(sl),
            take_profit=float(tp),
            timeframe=self.timeframe,
            timestamp=pd.Timestamp(current_time_utc).to_pydatetime(),
            strategy_name=self.name,
            strategy_version=self.version,
            triggered_by=["frankfurt_ib", "mid_cross"],
            meta={
                "ib_high": ib.high,
                "ib_low": ib.low,
                "ib_mid": mid,
                "session_date": str(session_date),
            },
            expiry_time=expiry_utc,
        )

    # ------------------------------------------------------------------

    def _todays_ib(self, candles: pd.DataFrame, session_date) -> Pattern | None:
        patterns = self._detector.detect(candles)
        for p in patterns:
            if p.meta["session_date"] == session_date:
                return p
        return None

    def _nearest_swing_low(self, candles: pd.DataFrame) -> float | None:
        n = self.swing_length
        lows = candles["low"].to_numpy()
        # Swing at index i is confirmed after n bars pass — so search up to
        # index len-1-n, walking backwards.
        for i in range(len(candles) - 1 - n, n - 1, -1):
            if lows[i] < lows[i - n : i].min() and lows[i] < lows[i + 1 : i + n + 1].min():
                return float(lows[i])
        return None

    def _nearest_swing_high(self, candles: pd.DataFrame) -> float | None:
        n = self.swing_length
        highs = candles["high"].to_numpy()
        for i in range(len(candles) - 1 - n, n - 1, -1):
            if highs[i] > highs[i - n : i].max() and highs[i] > highs[i + 1 : i + n + 1].max():
                return float(highs[i])
        return None


def _hhmm(value: str) -> dtime:
    h, m = value.split(":")
    return dtime(hour=int(h), minute=int(m))


def _add_minutes(t: dtime, minutes: int) -> dtime:
    total = t.hour * 60 + t.minute + minutes
    if total >= 24 * 60:
        raise ValueError("Session window must not cross midnight")
    return dtime(hour=total // 60, minute=total % 60)
