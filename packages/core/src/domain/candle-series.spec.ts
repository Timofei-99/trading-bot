import { loadGolden, loadGoldenCandles } from '../../../../test/fixtures/helpers';
import { BarTuple, CandleSeries } from './candle-series';

const bars = (...times: number[]): BarTuple[] =>
  times.map((t, i) => [t, 1 + i, 2 + i, 0.5 + i, 1.5 + i, 100 + i] as BarTuple);

describe('CandleSeries', () => {
  describe('construction', () => {
    it('is empty by default', () => {
      const series = CandleSeries.empty();
      expect(series.length).toBe(0);
      expect(series.isEmpty).toBe(true);
      expect(series.firstTime).toBeNull();
      expect(series.lastTime).toBeNull();
    });

    it('reads bars column-wise', () => {
      const series = CandleSeries.fromBars([[1000, 10, 12, 9, 11, 500]]);
      expect(series.length).toBe(1);
      expect(series.candleAt(0)).toEqual({
        time: 1000,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 500,
      });
    });

    it('rejects columns of differing length', () => {
      expect(() =>
        CandleSeries.fromColumns({
          time: Float64Array.from([1, 2]),
          open: Float64Array.from([1]),
          high: Float64Array.from([1, 2]),
          low: Float64Array.from([1, 2]),
          close: Float64Array.from([1, 2]),
          volume: Float64Array.from([1, 2]),
        }),
      ).toThrow(/same length/);
    });

    it('rejects out-of-range indices', () => {
      const series = CandleSeries.fromBars(bars(1, 2));
      expect(() => series.candleAt(2)).toThrow(RangeError);
      expect(() => series.candleAt(-1)).toThrow(RangeError);
    });
  });

  describe('slicing', () => {
    it('shares memory instead of copying', () => {
      const series = CandleSeries.fromBars(bars(1, 2, 3, 4));
      const view = series.slice(1, 3);

      expect(view.length).toBe(2);
      expect(view.close.buffer).toBe(series.close.buffer);

      view.close[0] = 999;
      expect(series.close[1]).toBe(999);
    });

    it('clamps out-of-range bounds like df.iloc', () => {
      const series = CandleSeries.fromBars(bars(1, 2, 3));
      expect(series.slice(0, 99).length).toBe(3);
      expect(series.slice(5, 9).length).toBe(0);
      expect(series.head(99).length).toBe(3);
      expect(series.tail(99).length).toBe(3);
    });

    it('keeps the last N bars', () => {
      const series = CandleSeries.fromBars(bars(1, 2, 3, 4, 5));
      expect(Array.from(series.tail(2).time)).toEqual([4, 5]);
    });

    it('treats tail(0) as "everything", matching df.iloc[-0:]', () => {
      // MarketContext.load relies on this: Python's negative-slice trick
      // degenerates to the whole frame at zero.
      const series = CandleSeries.fromBars(bars(1, 2, 3));
      expect(series.tail(0).length).toBe(3);
      expect(series.tail(-5).length).toBe(3);
    });
  });

  describe('mergeDedupe', () => {
    it('sorts by time and keeps the last bar for a repeated timestamp', () => {
      const older = CandleSeries.fromBars([
        [3000, 1, 1, 1, 1, 1],
        [1000, 2, 2, 2, 2, 2],
      ]);
      const newer = CandleSeries.fromBars([
        [2000, 3, 3, 3, 3, 3],
        [3000, 4, 4, 4, 4, 4],
      ]);

      const merged = CandleSeries.mergeDedupe([older, newer]);

      expect(Array.from(merged.time)).toEqual([1000, 2000, 3000]);
      // 3000 appeared in both; the later part wins.
      expect(merged.open[2]).toBe(4);
    });
  });

  describe('searchSorted', () => {
    it('matches pandas Index.searchsorted on real data', () => {
      const series = loadGoldenCandles('btc_4h');
      const golden = loadGolden<{
        probes: { timestamp: number; right: number; left: number }[];
      }>('domain', 'searchsorted.json');

      expect(golden.probes.length).toBeGreaterThan(0);
      for (const probe of golden.probes) {
        expect(series.searchSortedRight(probe.timestamp)).toBe(probe.right);
        expect(series.searchSortedLeft(probe.timestamp)).toBe(probe.left);
      }
    });

    it('treats side="right" as a strict upper bound', () => {
      const series = CandleSeries.fromBars(bars(100, 200, 300));
      expect(series.searchSortedRight(99)).toBe(0);
      expect(series.searchSortedRight(100)).toBe(1);
      expect(series.searchSortedRight(150)).toBe(1);
      expect(series.searchSortedRight(300)).toBe(3);
      expect(series.searchSortedRight(301)).toBe(3);
    });

    it('treats side="left" as a lower bound', () => {
      const series = CandleSeries.fromBars(bars(100, 200, 300));
      expect(series.searchSortedLeft(99)).toBe(0);
      expect(series.searchSortedLeft(100)).toBe(0);
      expect(series.searchSortedLeft(150)).toBe(1);
      expect(series.searchSortedLeft(300)).toBe(2);
      expect(series.searchSortedLeft(301)).toBe(3);
    });

    it('returns 0 on an empty series', () => {
      expect(CandleSeries.empty().searchSortedRight(1)).toBe(0);
      expect(CandleSeries.empty().searchSortedLeft(1)).toBe(0);
    });

    it('includes the current bar in visibleAt', () => {
      const series = CandleSeries.fromBars(bars(100, 200, 300));
      expect(series.visibleAt(200).length).toBe(2);
      expect(series.visibleAt(200).lastTime).toBe(200);
      expect(series.visibleAt(199).length).toBe(1);
    });

    it('treats both bounds of between() as inclusive', () => {
      const series = CandleSeries.fromBars(bars(100, 200, 300, 400));
      expect(Array.from(series.between(200, 300).time)).toEqual([200, 300]);
      expect(Array.from(series.between(150, 350).time)).toEqual([200, 300]);
    });
  });

  it('iterates candles in order', () => {
    const series = CandleSeries.fromBars(bars(1, 2, 3));
    expect([...series].map((c) => c.time)).toEqual([1, 2, 3]);
  });

  it('round-trips through toBars', () => {
    const input: BarTuple[] = [
      [1000, 10, 12, 9, 11, 500],
      [2000, 11, 13, 10, 12, 600],
    ];
    expect(CandleSeries.fromBars(input).toBars()).toEqual(input);
  });
});
