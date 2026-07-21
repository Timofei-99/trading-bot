from __future__ import annotations

from core.market_context import MarketContext
from core.signal import Direction, Signal
from detectors.fvg import FVGDetector
from detectors.liquidity import LiquidityDetector
from detectors.order_blocks import OrderBlockDetector
from detectors.premium_discount import PremiumDiscountDetector
from strategies.base import Strategy


class OB4hFVG15mStrategy(Strategy):
    """Bullish ICT entry: 4h OB in discount zone + 15m FVG retest + SSL sweep.

    Entry logic (all conditions must hold on the current bar):
      1. An unmitigated bullish OB exists on the HTF whose mid is below
         the current dealing range equilibrium (discount zone).
      2. A bullish FVG on the LTF is being mitigated on this exact bar
         (end_time == current bar) and its zone overlaps the OB zone.
      3. At least one SSL was swept on the LTF within the last
         `liquidity_sweep_lookback` bars (confirms liquidity grab).

    Levels:
      entry      = fvg.high  (top of the bullish gap — first touch point)
      stop_loss  = ob.low    (below the OB zone)
      take_profit = nearest unswept BSL above entry, or entry + min_rr * risk
    """

    name = "OB_4h_FVG_15m"
    version = "1.0"

    def __init__(
        self,
        htf: str = "4h",
        ltf: str = "15m",
        swing_length_htf: int = 3,
        swing_length_ltf: int = 3,
        ob_lookback: int = 5,
        liquidity_sweep_lookback: int = 20,
        min_rr: float = 2.0,
    ) -> None:
        self.htf = htf
        self.ltf = ltf
        self.swing_length_htf = swing_length_htf
        self.swing_length_ltf = swing_length_ltf
        self.ob_lookback = ob_lookback
        self.liquidity_sweep_lookback = liquidity_sweep_lookback
        self.min_rr = min_rr

    # ------------------------------------------------------------------

    def check_entry(self, context: MarketContext) -> Signal | None:
        htf_candles = context.candles(self.htf)
        ltf_candles = context.candles(self.ltf)
        if htf_candles.empty or ltf_candles.empty:
            return None

        target_ob = self._select_ob(htf_candles)
        if target_ob is None:
            return None

        current_ltf_time = ltf_candles.index[-1]
        target_fvg = self._select_fvg(ltf_candles, target_ob, current_ltf_time)
        if target_fvg is None:
            return None

        ltf_liquidity = LiquidityDetector(
            swing_length=self.swing_length_ltf, timeframe=self.ltf
        ).detect(ltf_candles)

        if not self._ssl_recently_swept(ltf_candles, ltf_liquidity):
            return None

        entry = target_fvg.high
        stop = target_ob.low
        if stop >= entry:
            return None

        risk = entry - stop
        take_profit = self._find_target(entry, ltf_liquidity, risk)

        return Signal(
            symbol=context.symbol,
            direction=Direction.LONG,
            entry=entry,
            stop_loss=stop,
            take_profit=take_profit,
            timeframe=self.ltf,
            timestamp=current_ltf_time.to_pydatetime(),
            strategy_name=self.name,
            strategy_version=self.version,
            triggered_by=["4h_ob", "4h_discount", "15m_fvg", "15m_ssl_sweep"],
            meta={
                "ob_zone": [target_ob.low, target_ob.high],
                "fvg_zone": [target_fvg.low, target_fvg.high],
            },
        )

    # ------------------------------------------------------------------
    # Step 1: HTF order block in discount zone
    # ------------------------------------------------------------------

    def _select_ob(self, htf_candles):
        obs = [
            p
            for p in OrderBlockDetector(
                swing_length=self.swing_length_htf,
                lookback=self.ob_lookback,
                timeframe=self.htf,
            ).detect(htf_candles)
            if p.meta["direction"] == "bullish" and not p.meta["mitigated"]
        ]
        if not obs:
            return None

        pd_zones = PremiumDiscountDetector(
            swing_length=self.swing_length_htf, timeframe=self.htf
        ).detect(htf_candles)
        discount_zones = [z for z in pd_zones if z.meta["zone"] == "discount"]
        if not discount_zones:
            return None

        eq = discount_zones[-1].meta["equilibrium"]
        candidates = [ob for ob in obs if ob.mid <= eq]
        if not candidates:
            return None

        return max(candidates, key=lambda p: p.start_time)

    # ------------------------------------------------------------------
    # Step 2: LTF FVG being mitigated on the current bar, inside the OB
    # ------------------------------------------------------------------

    def _select_fvg(self, ltf_candles, ob, current_time):
        fvgs = [
            p
            for p in FVGDetector(timeframe=self.ltf).detect(ltf_candles)
            if p.meta["direction"] == "bullish"
            and p.end_time == current_time   # first touch happening right now
            and p.low < ob.high              # FVG overlaps OB zone
            and p.high > ob.low
        ]
        if not fvgs:
            return None
        return max(fvgs, key=lambda p: p.start_time)

    # ------------------------------------------------------------------
    # Step 3: SSL swept within the lookback window
    # ------------------------------------------------------------------

    def _ssl_recently_swept(self, ltf_candles, liquidity_levels) -> bool:
        n = min(self.liquidity_sweep_lookback, len(ltf_candles))
        cutoff = ltf_candles.index[-n]
        return any(
            p.meta["side"] == "sell"
            and p.meta["swept"]
            and p.end_time is not None
            and p.end_time >= cutoff
            for p in liquidity_levels
        )

    # ------------------------------------------------------------------
    # Step 4: Take-profit — nearest unswept BSL or min_rr fallback
    # ------------------------------------------------------------------

    def _find_target(self, entry: float, liquidity_levels, risk: float) -> float:
        bsl_above = [
            p
            for p in liquidity_levels
            if p.meta["side"] == "buy"
            and not p.meta["swept"]
            and p.high > entry
        ]
        if bsl_above:
            return min(bsl_above, key=lambda p: p.high).high
        return entry + risk * self.min_rr
