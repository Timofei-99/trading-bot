import { BarTuple, CandleSeries } from '@bot/core/domain/candle-series';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** 2024-01-01T00:00:00Z — the anchor the Python detector tests used. */
export const T2024 = Date.UTC(2024, 0, 1);

export interface SeriesOptions {
  readonly startMs?: number;
  readonly stepMs?: number;
}

/**
 * Bars from highs and lows alone, with open = close = the midpoint.
 * Port of `make_candles` in the Python detector tests.
 */
export function candlesFromHighsLows(
  highs: readonly number[],
  lows: readonly number[],
  options: SeriesOptions = {},
): CandleSeries {
  const startMs = options.startMs ?? T2024;
  const stepMs = options.stepMs ?? HOUR_MS;

  return CandleSeries.fromBars(
    highs.map((high, i) => {
      const mid = (high + lows[i]) / 2;
      return [startMs + i * stepMs, mid, high, lows[i], mid, 1000] as BarTuple;
    }),
  );
}

export interface OhlcRow {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number;
}

export function candlesFromOhlc(
  rows: readonly OhlcRow[],
  options: SeriesOptions = {},
): CandleSeries {
  const startMs = options.startMs ?? T2024;
  const stepMs = options.stepMs ?? HOUR_MS;

  return CandleSeries.fromBars(
    rows.map(
      (row, i) =>
        [
          startMs + i * stepMs,
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume ?? 1000,
        ] as BarTuple,
    ),
  );
}

/** Timestamp of bar `index` in a series built with the helpers above. */
export function barTime(index: number, options: SeriesOptions = {}): number {
  return (options.startMs ?? T2024) + index * (options.stepMs ?? HOUR_MS);
}
