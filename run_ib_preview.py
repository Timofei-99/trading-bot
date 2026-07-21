"""Quick preview of the Frankfurt Initial Balance detector.

Renders one week of BTC/USDT 15m candles with Frankfurt IBs marked
(grey box + dashed mid line).

Usage:
    python3 run_ib_preview.py
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from data.loader import load_context
from detectors.initial_balance import InitialBalanceDetector
from visualization import render_chart

EXCHANGE = "binance"
SYMBOL = "BTC/USDT"
START = datetime(2023, 2, 6, tzinfo=timezone.utc)   # Monday
END   = datetime(2023, 2, 13, tzinfo=timezone.utc)  # next Monday
TIMEFRAME = "15m"

REPORTS_DIR = Path("reports")


def main() -> None:
    print(f"Loading {SYMBOL} {TIMEFRAME}  {START.date()} → {END.date()} …")
    context = load_context(
        exchange_id=EXCHANGE,
        symbol=SYMBOL,
        timeframes=[TIMEFRAME],
        start=START,
        end=END,
        max_candles=50_000,
        verbose=False,
    )

    candles = context.candles(TIMEFRAME)
    print(f"  {len(candles)} bars")

    ibs = InitialBalanceDetector(timeframe=TIMEFRAME).detect(candles)
    print(f"  {len(ibs)} Frankfurt IBs")
    for p in ibs:
        rng = p.high - p.low
        print(
            f"    {p.meta['session_date']}  "
            f"high={p.high:.1f}  low={p.low:.1f}  mid={p.meta['mid']:.1f}  range={rng:.1f}"
        )

    REPORTS_DIR.mkdir(exist_ok=True)
    out = REPORTS_DIR / "ib_preview.html"
    render_chart(
        context=context,
        timeframe=TIMEFRAME,
        patterns=ibs,
        title=f"{SYMBOL} {TIMEFRAME} — Frankfurt IB — {START.date()} … {END.date()}",
        save_path=out,
    )
    print(f"\n→ wrote {out}")


if __name__ == "__main__":
    main()
