"""Visualization demo.

Runs the OB_4h_FVG_15m strategy on cached BTC/USDT data (2023) and writes:
  reports/chart_2023_02.html            — 4h chart with all detected patterns
                                            for a one-month window
  reports/trade_<N>_<symbol>_<pnl>.html  — trade-audit chart for each of the
                                            top-3 trades by PnL (2 panels: 4h/15m)

Usage:
    python3 run_visualization.py
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from data.loader import load_context
from detectors.fvg import FVGDetector
from detectors.killzones import KillzoneDetector
from detectors.liquidity import LiquidityDetector
from detectors.order_blocks import OrderBlockDetector
from detectors.premium_discount import PremiumDiscountDetector
from detectors.structure import StructureDetector
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.ob_4h_fvg_15m import OB4hFVG15mStrategy
from visualization import render_chart, render_trade

EXCHANGE   = "binance"
SYMBOL     = "BTC/USDT"
START      = datetime(2023, 1, 1, tzinfo=timezone.utc)
END        = datetime(2023, 4, 1, tzinfo=timezone.utc)  # 3 months — fast demo
TIMEFRAMES = ["4h", "15m"]
BALANCE    = 10_000.0

REPORTS_DIR = Path("reports")


def main() -> None:
    print(f"Loading {SYMBOL} data {START.date()} → {END.date()} …")
    context = load_context(
        exchange_id=EXCHANGE,
        symbol=SYMBOL,
        timeframes=TIMEFRAMES,
        start=START,
        end=END,
        max_candles=50_000,
    )

    for tf in TIMEFRAMES:
        bars = context.candles(tf)
        print(f"  {tf}: {len(bars)} bars  ({bars.index[0].date()} – {bars.index[-1].date()})")

    strategy = OB4hFVG15mStrategy(htf="4h", ltf="15m")
    adapter  = BacktestAdapter(initial_balance=BALANCE)
    engine   = BacktestEngine(context=context, strategy=strategy, adapter=adapter, window=500)

    print("\nRunning backtest on 15m bars …")
    report = engine.run(base_timeframe="15m")
    print(f"  total trades: {report['total_trades']}, win rate: {report['win_rate']:.1%}")

    REPORTS_DIR.mkdir(exist_ok=True)

    # ------------------------------------------------------------------
    # (a) Chart: 4h with all patterns, one-month window
    # ------------------------------------------------------------------
    htf_candles = context.candles("4h")
    patterns_4h = (
        OrderBlockDetector(timeframe="4h").detect(htf_candles)
        + PremiumDiscountDetector(timeframe="4h").detect(htf_candles)
        + StructureDetector(timeframe="4h").detect(htf_candles)
        + LiquidityDetector(timeframe="4h").detect(htf_candles)
        + FVGDetector(timeframe="4h").detect(htf_candles)
        + KillzoneDetector(timeframe="4h").detect(htf_candles)
    )
    print(f"\nDetected {len(patterns_4h)} 4h patterns")

    chart_start = datetime(2023, 2, 1, tzinfo=timezone.utc)
    chart_end   = datetime(2023, 3, 1, tzinfo=timezone.utc)
    chart_path = REPORTS_DIR / "chart_2023_02.html"
    render_chart(
        context=context,
        timeframe="4h",
        patterns=patterns_4h,
        trades=adapter.trades,
        start=chart_start,
        end=chart_end,
        title=f"{SYMBOL} 4h — Feb 2023 — {strategy.name}",
        save_path=chart_path,
    )
    print(f"  → wrote {chart_path}")

    # ------------------------------------------------------------------
    # (b) Trade-audit charts for the top 3 trades by |PnL %|
    # ------------------------------------------------------------------
    trades = [t for t in adapter.trades if t.pnl_pct is not None]
    if not trades:
        print("\nNo closed trades — skipping trade audits")
        return

    top = sorted(trades, key=lambda t: abs(t.pnl_pct), reverse=True)[:3]
    print(f"\nRendering top {len(top)} trades by |PnL %|:")
    for i, trade in enumerate(top, start=1):
        pnl_tag = f"{trade.pnl_pct * 100:+.1f}pct".replace("+", "p").replace("-", "m").replace(".", "_")
        path = REPORTS_DIR / f"trade_{i}_{SYMBOL.replace('/', '_')}_{pnl_tag}.html"
        render_trade(
            trade=trade,
            context=context,
            htf="4h",
            ltf="15m",
            bars_before=100,
            bars_after=50,
            save_path=path,
        )
        print(f"  #{i}  entry {trade.entry_time}  PnL {trade.pnl_pct * 100:+.2f}%  → {path}")


if __name__ == "__main__":
    main()
