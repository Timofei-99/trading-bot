"""Quick backtest runner.

Usage:
    python3 run_backtest.py

Downloads BTC/USDT 4h + 15m data from Binance (public API, no key needed),
caches to data/cache/, then runs the OB_4h_FVG_15m strategy.
"""
from __future__ import annotations

from datetime import datetime, timezone

from data.loader import load_context
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.ob_4h_fvg_15m import OB4hFVG15mStrategy

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

EXCHANGE   = "binance"
SYMBOL     = "BTC/USDT"
START      = datetime(2023, 1, 1, tzinfo=timezone.utc)
END        = datetime(2024, 1, 1, tzinfo=timezone.utc)   # 1 year
TIMEFRAMES = ["4h", "15m"]
BALANCE    = 10_000.0   # USDT

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def main() -> None:
    print(f"Loading {SYMBOL} data {START.date()} → {END.date()} …")
    context = load_context(
        exchange_id=EXCHANGE,
        symbol=SYMBOL,
        timeframes=TIMEFRAMES,
        start=START,
        end=END,
        max_candles=50_000,   # store full history; engine uses a rolling window
    )

    for tf in TIMEFRAMES:
        bars = context.candles(tf)
        print(f"  {tf}: {len(bars)} bars  ({bars.index[0].date()} – {bars.index[-1].date()})")

    strategy = OB4hFVG15mStrategy(htf="4h", ltf="15m")
    adapter  = BacktestAdapter(initial_balance=BALANCE)
    engine   = BacktestEngine(
        context=context,
        strategy=strategy,
        adapter=adapter,
        window=500,    # 500×15m ≈ 5 days LTF; 500×4h ≈ 83 days HTF context
    )

    print("\nRunning backtest on 15m bars …")
    report = engine.run(base_timeframe="15m")

    print("\n=== Backtest Report ===")
    print(f"  Period          : {START.date()} – {END.date()}")
    print(f"  Symbol          : {SYMBOL}")
    print(f"  Strategy        : {strategy.name} v{strategy.version}")
    print(f"  Initial balance : ${BALANCE:,.0f}")
    print(f"  Total trades    : {report['total_trades']}")
    if report['total_trades']:
        print(f"  Winners / Losers: {report['winners']} / {report['losers']}")
        print(f"  Win rate        : {report['win_rate']:.1%}")
        print(f"  Profit factor   : {report['profit_factor']:.2f}")
        print(f"  Total PnL       : {report['total_pnl_pct']:+.2%}")
        print(f"  Max drawdown    : {report['max_drawdown_pct']:.2%}")


if __name__ == "__main__":
    main()
