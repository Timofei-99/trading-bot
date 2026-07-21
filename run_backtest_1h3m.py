"""Backtest runner for the 1h3m Classic strategy on EURUSD.

Data source: Yahoo Finance (yfinance)
  - 1h: up to 730 days of history (used for context + PDH/PDL)
  - 5m: up to 60 days (used for BOS entry signal)

The backtest covers the 5m data window (≤60 days) because the engine
iterates on the LTF (5m) bars. 1h data provides a deeper context slice.

Usage:
    python3 run_backtest_1h3m.py
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from data.forex_loader import load_forex_context
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.h1_3m_classic import H1m3mClassicStrategy

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TICKER     = "EURUSD=X"
BALANCE    = 10_000.0
RISK_PCT   = 0.01      # 1% per trade

# 5m data is limited to 60 days on yfinance → backtest the last 58 days
END   = datetime.now(timezone.utc)
START_5M = END - timedelta(days=58)
# 1h history: pull 2 extra months for context warm-up
START_1H  = END - timedelta(days=120)

# ---------------------------------------------------------------------------

def main() -> None:
    print(f"Loading {TICKER} data …")
    print(f"  1h : {START_1H.date()} → {END.date()}")
    print(f"  5m : {START_5M.date()} → {END.date()}")

    # Load 1h and 5m separately, then merge into one context
    from data.forex_loader import fetch_forex
    from core.market_context import MarketContext

    h1  = fetch_forex(TICKER, "1h",  start=START_1H,  end=END, verbose=True)
    h5m = fetch_forex(TICKER, "5m",  start=START_5M,  end=END, verbose=True)

    if h1.empty or h5m.empty:
        print("No data returned — check internet connection or ticker symbol.")
        return

    ctx = MarketContext(symbol=TICKER, timeframes=["1h", "5m"], max_candles=50_000)
    ctx.load("1h", h1)
    ctx.load("5m", h5m)

    strategy = H1m3mClassicStrategy(
        htf="1h",
        ltf="5m",
        symbol=TICKER,
        min_rr=1.3,
        max_stop_pips=300,
        pip_size=0.0001,
        fractal_lookback_days=1,
        context_threshold_pips=10,
    )
    adapter = BacktestAdapter(initial_balance=BALANCE, risk_per_trade=RISK_PCT)
    engine  = BacktestEngine(
        context=ctx,
        strategy=strategy,
        adapter=adapter,
        window=500,   # 500×1h ≈ 21 days context; 500×5m ≈ 41h
    )

    print(f"\nRunning backtest on 5m bars ({len(h5m)} bars) …")
    report = engine.run(base_timeframe="5m")

    print("\n=== Backtest Report ===")
    print(f"  Period          : {START_5M.date()} – {END.date()}")
    print(f"  Ticker          : {TICKER}")
    print(f"  Strategy        : {strategy.name} v{strategy.version}")
    print(f"  Initial balance : ${BALANCE:,.0f}")
    print(f"  Total trades    : {report['total_trades']}")
    if report["total_trades"]:
        print(f"  Winners / Losers: {report['winners']} / {report['losers']}")
        print(f"  Win rate        : {report['win_rate']:.1%}")
        print(f"  Profit factor   : {report['profit_factor']:.2f}")
        print(f"  Total PnL       : {report['total_pnl_pct']:+.2%}")
        print(f"  Max drawdown    : {report['max_drawdown_pct']:.2%}")


if __name__ == "__main__":
    main()
