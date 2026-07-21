"""Read OHLCV data exported from MetaTrader 5.

MT5 CSV export (from a chart's context menu → "Save As" or from Tools →
History Center → Export) is tab-separated with header row:

    <DATE>	<TIME>	<OPEN>	<HIGH>	<LOW>	<CLOSE>	<TICKVOL>	<VOL>	<SPREAD>
    2024.01.02	08:00:00	16780.5	16785.0	16775.0	16783.0	1234	0	1

Broker server time is usually NOT UTC — it's often UTC+2/+3 (winter/summer),
or the broker's local timezone.  Set `source_tz` to whatever your broker uses;
data is converted to UTC internally so the rest of the system stays timezone-
agnostic.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

REQUIRED_COLUMNS = ["open", "high", "low", "close", "volume"]


def load_mt5_csv(
    path: str | Path,
    source_tz: str = "Europe/Berlin",
    sep: str | None = None,
) -> pd.DataFrame:
    """Read an MT5 export CSV into a UTC-indexed OHLCV DataFrame.

    Args:
        path: file path
        source_tz: timezone of the timestamps in the file (broker time).
                   The exchange server for FDAX (Eurex) publishes candles in
                   Europe/Berlin local time by convention.
        sep: field separator; auto-detected (tab or comma) if None.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)

    if sep is None:
        first = path.read_text().splitlines()[0]
        sep = "\t" if "\t" in first else ","

    df = pd.read_csv(path, sep=sep)
    df.columns = [c.strip("<>").lower() for c in df.columns]

    if "date" not in df.columns or "time" not in df.columns:
        raise ValueError(f"Missing DATE/TIME columns in {path}; got {list(df.columns)}")

    ts_str = df["date"].astype(str) + " " + df["time"].astype(str)
    ts = pd.to_datetime(ts_str, format="%Y.%m.%d %H:%M:%S", errors="coerce")
    if ts.isna().any():
        ts = pd.to_datetime(ts_str, format="%Y.%m.%d %H:%M", errors="coerce")
    if ts.isna().any():
        ts = pd.to_datetime(ts_str, errors="coerce")
    if ts.isna().any():
        bad = ts_str[ts.isna()].iloc[0]
        raise ValueError(f"Could not parse timestamp: {bad!r}")

    ts_local = ts.dt.tz_localize(source_tz, ambiguous="NaT", nonexistent="shift_forward")
    ts_utc = ts_local.dt.tz_convert("UTC")

    if "tickvol" in df.columns and "volume" not in df.columns:
        df["volume"] = df["tickvol"]
    if "vol" in df.columns and "volume" not in df.columns:
        df["volume"] = df["vol"]
    if "volume" not in df.columns:
        df["volume"] = 0.0

    result = df[["open", "high", "low", "close", "volume"]].copy()
    result.index = ts_utc
    result.index.name = "timestamp"
    result = result[~result.index.duplicated(keep="last")]
    result.sort_index(inplace=True)
    return result
