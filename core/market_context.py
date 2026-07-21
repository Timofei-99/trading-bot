from __future__ import annotations

import pandas as pd

TIMEFRAME_MINUTES: dict[str, int] = {
    "1m": 1,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
    "6h": 360,
    "8h": 480,
    "12h": 720,
    "1d": 1440,
    "3d": 4320,
    "1w": 10080,
}


class MarketContext:
    def __init__(self, symbol: str, timeframes: list[str], max_candles: int = 500) -> None:
        self.symbol = symbol
        self.timeframes = timeframes
        self.max_candles = max_candles
        self._data: dict[str, pd.DataFrame] = {}

    def load(self, timeframe: str, candles: pd.DataFrame) -> None:
        self._data[timeframe] = candles.iloc[-self.max_candles :].copy()

    def candles(self, timeframe: str) -> pd.DataFrame:
        if timeframe not in self.timeframes:
            raise KeyError(f"Unknown timeframe: {timeframe}")
        return self._data.get(timeframe, pd.DataFrame())

    def last_price(self) -> float | None:
        known = {tf: TIMEFRAME_MINUTES.get(tf, 0) for tf in self.timeframes if tf in self._data}
        if not known:
            return None
        smallest = min(known, key=known.get)
        df = self._data[smallest]
        if df.empty:
            return None
        return float(df["close"].iloc[-1])

    def update(self, timeframe: str, candle: dict) -> None:
        df = self._data.get(timeframe, pd.DataFrame())
        ts = candle["timestamp"]
        row = pd.DataFrame([candle]).set_index("timestamp")
        if not df.empty and df.index[-1] == ts:
            df.update(row)
            self._data[timeframe] = df
        else:
            self._data[timeframe] = pd.concat([df, row]).iloc[-self.max_candles :]

    def is_ready(self) -> bool:
        return all(
            tf in self._data and not self._data[tf].empty
            for tf in self.timeframes
        )

    def summary(self) -> dict:
        return {tf: len(self._data[tf]) for tf in self._data}
