from __future__ import annotations

import pandas as pd

from core.market_context import MarketContext
from execution.backtest_adapter import BacktestAdapter
from strategies.base import Strategy


class BacktestEngine:
    """Bar-by-bar backtest engine with a fixed-size rolling context window.

    The outer `context` holds the full history for all timeframes.
    The strategy sees only the last `window` bars of the base timeframe
    (and a proportional slice of every other timeframe that ends at the
    same timestamp).  This keeps memory and CPU usage constant regardless
    of how long the history is.
    """

    def __init__(
        self,
        context: MarketContext,
        strategy: Strategy,
        adapter: BacktestAdapter,
        window: int = 2000,
    ) -> None:
        self.context = context
        self.strategy = strategy
        self.adapter = adapter
        self.window = window

    def run(self, base_timeframe: str) -> dict:
        all_candles = self.context.candles(base_timeframe)
        symbol = self.context.symbol

        # Pre-load all TF DataFrames once (avoid re-fetching inside the loop)
        tf_data: dict[str, pd.DataFrame] = {
            tf: self.context.candles(tf) for tf in self.context.timeframes
        }

        for i in range(1, len(all_candles) + 1):
            current_time = all_candles.index[i - 1]

            context_slice = MarketContext(
                symbol=symbol,
                timeframes=self.context.timeframes,
                max_candles=self.window,
            )
            for tf, tf_candles in tf_data.items():
                # Searchsorted is O(log n) vs boolean indexing which is O(n)
                pos = tf_candles.index.searchsorted(current_time, side="right")
                visible = tf_candles.iloc[:pos]
                if not visible.empty:
                    context_slice.load(tf, visible)

            signal = self.strategy.check_entry(context_slice)

            if signal is not None and self.adapter.get_position(symbol) is None:
                self.adapter.place_order(signal)

            row = all_candles.iloc[i - 1]
            self.adapter.update(
                symbol=symbol,
                candle_high=float(row["high"]),
                candle_low=float(row["low"]),
                candle_close=float(row["close"]),
                candle_time=current_time.to_pydatetime(),
            )

        return self.adapter.report()
