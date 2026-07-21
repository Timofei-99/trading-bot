"""Backtest runner for the frankfurt_ib_50 strategy on FDAX 1m data.

Expected input: a CSV exported from MetaTrader 5 at data/dax_1m.csv
(File → Save As → CSV, on an FDAX 1-minute chart).  Broker time is
assumed to be Europe/Berlin — change `SOURCE_TZ` if your broker uses
a different server timezone.

Outputs:
  reports/frankfurt_ib_50_summary.txt — text report
  reports/frankfurt_ib_50_chart.html  — 1m chart for the last day with an entry
  reports/frankfurt_ib_50_trade_*.html — audit for each closed trade

Usage:
    python3 run_frankfurt_ib_50.py
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from core.market_context import MarketContext
from data.mt5_loader import load_mt5_csv
from detectors.initial_balance import InitialBalanceDetector
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.frankfurt_ib_50 import FrankfurtIB50Strategy
from visualization import render_chart, render_trade

CSV_PATH = Path("data/dax_1m.csv")
SOURCE_TZ = "Europe/Berlin"

SYMBOL = "FDAX"
BALANCE = 10_000.0
REPORTS_DIR = Path("reports")


def main() -> None:
    if not CSV_PATH.exists():
        print(f"Missing {CSV_PATH}.")
        print("Export FDAX 1m data from MT5 (right-click chart → Save As → CSV) and")
        print(f"drop the file at {CSV_PATH}. Tab or comma separators both work.")
        return

    print(f"Loading {CSV_PATH} …")
    df = load_mt5_csv(CSV_PATH, source_tz=SOURCE_TZ)
    print(f"  {len(df)} bars  ({df.index[0]} … {df.index[-1]})")

    context = MarketContext(symbol=SYMBOL, timeframes=["1m"], max_candles=len(df) + 1)
    context.load("1m", df)

    strategy = FrankfurtIB50Strategy()
    adapter = BacktestAdapter(initial_balance=BALANCE)
    engine = BacktestEngine(context=context, strategy=strategy, adapter=adapter, window=500)

    print("Running backtest on 1m bars …")
    report = engine.run(base_timeframe="1m")

    REPORTS_DIR.mkdir(exist_ok=True)
    summary_path = REPORTS_DIR / "frankfurt_ib_50_summary.txt"
    with summary_path.open("w") as f:
        f.write(f"Symbol: {SYMBOL}\n")
        f.write(f"Strategy: {strategy.name} v{strategy.version}\n")
        f.write(f"Period: {df.index[0]} .. {df.index[-1]}\n")
        f.write(f"Initial balance: {BALANCE:.2f}\n")
        for k, v in report.items():
            f.write(f"  {k}: {v}\n")
    print(f"\n=== Report ===")
    for k, v in report.items():
        print(f"  {k}: {v}")
    print(f"\n→ wrote {summary_path}")

    trades = adapter.trades
    if not trades:
        print("\nNo closed trades — nothing to visualise.")
        return

    # ------------------------------------------------------------------
    # (a) Chart of the day of the last trade, with the Frankfurt IB marked
    # ------------------------------------------------------------------
    last_trade = trades[-1]
    day = pd.Timestamp(last_trade.entry_time).tz_convert(SOURCE_TZ).date()
    day_start = pd.Timestamp(f"{day} 06:00", tz=SOURCE_TZ).tz_convert("UTC")
    day_end = pd.Timestamp(f"{day} 22:00", tz=SOURCE_TZ).tz_convert("UTC")

    ibs = InitialBalanceDetector(timeframe="1m").detect(df.loc[day_start:day_end])
    chart_path = REPORTS_DIR / "frankfurt_ib_50_chart.html"
    render_chart(
        context=context,
        timeframe="1m",
        patterns=ibs,
        trades=[last_trade],
        start=day_start.to_pydatetime(),
        end=day_end.to_pydatetime(),
        title=f"{SYMBOL} 1m — {day} — {strategy.name}",
        save_path=chart_path,
    )
    print(f"\n→ wrote {chart_path}")

    # ------------------------------------------------------------------
    # (b) Trade audit for every closed trade
    # ------------------------------------------------------------------
    for i, trade in enumerate(trades, start=1):
        pnl_tag = f"{(trade.pnl_pct or 0) * 100:+.2f}pct".replace("+", "p").replace("-", "m").replace(".", "_")
        path = REPORTS_DIR / f"frankfurt_ib_50_trade_{i:02d}_{pnl_tag}.html"
        render_trade(
            trade=trade,
            context=context,
            htf="1m",
            ltf="1m",
            bars_before=90,
            bars_after=60,
            save_path=path,
        )
    print(f"→ wrote {len(trades)} trade audits to {REPORTS_DIR}/frankfurt_ib_50_trade_*.html")


if __name__ == "__main__":
    main()
