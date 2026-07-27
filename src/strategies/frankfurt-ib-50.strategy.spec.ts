import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Direction } from '../domain/signal';
import { FrankfurtIb50Strategy } from './frankfurt-ib-50.strategy';

const MINUTE = 60_000;
const SYMBOL = 'FDAX';

// Winter: 08:00 Berlin = 07:00 UTC, 09:00 Berlin = 08:00 UTC,
//         10:00 Berlin (session end) = 09:00 UTC.
// Summer: each shifts one hour earlier in UTC.

function candles(
  highs: number[],
  lows: number[],
  closes: number[] | null,
  startMs: number,
): CandleSeries {
  return CandleSeries.fromBars(
    highs.map((high, i) => {
      const close = closes ? closes[i] : (high + lows[i]) / 2;
      return [startMs + i * MINUTE, close, high, lows[i], close, 1] as BarTuple;
    }),
  );
}

function contextOf(series: CandleSeries): MarketContext {
  const context = new MarketContext(SYMBOL, ['1m'], 10_000);
  context.load('1m', series);
  return context;
}

const repeat = (value: number, times: number): number[] => Array<number>(times).fill(value);

describe('FrankfurtIb50Strategy', () => {
  describe('timing gates', () => {
    it('does not enter while the IB window is still open', () => {
      // Bars from 06:00 UTC, cut off at 07:30 UTC — inside 08:00-09:00 Berlin.
      const series = candles(
        [...repeat(100, 30), ...repeat(110, 30)],
        [...repeat(95, 30), ...repeat(90, 30)],
        [...repeat(97.5, 30), ...repeat(100, 30)],
        Date.UTC(2024, 0, 15, 6, 0),
      );
      const upToIb = series.slice(0, series.searchSortedRight(Date.UTC(2024, 0, 15, 7, 30)));

      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(upToIb))).toBeNull();
    });

    it('does not enter once the session has ended', () => {
      const series = candles(
        [...repeat(100, 60), ...repeat(200, 121)],
        [...repeat(90, 60), ...repeat(100, 121)],
        [...repeat(95, 60), ...repeat(150, 121)],
        Date.UTC(2024, 0, 15, 6, 0),
      );
      const afterEnd = series.slice(series.searchSortedLeft(Date.UTC(2024, 0, 15, 9, 0)));

      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(afterEnd))).toBeNull();
    });
  });

  describe('crossing the IB midpoint', () => {
    // IB high 105, low 95 -> mid 100, range 10.
    const IB_HIGHS = repeat(105, 60);
    const IB_LOWS = repeat(95, 60);

    it('goes long when closes cross the midpoint upwards', () => {
      const series = candles(
        [...IB_HIGHS, 102],
        [...IB_LOWS, 99],
        [...repeat(100, 59), 99, 101],
        Date.UTC(2024, 0, 15, 7, 0),
      );
      const signal = new FrankfurtIb50Strategy().checkEntry(contextOf(series));

      expect(signal).not.toBeNull();
      expect(signal?.direction).toBe(Direction.Long);
      expect(signal?.entry).toBeCloseTo(101, 12);
      expect(signal?.meta.ib_high).toBeCloseTo(105, 12);
      expect(signal?.meta.ib_low).toBeCloseTo(95, 12);
      expect(signal?.meta.ib_mid).toBeCloseTo(100, 12);
      // A full IB projection above the high: 105 + (105 - 95).
      expect(signal?.takeProfit).toBeCloseTo(115, 12);
      expect(signal?.stopLoss).toBeLessThanOrEqual(signal?.entry as number);
      expect(signal?.expiryTime).toBe(Date.UTC(2024, 0, 15, 9, 0));
    });

    it('goes short when closes cross the midpoint downwards', () => {
      const series = candles(
        [...IB_HIGHS, 100],
        [...IB_LOWS, 98],
        [...repeat(100, 59), 101, 99],
        Date.UTC(2024, 0, 15, 7, 0),
      );
      const signal = new FrankfurtIb50Strategy().checkEntry(contextOf(series));

      expect(signal?.direction).toBe(Direction.Short);
      expect(signal?.entry).toBeCloseTo(99, 12);
      expect(signal?.takeProfit).toBeCloseTo(85, 12); // 95 - (105 - 95)
      expect(signal?.stopLoss).toBeGreaterThanOrEqual(signal?.entry as number);
    });

    it('stays out while closes remain on one side of the midpoint', () => {
      const series = candles(
        [...IB_HIGHS, 98],
        [...IB_LOWS, 96],
        [...repeat(100, 59), 97, 98],
        Date.UTC(2024, 0, 15, 7, 0),
      );
      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(series))).toBeNull();
    });
  });

  it('takes one entry per session, no matter how many bars follow', () => {
    const series = candles(
      [...repeat(105, 60), 102, 103],
      [...repeat(95, 60), 99, 100.5],
      [...repeat(100, 59), 99, 101, 102],
      Date.UTC(2024, 0, 15, 7, 0),
    );
    const strategy = new FrankfurtIb50Strategy();

    expect(strategy.checkEntry(contextOf(series.slice(0, 61)))).not.toBeNull();
    expect(strategy.checkEntry(contextOf(series))).toBeNull();
  });

  it('follows the session into summer time', () => {
    // 08:00 Berlin CEST is 06:00 UTC, so the IB runs 06:00-06:59 UTC and the
    // first post-IB bar is at 07:00 UTC.
    const series = candles(
      [...repeat(105, 60), 99, 101],
      [...repeat(95, 60), 98, 100],
      [...repeat(100, 60), 99, 101],
      Date.UTC(2024, 6, 15, 6, 0),
    );
    const signal = new FrankfurtIb50Strategy().checkEntry(contextOf(series));

    expect(signal?.direction).toBe(Direction.Long);
    // 10:00 Berlin CEST is 08:00 UTC.
    expect(signal?.expiryTime).toBe(Date.UTC(2024, 6, 15, 8, 0));
  });

  describe('construction', () => {
    it('rejects a session that ends before it starts', () => {
      expect(() => new FrankfurtIb50Strategy({ sessionStart: '10:00', sessionEnd: '09:00' })).toThrow(
        /sessionStart < ibEnd <= sessionEnd/,
      );
    });

    it('rejects an IB that runs past the session end', () => {
      expect(
        () =>
          new FrankfurtIb50Strategy({
            sessionStart: '08:00',
            ibDurationMinutes: 180,
            sessionEnd: '09:00',
          }),
      ).toThrow(/sessionStart < ibEnd <= sessionEnd/);
    });
  });
});
