import { Candle, CandleSeries } from './candle-series';

export const TIMEFRAME_MINUTES: Readonly<Record<string, number>> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
};

/**
 * Synchronized OHLCV series per timeframe.
 *
 * The engine rebuilds one of these on every bar, holding only the slice of
 * each timeframe that ends at or before the current bar's timestamp — that
 * containment is what makes look-ahead bias structurally impossible for a
 * strategy rather than a rule strategies must remember to follow.
 */
export class MarketContext {
  private readonly data = new Map<string, CandleSeries>();

  constructor(
    readonly symbol: string,
    readonly timeframes: readonly string[],
    readonly maxCandles = 500,
  ) {}

  load(timeframe: string, candles: CandleSeries): void {
    this.data.set(timeframe, candles.tail(this.maxCandles));
  }

  candles(timeframe: string): CandleSeries {
    if (!this.timeframes.includes(timeframe)) {
      throw new Error(`Unknown timeframe: ${timeframe}`);
    }
    return this.data.get(timeframe) ?? CandleSeries.empty();
  }

  has(timeframe: string): boolean {
    return this.data.has(timeframe);
  }

  /** Close of the most recent bar on the finest loaded timeframe. */
  lastPrice(): number | null {
    let bestTimeframe: string | null = null;
    let bestMinutes = Number.POSITIVE_INFINITY;

    // Iteration follows `timeframes` order, so ties resolve to the first
    // declared timeframe — the same as Python's `min()` over an insertion
    // ordered dict. Unknown timeframes score 0 and therefore win.
    for (const timeframe of this.timeframes) {
      if (!this.data.has(timeframe)) {
        continue;
      }
      const minutes = TIMEFRAME_MINUTES[timeframe] ?? 0;
      if (minutes < bestMinutes) {
        bestMinutes = minutes;
        bestTimeframe = timeframe;
      }
    }

    if (bestTimeframe === null) {
      return null;
    }
    const series = this.data.get(bestTimeframe) as CandleSeries;
    return series.isEmpty ? null : series.close[series.length - 1];
  }

  /** Append a bar, or replace the last one when the timestamp repeats. */
  update(timeframe: string, candle: Candle): void {
    const existing = this.data.get(timeframe) ?? CandleSeries.empty();

    if (!existing.isEmpty && existing.lastTime === candle.time) {
      const last = existing.length - 1;
      existing.open[last] = candle.open;
      existing.high[last] = candle.high;
      existing.low[last] = candle.low;
      existing.close[last] = candle.close;
      existing.volume[last] = candle.volume;
      this.data.set(timeframe, existing);
      return;
    }

    const bars = existing.toBars();
    bars.push([candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]);
    this.data.set(timeframe, CandleSeries.fromBars(bars).tail(this.maxCandles));
  }

  isReady(): boolean {
    return this.timeframes.every((timeframe) => {
      const series = this.data.get(timeframe);
      return series !== undefined && !series.isEmpty;
    });
  }

  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [timeframe, series] of this.data) {
      out[timeframe] = series.length;
    }
    return out;
  }
}
