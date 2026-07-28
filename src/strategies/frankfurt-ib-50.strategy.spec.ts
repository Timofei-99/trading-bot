import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Direction } from '../domain/signal';
import { FrankfurtIb50Strategy } from './frankfurt-ib-50.strategy';

const MINUTE = 60_000;
const SYMBOL = 'FDAX';

// IB window: 08:00–09:00 UTC.  London entry window: 09:00–12:00 UTC.
// startMs = Date.UTC(2024, 0, 15, 8, 0)
//   bar  0 → 08:00 UTC  (IB open)
//   bar 59 → 08:59 UTC  (last IB bar)
//   bar 60 → 09:00 UTC  (first London bar, in entry window)
//   bar239 → 11:59 UTC  (last bar in entry window)
//   bar240 → 12:00 UTC  (session end, outside entry window)

const IB_START_MS = Date.UTC(2024, 0, 15, 8, 0);

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

// IB: high 105, low 95, mid 100
const IB_HIGHS = repeat(105, 60);
const IB_LOWS = repeat(95, 60);
const IB_CLOSES = repeat(100, 60);

describe('FrankfurtIb50Strategy v2', () => {
  describe('timing gates', () => {
    it('does not enter while the IB window is still open', () => {
      const series = candles(IB_HIGHS.slice(0, 30), IB_LOWS.slice(0, 30), null, IB_START_MS);
      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(series))).toBeNull();
    });

    it('does not enter once the session end is reached', () => {
      // 60 IB bars + 180 bars with closes inside range + 1 bar at 12:00 UTC
      const series = candles(
        [...IB_HIGHS, ...repeat(104, 180), 110],
        [...IB_LOWS, ...repeat(96, 180), 104],
        [...IB_CLOSES, ...repeat(100, 180), 106], // bar 240 → 12:00 UTC, close 106 > high but gated out
        IB_START_MS,
      );
      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(series))).toBeNull();
    });
  });

  describe('breakout entries', () => {
    it('goes long when a 1m bar closes above the Frankfurt high', () => {
      const series = candles(
        [...IB_HIGHS, 110],
        [...IB_LOWS, 104],
        [...IB_CLOSES, 106], // 106 > IB high 105
        IB_START_MS,
      );
      const signal = new FrankfurtIb50Strategy().checkEntry(contextOf(series));

      expect(signal).not.toBeNull();
      expect(signal?.direction).toBe(Direction.Long);
      expect(signal?.entry).toBeCloseTo(106, 12);
      expect(signal?.stopLoss).toBeCloseTo(95, 12); // IB low
      expect(signal?.takeProfit).toBeCloseTo(117, 12); // 106 + (106 − 95) = 117, 1:1 RR
      expect(signal?.meta.ib_high).toBeCloseTo(105, 12);
      expect(signal?.meta.ib_low).toBeCloseTo(95, 12);
      expect(signal?.meta.ib_mid).toBeCloseTo(100, 12);
      expect(signal?.expiryTime).toBe(Date.UTC(2024, 0, 15, 12, 0));
    });

    it('goes short when a 1m bar closes below the Frankfurt low', () => {
      const series = candles(
        [...IB_HIGHS, 96],
        [...IB_LOWS, 90],
        [...IB_CLOSES, 94], // 94 < IB low 95
        IB_START_MS,
      );
      const signal = new FrankfurtIb50Strategy().checkEntry(contextOf(series));

      expect(signal).not.toBeNull();
      expect(signal?.direction).toBe(Direction.Short);
      expect(signal?.entry).toBeCloseTo(94, 12);
      expect(signal?.stopLoss).toBeCloseTo(105, 12); // IB high
      expect(signal?.takeProfit).toBeCloseTo(83, 12); // 94 − (105 − 94) = 83, 1:1 RR
    });

    it('stays out when the close is inside the Frankfurt range', () => {
      const series = candles(
        [...IB_HIGHS, 104],
        [...IB_LOWS, 96],
        [...IB_CLOSES, 100], // 95 ≤ 100 ≤ 105
        IB_START_MS,
      );
      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(series))).toBeNull();
    });

    it('stays out when close equals the IB edge exactly', () => {
      const series = candles(
        [...IB_HIGHS, 106],
        [...IB_LOWS, 94],
        [...IB_CLOSES, 105], // close == IB high, not strictly above
        IB_START_MS,
      );
      expect(new FrankfurtIb50Strategy().checkEntry(contextOf(series))).toBeNull();
    });
  });

  it('takes one entry per session — first breakout wins', () => {
    // Bar 60: long signal (close 106 > high 105)
    // Bar 61: would be short (close 94 < low 95) but already entered
    const series = candles(
      [...IB_HIGHS, 110, 96],
      [...IB_LOWS, 104, 90],
      [...IB_CLOSES, 106, 94],
      IB_START_MS,
    );
    const strategy = new FrankfurtIb50Strategy();

    const first = strategy.checkEntry(contextOf(series.slice(0, 61)));
    expect(first).not.toBeNull();
    expect(first?.direction).toBe(Direction.Long);

    const second = strategy.checkEntry(contextOf(series));
    expect(second).toBeNull();
  });

  describe('construction', () => {
    it('rejects a config where ibEnd is before ibStart', () => {
      expect(() => new FrankfurtIb50Strategy({ ibStart: '10:00', ibEnd: '09:00' })).toThrow(
        /ibStart < ibEnd <= sessionEnd/,
      );
    });

    it('rejects a config where sessionEnd is before ibEnd', () => {
      expect(
        () => new FrankfurtIb50Strategy({ ibStart: '08:00', ibEnd: '09:00', sessionEnd: '08:30' }),
      ).toThrow(/ibStart < ibEnd <= sessionEnd/);
    });
  });
});
