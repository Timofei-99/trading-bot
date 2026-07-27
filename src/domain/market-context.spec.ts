import { BarTuple, Candle, CandleSeries } from './candle-series';
import { MarketContext } from './market-context';

const MINUTE = 60_000;
const T0 = Date.UTC(2024, 0, 1);

function series(closes: number[], startMs = T0): CandleSeries {
  return CandleSeries.fromBars(
    closes.map((c, i) => [startMs + i * MINUTE, c, c, c, c, 100] as BarTuple),
  );
}

function candle(timeMs: number, value: number, volume = 10): Candle {
  return { time: timeMs, open: value, high: value, low: value, close: value, volume };
}

function context(timeframes: string[] = ['1m', '1h'], maxCandles = 500): MarketContext {
  return new MarketContext('BTC/USDT', timeframes, maxCandles);
}

describe('MarketContext', () => {
  it('loads and returns candles per timeframe', () => {
    const ctx = context(['1m']);
    ctx.load('1m', series([100, 200]));

    const result = ctx.candles('1m');
    expect(result.length).toBe(2);
    expect(Array.from(result.close)).toEqual([100, 200]);
  });

  it('throws for a timeframe it was not configured with', () => {
    const ctx = context(['1m']);
    expect(() => ctx.candles('4h')).toThrow(/Unknown timeframe/);
  });

  it('returns an empty series for a configured but unloaded timeframe', () => {
    const ctx = context(['1m', '1h']);
    ctx.load('1m', series([100]));
    expect(ctx.candles('1h').isEmpty).toBe(true);
  });

  it('truncates to maxCandles on load', () => {
    const ctx = context(['1m'], 3);
    ctx.load('1m', series([1, 2, 3, 4, 5]));
    expect(Array.from(ctx.candles('1m').close)).toEqual([3, 4, 5]);
  });

  describe('update', () => {
    it('appends a bar with a new timestamp', () => {
      const ctx = context(['1m']);
      ctx.load('1m', series([100]));

      ctx.update('1m', candle(T0 + MINUTE, 200));

      const result = ctx.candles('1m');
      expect(result.length).toBe(2);
      expect(result.close[result.length - 1]).toBe(200);
    });

    it('replaces the bar when the timestamp repeats', () => {
      const ctx = context(['1m']);
      ctx.load('1m', series([100]));

      ctx.update('1m', candle(T0, 999, 5));

      const result = ctx.candles('1m');
      expect(result.length).toBe(1);
      expect(result.close[0]).toBe(999);
      expect(result.volume[0]).toBe(5);
    });

    it('appends into an unloaded timeframe', () => {
      const ctx = context(['1m']);
      ctx.update('1m', candle(T0, 42));
      expect(Array.from(ctx.candles('1m').close)).toEqual([42]);
    });

    it('respects maxCandles when appending', () => {
      const ctx = context(['1m'], 2);
      ctx.load('1m', series([1, 2]));
      ctx.update('1m', candle(T0 + 2 * MINUTE, 3));
      expect(Array.from(ctx.candles('1m').close)).toEqual([2, 3]);
    });

  });

  describe('isReady', () => {
    it('is false with nothing loaded', () => {
      expect(context(['1m', '1h']).isReady()).toBe(false);
    });

    it('is false when only some timeframes are loaded', () => {
      const ctx = context(['1m', '1h']);
      ctx.load('1m', series([100]));
      expect(ctx.isReady()).toBe(false);
    });

    it('is true once every timeframe has bars', () => {
      const ctx = context(['1m', '1h']);
      ctx.load('1m', series([100]));
      ctx.load('1h', series([100]));
      expect(ctx.isReady()).toBe(true);
    });

    it('is false when a loaded timeframe is empty', () => {
      const ctx = context(['1m']);
      ctx.load('1m', CandleSeries.empty());
      expect(ctx.isReady()).toBe(false);
    });
  });

  describe('lastPrice', () => {
    it('takes the last close of the finest loaded timeframe', () => {
      const ctx = context(['1m', '1h']);
      ctx.load('1m', series([100, 200, 300]));
      ctx.load('1h', series([500]));
      expect(ctx.lastPrice()).toBe(300);
    });

    it('is null when nothing is loaded', () => {
      expect(context(['1m']).lastPrice()).toBeNull();
    });

    it('is null when the finest loaded timeframe is empty', () => {
      const ctx = context(['1m']);
      ctx.load('1m', CandleSeries.empty());
      expect(ctx.lastPrice()).toBeNull();
    });

    it('lets an unrecognised timeframe win, as TIMEFRAME_MINUTES.get(tf, 0) did', () => {
      const ctx = context(['weird', '1h']);
      ctx.load('weird', series([7]));
      ctx.load('1h', series([500]));
      expect(ctx.lastPrice()).toBe(7);
    });
  });

  it('summarises loaded bar counts', () => {
    const ctx = context(['1m', '1h']);
    ctx.load('1m', series([1, 2, 3]));
    ctx.load('1h', series([1]));
    expect(ctx.summary()).toEqual({ '1m': 3, '1h': 1 });
  });
});
