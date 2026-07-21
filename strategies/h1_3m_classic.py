"""1h3m Classic strategy — EURUSD / GER40 intraday setup.

Entry logic:
  1. CONTEXT  (1h, last 48 bars): price drifting in one direction + matching Order Flow
               (last swept fractal was in the direction of context).
  2. FRACTAL SWEEP  during Frankfurt/London window (default 06:00–09:00 UTC):
               1h bar wicks through a 1h fractal level opposite to context direction,
               then closes back above/below it (liquidity grab).
  3. 5m BOS   (breakout of structure): a 5m bar closes beyond the pre-sweep session
               extreme, confirming the reversal. Entry at market (bar close).

Risk:
  - Stop = wick of the sweep bar (fractal sweep extreme)
  - Target = PDH / PDL; fall back to entry + risk * min_rr if target too close
  - Skipped if stop > max_stop_pips or RR < min_rr or target already swept
  - One signal per calendar day (UTC)
"""
from __future__ import annotations

from datetime import date

import pandas as pd

from core.market_context import MarketContext
from core.signal import Direction, Signal
from strategies.base import Strategy


# ---------------------------------------------------------------------------
# Module-level helper — no class needed, called from both _compute_context
# and _detect_fractal_sweep without instantiating FractalDetector each time.
# ---------------------------------------------------------------------------

def _raw_fractals(htf: pd.DataFrame) -> list[dict]:
    """Return all confirmed 3-candle fractals in *htf* as plain dicts.

    A fractal at bar[i] is confirmed once bar[i+1] closes.
    Returns dicts with keys: type ("high"/"low"), level, bar_time, confirmed_at.
    """
    highs = htf["high"].to_numpy()
    lows  = htf["low"].to_numpy()
    n = len(htf)
    out: list[dict] = []

    for i in range(1, n - 1):
        if highs[i] > highs[i - 1] and highs[i] > highs[i + 1]:
            out.append({
                "type": "high",
                "level": float(highs[i]),
                "bar_time": htf.index[i],
                "confirmed_at": htf.index[i + 1],
            })
        if lows[i] < lows[i - 1] and lows[i] < lows[i + 1]:
            out.append({
                "type": "low",
                "level": float(lows[i]),
                "bar_time": htf.index[i],
                "confirmed_at": htf.index[i + 1],
            })

    return out


# ---------------------------------------------------------------------------

class H1m3mClassicStrategy(Strategy):
    """1h3m Classic: 1h context + 1h fractal sweep + 5m BOS."""

    name    = "1h3m_classic"
    version = "1.0"

    # Entry window in UTC (09:00–12:00 Moscow = 06:00–09:00 UTC)
    _ENTRY_START_UTC = 6
    _ENTRY_END_UTC   = 9

    def __init__(
        self,
        htf: str = "1h",
        ltf: str = "5m",
        symbol: str = "EURUSD=X",
        min_rr: float = 1.3,
        max_stop_pips: int = 300,
        pip_size: float = 0.0001,          # 0.0001 for EURUSD
        fractal_lookback_days: int = 1,    # look for fractals formed today or yesterday
        context_threshold_pips: int = 10,  # minimum net move to call it a trend
    ) -> None:
        self.htf = htf
        self.ltf = ltf
        self.symbol = symbol
        self.min_rr = min_rr
        self.max_stop_pips = max_stop_pips
        self.pip_size = pip_size
        self.fractal_lookback_days = fractal_lookback_days
        self.context_threshold_pips = context_threshold_pips

        # ---- per-day state ----
        self._today: date | None = None
        self._context: str | None = None   # "BULLISH" | "BEARISH" | "RANGE"
        self._pdh: float | None = None
        self._pdl: float | None = None
        self._signal_today: bool = False

        # ---- sweep tracking ----
        self._last_htf_bar: pd.Timestamp | None = None
        self._sweep: dict | None = None    # set when fractal sweep detected

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def check_entry(self, context: MarketContext) -> Signal | None:
        ltf = context.candles(self.ltf)
        htf = context.candles(self.htf)

        if ltf.empty or htf.empty or len(htf) < 3:
            return None

        current_time = ltf.index[-1]
        current_date = current_time.date()

        # Reset state at the start of a new UTC day
        if current_date != self._today:
            self._reset_day(current_date, htf, current_time)

        if self._context in ("RANGE", None):
            return None
        if self._signal_today:
            return None

        hour = current_time.hour
        in_window = self._ENTRY_START_UTC <= hour < self._ENTRY_END_UTC

        # Clear pending sweep once we leave the window
        if not in_window:
            if hour >= self._ENTRY_END_UTC:
                self._sweep = None
            return None

        # Check each newly completed 1h bar for a fractal sweep
        htf_last_time = htf.index[-1]
        if htf_last_time != self._last_htf_bar and self._sweep is None:
            self._last_htf_bar = htf_last_time
            htf_hour = htf_last_time.hour
            # The 1h bar must have opened within the expanded detection window
            if (self._ENTRY_START_UTC - 1) <= htf_hour < self._ENTRY_END_UTC:
                sweep = self._detect_fractal_sweep(htf, ltf, current_time)
                if sweep is not None:
                    self._sweep = sweep

        if self._sweep is None:
            return None

        return self._check_bos(ltf, current_time)

    # ------------------------------------------------------------------
    # Daily reset
    # ------------------------------------------------------------------

    def _reset_day(self, day: date, htf: pd.DataFrame, current_time: pd.Timestamp) -> None:
        self._today = day
        self._signal_today = False
        self._sweep = None
        self._last_htf_bar = None

        today_utc = current_time.normalize()
        yesterday_utc = today_utc - pd.Timedelta(days=1)

        prev = htf[(htf.index >= yesterday_utc) & (htf.index < today_utc)]
        self._pdh = float(prev["high"].max()) if not prev.empty else None
        self._pdl = float(prev["low"].min())  if not prev.empty else None

        self._context = self._compute_context(htf, current_time)

    # ------------------------------------------------------------------
    # Context detection
    # ------------------------------------------------------------------

    def _compute_context(self, htf: pd.DataFrame, current_time: pd.Timestamp) -> str:
        """Determine market context from last 48 1h bars.

        Bullish: price net higher over 48h  +  last swept fractal was a LOW
        Bearish: price net lower  over 48h  +  last swept fractal was a HIGH
        Range  : flat price or conflicting OF
        """
        cutoff = current_time - pd.Timedelta(hours=48)
        recent = htf[htf.index >= cutoff]

        if len(recent) < 10:
            return "RANGE"

        first_close = float(recent["close"].iloc[0])
        last_close  = float(recent["close"].iloc[-1])
        net_move    = last_close - first_close          # in price units
        threshold   = self.context_threshold_pips * self.pip_size

        if abs(net_move) < threshold:
            return "RANGE"

        direction_up = net_move > 0

        # Order Flow: type of the most recently swept fractal
        fractals = _raw_fractals(htf)
        last_bull_sweep: pd.Timestamp | None = None
        last_bear_sweep: pd.Timestamp | None = None

        for frac in fractals:
            if frac["confirmed_at"] < cutoff:
                continue
            level = frac["level"]

            bars_after = htf[htf.index > frac["bar_time"]]
            for bar_time, bar in bars_after.iterrows():
                if bar_time >= current_time:
                    break
                if frac["type"] == "low" and bar["low"] < level and bar["close"] > level:
                    if last_bull_sweep is None or bar_time > last_bull_sweep:
                        last_bull_sweep = bar_time
                    break
                if frac["type"] == "high" and bar["high"] > level and bar["close"] < level:
                    if last_bear_sweep is None or bar_time > last_bear_sweep:
                        last_bear_sweep = bar_time
                    break

        # Determine OF direction from most recent sweep
        if last_bull_sweep is None and last_bear_sweep is None:
            of_bull = direction_up   # no sweep data → trust price direction
        elif last_bear_sweep is None:
            of_bull = True
        elif last_bull_sweep is None:
            of_bull = False
        else:
            of_bull = last_bull_sweep > last_bear_sweep

        if direction_up and of_bull:
            return "BULLISH"
        if not direction_up and not of_bull:
            return "BEARISH"
        return "RANGE"

    # ------------------------------------------------------------------
    # Fractal sweep detection
    # ------------------------------------------------------------------

    def _detect_fractal_sweep(
        self,
        htf: pd.DataFrame,
        ltf: pd.DataFrame,
        current_time: pd.Timestamp,
    ) -> dict | None:
        """Check if the last completed 1h bar swept a fractal in the context direction.

        Sweep (bullish): 1h bar low < fractal_low level AND 1h bar close > level
        Sweep (bearish): 1h bar high > fractal_high level AND 1h bar close < level
        """
        last_bar      = htf.iloc[-1]
        last_bar_time = htf.index[-1]

        today_utc = current_time.normalize()
        lookback  = today_utc - pd.Timedelta(days=self.fractal_lookback_days + 1)

        fractals = _raw_fractals(htf)

        if self._context == "BULLISH":
            target_type = "low"
        else:
            target_type = "high"

        for frac in reversed(fractals):   # most recent fractal first
            if frac["type"] != target_type:
                continue
            if frac["bar_time"] >= last_bar_time:   # fractal must pre-date the sweep bar
                continue
            if frac["confirmed_at"] < lookback:      # only recent fractals
                continue

            level = frac["level"]

            # Invalidation — закреп под фракталом (LONG only):
            # If any bar between fractal confirmation and the sweep bar already
            # CLOSED BELOW the fractal LOW, the level was broken (not just swept).
            # This rule applies to LONG setups; for SHORT setups a Frankfurt bar
            # closing above the HIGH is the Frank Manipulation pattern (still valid).
            if target_type == "low":
                bars_between = htf[
                    (htf.index > frac["confirmed_at"]) & (htf.index < last_bar_time)
                ]
                fractal_broken = any(
                    bar["close"] < level for _, bar in bars_between.iterrows()
                )
                if fractal_broken:
                    continue   # try next (older) fractal

            if target_type == "low":
                swept = last_bar["low"] < level and last_bar["close"] > level
            else:
                swept = last_bar["high"] > level and last_bar["close"] < level

            if not swept:
                continue

            # Pre-sweep session reference: session high/low of 5m bars so far today
            session_open = today_utc + pd.Timedelta(hours=self._ENTRY_START_UTC - 1)
            session_5m   = ltf[(ltf.index >= session_open) & (ltf.index <= last_bar_time)]

            if target_type == "low":
                pre_ref = float(session_5m["high"].max()) if not session_5m.empty else float(last_bar["close"])
                stop    = float(last_bar["low"])
                direction = "LONG"
            else:
                pre_ref = float(session_5m["low"].min()) if not session_5m.empty else float(last_bar["close"])
                stop    = float(last_bar["high"])
                direction = "SHORT"

            return {
                "direction": direction,
                "stop_level": stop,
                "fractal_level": level,
                "pre_sweep_ref": pre_ref,
            }

        return None

    # ------------------------------------------------------------------
    # 5m BOS check
    # ------------------------------------------------------------------

    def _check_bos(self, ltf: pd.DataFrame, current_time: pd.Timestamp) -> Signal | None:
        sw            = self._sweep
        current_close = float(ltf.iloc[-1]["close"])

        bos_long  = sw["direction"] == "LONG"  and current_close > sw["pre_sweep_ref"]
        bos_short = sw["direction"] == "SHORT" and current_close < sw["pre_sweep_ref"]

        if not bos_long and not bos_short:
            return None

        direction = Direction.LONG if bos_long else Direction.SHORT
        return self._build_signal(current_close, sw, current_time, direction, ltf)

    # ------------------------------------------------------------------
    # Signal construction with risk validation
    # ------------------------------------------------------------------

    def _build_signal(
        self,
        entry: float,
        sw: dict,
        current_time: pd.Timestamp,
        direction: Direction,
        ltf: pd.DataFrame,
    ) -> Signal | None:
        stop = sw["stop_level"]
        max_stop = self.max_stop_pips * self.pip_size

        if direction == Direction.LONG:
            risk = entry - stop
            if risk <= 0 or risk > max_stop:
                return None

            # Skip if PDH was already swept today
            if self._pdh is not None:
                today_utc   = current_time.normalize()
                today_highs = ltf[ltf.index >= today_utc]["high"]
                if not today_highs.empty and float(today_highs.max()) >= self._pdh:
                    return None   # target gone

            if self._pdh is not None and self._pdh > entry:
                reward = self._pdh - entry
                tp = self._pdh if reward / risk >= self.min_rr else entry + risk * self.min_rr
            else:
                tp = entry + risk * self.min_rr

        else:  # SHORT
            risk = stop - entry
            if risk <= 0 or risk > max_stop:
                return None

            # Skip if PDL was already swept today
            if self._pdl is not None:
                today_utc  = current_time.normalize()
                today_lows = ltf[ltf.index >= today_utc]["low"]
                if not today_lows.empty and float(today_lows.min()) <= self._pdl:
                    return None

            if self._pdl is not None and self._pdl < entry:
                reward = entry - self._pdl
                tp = self._pdl if reward / risk >= self.min_rr else entry - risk * self.min_rr
            else:
                tp = entry - risk * self.min_rr

        self._signal_today = True
        self._sweep = None

        return Signal(
            symbol=self.symbol,
            direction=direction,
            entry=entry,
            stop_loss=stop,
            take_profit=tp,
            timeframe=self.ltf,
            timestamp=current_time.to_pydatetime(),
            strategy_name=self.name,
            strategy_version=self.version,
            triggered_by=["1h_fractal_sweep", "5m_bos"],
            meta={
                "context": self._context,
                "fractal_level": sw["fractal_level"],
                "pre_sweep_ref": sw["pre_sweep_ref"],
                "pdh": self._pdh,
                "pdl": self._pdl,
            },
        )
