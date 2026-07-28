/**
 * Column-oriented OHLCV storage — the replacement for the pandas DataFrame.
 *
 * The Python code never used pandas as a dataframe library: an audit of the
 * whole codebase found only `searchsorted`, positional slicing, `to_numpy()`
 * loops and timezone conversions — no `rolling`, `groupby`, `resample` or
 * `merge_asof`. So instead of pulling in a dataframe package we store each
 * field in its own `Float64Array` (structure of arrays) and port the detector
 * loops verbatim.
 *
 * Two properties matter for the backtest:
 *
 *  1. `slice()` is zero-copy. `BacktestEngine` builds a fresh view of every
 *     timeframe on *every* bar; copying would turn an O(n) replay into O(n²).
 *     `TypedArray.subarray` returns a view over the same buffer, exactly like
 *     `df.iloc[:pos]` did.
 *  2. Timestamps are epoch milliseconds held as doubles. Every millisecond
 *     value we deal with is far below 2^53, so the representation is exact and
 *     comparisons stay plain numeric ones — no BigInt friction in hot loops.
 */

export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** A single bar as it arrives from a data source: [timeMs, o, h, l, c, v]. */
export type BarTuple = readonly [number, number, number, number, number, number];

export interface CandleColumns {
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

const EMPTY = new Float64Array(0);

export class CandleSeries implements CandleColumns {
  readonly length: number;

  private constructor(
    readonly time: Float64Array,
    readonly open: Float64Array,
    readonly high: Float64Array,
    readonly low: Float64Array,
    readonly close: Float64Array,
    readonly volume: Float64Array,
  ) {
    this.length = time.length;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  static empty(): CandleSeries {
    return new CandleSeries(EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY);
  }

  static fromColumns(columns: CandleColumns): CandleSeries {
    const { time, open, high, low, close, volume } = columns;
    const n = time.length;
    if (
      open.length !== n ||
      high.length !== n ||
      low.length !== n ||
      close.length !== n ||
      volume.length !== n
    ) {
      throw new Error('CandleSeries columns must all have the same length');
    }
    return new CandleSeries(time, open, high, low, close, volume);
  }

  static fromBars(bars: readonly BarTuple[]): CandleSeries {
    const n = bars.length;
    const time = new Float64Array(n);
    const open = new Float64Array(n);
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);
    const volume = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      time[i] = bar[0];
      open[i] = bar[1];
      high[i] = bar[2];
      low[i] = bar[3];
      close[i] = bar[4];
      volume[i] = bar[5];
    }
    return new CandleSeries(time, open, high, low, close, volume);
  }

  static fromCandles(candles: readonly Candle[]): CandleSeries {
    return CandleSeries.fromBars(
      candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume] as BarTuple),
    );
  }

  /**
   * Concatenate series, sort by timestamp and keep the LAST bar for each
   * duplicated timestamp — the same rule the parquet cache used
   * (`~index.duplicated(keep="last")` followed by `sort_index()`).
   */
  static mergeDedupe(parts: readonly CandleSeries[]): CandleSeries {
    const rows: BarTuple[] = [];
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) {
        rows.push([
          part.time[i],
          part.open[i],
          part.high[i],
          part.low[i],
          part.close[i],
          part.volume[i],
        ]);
      }
    }
    // Stable sort by time; because later parts were pushed later, the last
    // occurrence of a duplicate timestamp is the one that wins below.
    const order = rows.map((_, i) => i);
    order.sort((a, b) => rows[a][0] - rows[b][0] || a - b);

    const kept: BarTuple[] = [];
    for (let k = 0; k < order.length; k++) {
      const row = rows[order[k]];
      const next = k + 1 < order.length ? rows[order[k + 1]] : null;
      if (next === null || next[0] !== row[0]) {
        kept.push(row);
      }
    }
    return CandleSeries.fromBars(kept);
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  get isEmpty(): boolean {
    return this.length === 0;
  }

  timeAt(index: number): number {
    return this.time[index];
  }

  candleAt(index: number): Candle {
    if (index < 0 || index >= this.length) {
      throw new RangeError(`candle index ${index} out of range (length ${this.length})`);
    }
    return {
      time: this.time[index],
      open: this.open[index],
      high: this.high[index],
      low: this.low[index],
      close: this.close[index],
      volume: this.volume[index],
    };
  }

  get firstTime(): number | null {
    return this.length === 0 ? null : this.time[0];
  }

  get lastTime(): number | null {
    return this.length === 0 ? null : this.time[this.length - 1];
  }

  // -------------------------------------------------------------------------
  // Slicing — views, never copies
  // -------------------------------------------------------------------------

  /** Zero-copy view of `[start, end)`; indices are clamped like `df.iloc`. */
  slice(start = 0, end = this.length): CandleSeries {
    return new CandleSeries(
      this.time.subarray(start, end),
      this.open.subarray(start, end),
      this.high.subarray(start, end),
      this.low.subarray(start, end),
      this.close.subarray(start, end),
      this.volume.subarray(start, end),
    );
  }

  head(count: number): CandleSeries {
    return this.slice(0, Math.max(0, count));
  }

  /**
   * Last `count` bars.
   *
   * `count <= 0` returns the whole series, reproducing `df.iloc[-0:]` in the
   * Python `MarketContext.load` — Python's negative-slice trick degenerates to
   * "everything" at zero, and MarketContext relies on that shape.
   */
  tail(count: number): CandleSeries {
    if (count <= 0) {
      return this.slice(0, this.length);
    }
    return this.slice(Math.max(0, this.length - count), this.length);
  }

  // -------------------------------------------------------------------------
  // Binary search over timestamps
  // -------------------------------------------------------------------------

  /**
   * numpy / pandas `searchsorted(value, side="right")`: the number of bars
   * whose timestamp is `<= value`, i.e. a strict upper bound.
   *
   * The engine slices every timeframe with this to enforce data isolation, so
   * an off-by-one here would silently leak a future bar into the strategy.
   */
  searchSortedRight(timeMs: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.time[mid] <= timeMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** `searchsorted(value, side="left")`: index of the first bar `>= value`. */
  searchSortedLeft(timeMs: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.time[mid] < timeMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Bars with timestamp `<= timeMs` — the engine's visibility window. */
  visibleAt(timeMs: number): CandleSeries {
    return this.slice(0, this.searchSortedRight(timeMs));
  }

  /** Bars with `from <= t <= to`, both bounds inclusive (`df.loc[a:b]`). */
  between(fromMs: number, toMs: number): CandleSeries {
    return this.slice(this.searchSortedLeft(fromMs), this.searchSortedRight(toMs));
  }

  // -------------------------------------------------------------------------

  *[Symbol.iterator](): IterableIterator<Candle> {
    for (let i = 0; i < this.length; i++) {
      yield this.candleAt(i);
    }
  }

  toBars(): BarTuple[] {
    const out: BarTuple[] = [];
    for (let i = 0; i < this.length; i++) {
      out.push([
        this.time[i],
        this.open[i],
        this.high[i],
        this.low[i],
        this.close[i],
        this.volume[i],
      ]);
    }
    return out;
  }
}
