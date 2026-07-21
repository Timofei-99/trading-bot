from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from core.market_context import MarketContext

CANDLE_COLUMNS = ["open", "high", "low", "close", "volume"]

# yfinance interval strings and their max lookback in days
_YF_LIMITS: dict[str, int] = {
    "1m":  7,
    "2m":  60,
    "5m":  60,
    "15m": 60,
    "30m": 60,
    "60m": 730,
    "1h":  730,
    "1d":  9999,
    "1wk": 9999,
}

_TF_TO_YF: dict[str, str] = {
    "1m":  "1m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "4h":  "4h",
    "1d":  "1d",
}


def fetch_forex(
    ticker: str,
    timeframe: str,
    start: datetime | None = None,
    end: datetime | None = None,
    verbose: bool = True,
) -> pd.DataFrame:
    """Download OHLCV for *ticker* from Yahoo Finance.

    Ticker examples: "EURUSD=X", "GC=F" (gold), "^GDAXI" (DAX).
    Timeframe must be a key in _TF_TO_YF.
    Returns an empty DataFrame if no data is available.
    """
    try:
        import yfinance as yf
    except ImportError as exc:
        raise ImportError("yfinance is required: pip install yfinance") from exc

    yf_interval = _TF_TO_YF.get(timeframe)
    if yf_interval is None:
        raise ValueError(f"Unsupported timeframe for yfinance: {timeframe!r}")

    raw = yf.download(
        ticker,
        start=start,
        end=end,
        interval=yf_interval,
        progress=False,
        auto_adjust=True,
    )

    if raw.empty:
        if verbose:
            print(f"  [forex_loader] No data returned for {ticker} {timeframe}")
        return pd.DataFrame(columns=CANDLE_COLUMNS)

    # yfinance >= 0.2.31 returns MultiIndex columns for single tickers too
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.droplevel(1)

    raw.columns = [c.lower() for c in raw.columns]

    # Ensure UTC timezone-aware index
    if raw.index.tz is None:
        raw.index = raw.index.tz_localize("UTC")
    else:
        raw.index = raw.index.tz_convert("UTC")

    raw.index.name = "timestamp"

    # Keep only OHLCV columns that exist
    cols = [c for c in CANDLE_COLUMNS if c in raw.columns]
    result = raw[cols].copy()
    result = result[~result.index.duplicated(keep="last")]
    result.sort_index(inplace=True)

    if verbose:
        if not result.empty:
            print(f"  {ticker} {timeframe}: {len(result)} bars "
                  f"({result.index[0].date()} – {result.index[-1].date()})")

    return result


def load_forex_context(
    ticker: str,
    timeframes: list[str],
    start: datetime | None = None,
    end: datetime | None = None,
    max_candles: int = 50_000,
    verbose: bool = True,
) -> MarketContext:
    """Build a MarketContext loaded with yfinance data for all requested timeframes."""
    ctx = MarketContext(symbol=ticker, timeframes=timeframes, max_candles=max_candles)
    for tf in timeframes:
        df = fetch_forex(ticker, tf, start=start, end=end, verbose=verbose)
        if not df.empty:
            ctx.load(tf, df)
    return ctx
