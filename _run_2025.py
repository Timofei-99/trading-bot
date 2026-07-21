from datetime import datetime, timezone
from data.loader import load_context
from engine.backtest_engine import BacktestEngine
from execution.backtest_adapter import BacktestAdapter
from strategies.ob_4h_fvg_15m import OB4hFVG15mStrategy

START = datetime(2025, 1, 1, tzinfo=timezone.utc)
END   = datetime(2026, 1, 1, tzinfo=timezone.utc)

print(f"Loading BTC/USDT data {START.date()} → {END.date()} …", flush=True)
context = load_context("binance", "BTC/USDT", ["4h", "15m"], START, END, max_candles=50_000)
for tf in ["4h", "15m"]:
    bars = context.candles(tf)
    if not bars.empty:
        print(f"  {tf}: {len(bars)} bars  ({bars.index[0].date()} – {bars.index[-1].date()})", flush=True)
    else:
        print(f"  {tf}: 0 bars", flush=True)

strategy = OB4hFVG15mStrategy(htf="4h", ltf="15m")
adapter  = BacktestAdapter(initial_balance=10_000)
engine   = BacktestEngine(context=context, strategy=strategy, adapter=adapter, window=500)

print("\nRunning backtest on 15m bars …", flush=True)
report = engine.run(base_timeframe="15m")

print("\n=== Backtest Report ===")
print(f"  Period          : {START.date()} – {END.date()}")
print(f"  Symbol          : BTC/USDT")
print(f"  Strategy        : {strategy.name} v{strategy.version}")
print(f"  Initial balance : $10,000")
print(f"  Total trades    : {report['total_trades']}")
if report['total_trades']:
    print(f"  Winners / Losers: {report['winners']} / {report['losers']}")
    print(f"  Win rate        : {report['win_rate']:.1%}")
    print(f"  Profit factor   : {report['profit_factor']:.2f}")
    print(f"  Total PnL       : {report['total_pnl_pct']:+.2%}")
    print(f"  Max drawdown    : {report['max_drawdown_pct']:.2%}")
