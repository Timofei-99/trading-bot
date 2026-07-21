from __future__ import annotations

import os
from datetime import datetime, timezone

import ccxt
import pandas as pd

from core.market_context import MarketContext

CANDLE_COLUMNS = ["open", "high", "low", "close", "volume"]
_BATCH_SIZE = 1000   # Binance max per request


# ---------------------------------------------------------------------------
# Low-level fetch (single batch, public API — no key required)
# ---------------------------------------------------------------------------

def fetch_ohlcv(
    exchange_id: str,
    symbol: str,
    timeframe: str,
    since: datetime | None = None,
    limit: int = 500,
) -> pd.DataFrame:
    exchange_class = getattr(ccxt, exchange_id)
    exchange = exchange_class()

    since_ms = int(since.timestamp() * 1000) if since is not None else None
    raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since_ms, limit=limit)

    return _raw_to_df(raw)


# ---------------------------------------------------------------------------
# Range fetch with automatic pagination
# ---------------------------------------------------------------------------

def fetch_ohlcv_range(
    exchange_id: str,
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime | None = None,
    verbose: bool = True,
) -> pd.DataFrame:
    """Fetch OHLCV from *start* to *end* (inclusive), paginating automatically.

    end defaults to now (UTC).  No API key required for public exchanges.
    """
    exchange_class = getattr(ccxt, exchange_id)
    exchange = exchange_class()

    if end is None:
        end = datetime.now(timezone.utc)

    end_ms = int(end.timestamp() * 1000)
    since_ms = int(start.timestamp() * 1000)

    frames: list[pd.DataFrame] = []
    total = 0

    while True:
        raw = exchange.fetch_ohlcv(
            symbol, timeframe=timeframe, since=since_ms, limit=_BATCH_SIZE
        )
        if not raw:
            break

        batch = _raw_to_df(raw)
        # Drop bars beyond end
        end_ts_filter = pd.Timestamp(end).tz_localize("UTC") if end.tzinfo is None else pd.Timestamp(end)
        batch = batch[batch.index <= end_ts_filter]
        if batch.empty:
            break

        frames.append(batch)
        total += len(batch)

        last_ts = int(batch.index[-1].timestamp() * 1000)
        if verbose:
            print(f"  fetched {total} bars — last: {batch.index[-1]}")

        if last_ts >= end_ms or len(raw) < _BATCH_SIZE:
            break

        # Next batch starts right after the last bar
        since_ms = last_ts + 1

    if not frames:
        return pd.DataFrame(columns=CANDLE_COLUMNS)

    result = pd.concat(frames)
    result = result[~result.index.duplicated(keep="last")]
    result.sort_index(inplace=True)
    return result


# ---------------------------------------------------------------------------
# Parquet cache
# ---------------------------------------------------------------------------

def _cache_path(cache_dir: str, exchange_id: str, symbol: str, timeframe: str) -> str:
    safe_symbol = symbol.replace("/", "_")
    filename = f"{exchange_id}_{safe_symbol}_{timeframe}.parquet"
    return os.path.join(cache_dir, filename)


def load_cached(
    cache_dir: str,
    exchange_id: str,
    symbol: str,
    timeframe: str,
) -> pd.DataFrame | None:
    path = _cache_path(cache_dir, exchange_id, symbol, timeframe)
    if not os.path.exists(path):
        return None
    return pd.read_parquet(path)


def save_cached(
    df: pd.DataFrame,
    cache_dir: str,
    exchange_id: str,
    symbol: str,
    timeframe: str,
) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    path = _cache_path(cache_dir, exchange_id, symbol, timeframe)
    df.to_parquet(path)


# ---------------------------------------------------------------------------
# Smart loader: cache-first, then API for missing range
# ---------------------------------------------------------------------------

def get_candles(
    exchange_id: str,
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime | None = None,
    cache_dir: str = "data/cache",
    verbose: bool = True,
) -> pd.DataFrame:
    """Return OHLCV for the requested range.

    Loads from Parquet cache if available and covers the full range.
    Fetches missing bars from the exchange API and updates the cache.
    """
    if end is None:
        end = datetime.now(timezone.utc)

    start_ts = pd.Timestamp(start, tz="UTC") if start.tzinfo is None else pd.Timestamp(start)
    end_ts   = pd.Timestamp(end,   tz="UTC") if end.tzinfo   is None else pd.Timestamp(end)

    cached = load_cached(cache_dir, exchange_id, symbol, timeframe)

    frames: list[pd.DataFrame] = []
    to_fetch: list[tuple[pd.Timestamp, pd.Timestamp]] = []

    if cached is None or cached.empty:
        to_fetch.append((start_ts, end_ts))
    else:
        # Identify which sub-ranges of [start, end] are NOT in cache
        c_start = cached.index[0]
        c_end   = cached.index[-1]

        # Prefix: [start, min(c_start-1, end)] if cache starts after start
        if start_ts < c_start:
            to_fetch.append((start_ts, min(c_start - pd.Timedelta(milliseconds=1), end_ts)))

        # Overlap: cached bars within [start, end]
        overlap = cached[(cached.index >= start_ts) & (cached.index <= end_ts)]
        if not overlap.empty:
            frames.append(overlap)

        # Suffix: [max(c_end+1, start), end] if cache ends before end
        if c_end < end_ts:
            to_fetch.append((max(c_end + pd.Timedelta(milliseconds=1), start_ts), end_ts))

    new_frames: list[pd.DataFrame] = []
    for fetch_from, fetch_to in to_fetch:
        if fetch_from > fetch_to:
            continue
        if verbose:
            print(f"Fetching {symbol} {timeframe} from {fetch_from} …")
        new_data = fetch_ohlcv_range(
            exchange_id, symbol, timeframe,
            start=fetch_from.to_pydatetime(),
            end=fetch_to.to_pydatetime(),
            verbose=verbose,
        )
        if not new_data.empty:
            frames.append(new_data)
            new_frames.append(new_data)

    if new_frames:
        merged = pd.concat([cached] + new_frames if cached is not None else new_frames)
        merged = merged[~merged.index.duplicated(keep="last")]
        merged.sort_index(inplace=True)
        save_cached(merged, cache_dir, exchange_id, symbol, timeframe)
        if verbose:
            print(f"Cache updated → {_cache_path(cache_dir, exchange_id, symbol, timeframe)}")

    if not frames:
        return pd.DataFrame(columns=CANDLE_COLUMNS)

    result = pd.concat(frames)
    result = result[~result.index.duplicated(keep="last")]
    result.sort_index(inplace=True)
    return result[(result.index >= start_ts) & (result.index <= end_ts)]


# ---------------------------------------------------------------------------
# Context builder (convenience wrapper)
# ---------------------------------------------------------------------------

def load_context(
    exchange_id: str,
    symbol: str,
    timeframes: list[str],
    start: datetime,
    end: datetime | None = None,
    cache_dir: str = "data/cache",
    verbose: bool = True,
    max_candles: int = 50_000,
) -> MarketContext:
    context = MarketContext(symbol=symbol, timeframes=timeframes, max_candles=max_candles)
    for tf in timeframes:
        df = get_candles(
            exchange_id, symbol, tf, start=start, end=end,
            cache_dir=cache_dir, verbose=verbose,
        )
        context.load(tf, df)
    return context


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _raw_to_df(raw: list) -> pd.DataFrame:
    df = pd.DataFrame(raw, columns=["timestamp"] + CANDLE_COLUMNS)
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df.set_index("timestamp")
    df.index.name = "timestamp"
    return df
