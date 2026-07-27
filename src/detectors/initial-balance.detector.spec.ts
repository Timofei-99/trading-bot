import { BarTuple, CandleSeries } from '../domain/candle-series';
import { PatternType } from '../domain/pattern';
import { InitialBalanceDetector } from './initial-balance.detector';

const MINUTE = 60_000;

/**
 * One-minute bars where row `i` has open = close = i, high = i + 0.5 and
 * low = i - 0.5, so the wick extremes of any window read straight off the
 * minute-of-day numbers.
 */
function minuteCandles(startMs: number, periods = 60 * 24): CandleSeries {
  return CandleSeries.fromBars(
    Array.from(
      { length: periods },
      (_, i) => [startMs + i * MINUTE, i, i + 0.5, i - 0.5, i, 1] as BarTuple,
    ),
  );
}

const JAN_1 = Date.UTC(2024, 0, 1);
const JUL_1 = Date.UTC(2024, 6, 1);

describe('InitialBalanceDetector', () => {
  it('returns nothing for an empty series', () => {
    expect(new InitialBalanceDetector().detect(CandleSeries.empty())).toEqual([]);
  });

  describe('the default Frankfurt window follows daylight saving', () => {
    it('lands on 07:00 UTC in winter', () => {
      const patterns = new InitialBalanceDetector().detect(minuteCandles(JAN_1));

      expect(patterns).toHaveLength(1);
      const ib = patterns[0];
      expect(ib.type).toBe(PatternType.InitialBalance);
      expect(ib.startTime).toBe(Date.UTC(2024, 0, 1, 7, 0));
      expect(ib.endTime).toBe(Date.UTC(2024, 0, 1, 7, 59));
      // minutes 420..479 -> highs 420.5..479.5, lows 419.5..478.5
      expect(ib.high).toBeCloseTo(479.5, 12);
      expect(ib.low).toBeCloseTo(419.5, 12);
      expect(ib.meta.session).toBe('frankfurt');
      expect(ib.meta.duration_minutes).toBe(60);
      expect(ib.meta.mid).toBeCloseTo((479.5 + 419.5) / 2, 12);
      expect(ib.meta.session_date).toBe('2024-01-01');
    });

    it('shifts to 06:00 UTC in summer', () => {
      const ib = new InitialBalanceDetector().detect(minuteCandles(JUL_1))[0];
      expect(ib.startTime).toBe(Date.UTC(2024, 6, 1, 6, 0));
      expect(ib.endTime).toBe(Date.UTC(2024, 6, 1, 6, 59));
    });
  });

  it('reports nothing when the data misses the window', () => {
    // Starts at 08:00 UTC, so 07:00-07:59 UTC is never covered.
    const candles = minuteCandles(Date.UTC(2024, 0, 1, 8, 0), 60 * 12);
    expect(new InitialBalanceDetector().detect(candles)).toEqual([]);
  });

  it('emits one pattern per local calendar day', () => {
    const patterns = new InitialBalanceDetector().detect(minuteCandles(JAN_1, 60 * 24 * 3));
    expect(patterns.map((p) => p.meta.session_date)).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
    ]);
  });

  it('honours a custom session and duration', () => {
    const detector = new InitialBalanceDetector({
      sessionStart: '13:00',
      sessionTz: 'Europe/Berlin',
      durationMinutes: 30,
      session: 'ny_open',
    });
    const ib = detector.detect(minuteCandles(JAN_1))[0];

    // 13:00 Berlin in winter is 12:00 UTC -> minutes 720..749.
    expect(ib.startTime).toBe(Date.UTC(2024, 0, 1, 12, 0));
    expect(ib.endTime).toBe(Date.UTC(2024, 0, 1, 12, 29));
    expect(ib.high).toBeCloseTo(749.5, 12);
    expect(ib.low).toBeCloseTo(719.5, 12);
    expect(ib.meta.session).toBe('ny_open');
    expect(ib.meta.duration_minutes).toBe(30);
  });

  it('keeps a UTC session fixed across the year', () => {
    const detector = new InitialBalanceDetector({ sessionStart: '06:00', sessionTz: 'UTC' });
    const winter = detector.detect(minuteCandles(Date.UTC(2024, 0, 15)))[0];
    const summer = detector.detect(minuteCandles(Date.UTC(2024, 6, 15)))[0];

    expect(new Date(winter.startTime).getUTCHours()).toBe(6);
    expect(new Date(summer.startTime).getUTCHours()).toBe(6);
  });

  it('takes the extremes from wicks, not bodies', () => {
    const candles = CandleSeries.fromBars([
      [Date.UTC(2024, 0, 1, 7, 0), 100, 110, 99, 100.5, 1], // 08:00 Berlin, winter
      [Date.UTC(2024, 0, 1, 7, 30), 101, 101.5, 90, 101, 1],
    ]);
    const ib = new InitialBalanceDetector().detect(candles)[0];
    expect(ib.high).toBeCloseTo(110, 12);
    expect(ib.low).toBeCloseTo(90, 12);
  });

  it('reports mid as the arithmetic mean of the extremes', () => {
    const ib = new InitialBalanceDetector().detect(minuteCandles(JAN_1))[0];
    expect(ib.meta.mid).toBe((ib.high + ib.low) / 2);
  });

  describe('sessions that straddle a daylight-saving transition', () => {
    const overRepeatedHour = new InitialBalanceDetector({
      sessionStart: '02:00',
      durationMinutes: 60,
      sessionTz: 'Europe/Berlin',
      timeframe: '1m',
    });

    it('measures a real 60 minutes when the local hour happens twice', () => {
      // Berlin turns the clock back on 2024-10-27, so 02:00-03:00 local occurs
      // twice. Selecting bars by minute-of-day would match both passes and
      // build the balance out of 120 minutes of data.
      const bars = minuteCandles(Date.UTC(2024, 9, 26, 22, 0), 60 * 12);
      const patterns = overRepeatedHour.detect(bars);

      expect(patterns).toHaveLength(1);
      const spanMinutes = ((patterns[0].endTime as number) - patterns[0].startTime) / MINUTE + 1;
      expect(spanMinutes).toBe(60);
      expect(patterns[0].meta.duration_minutes).toBe(60);
      // The first pass, while the clock still reads CEST: 00:00 UTC.
      expect(patterns[0].startTime).toBe(Date.UTC(2024, 9, 27, 0, 0));
    });

    it('shifts forward instead of vanishing when the local hour does not exist', () => {
      // Berlin skips 02:00-03:00 on 2024-03-31 entirely.
      const bars = minuteCandles(Date.UTC(2024, 2, 30, 22, 0), 60 * 12);
      const patterns = overRepeatedHour.detect(bars);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].meta.session_date).toBe('2024-03-31');
      // The clock jumps straight to 03:00 local, which is 01:00 UTC.
      expect(patterns[0].startTime).toBe(Date.UTC(2024, 2, 31, 1, 0));
      const spanMinutes = ((patterns[0].endTime as number) - patterns[0].startTime) / MINUTE + 1;
      expect(spanMinutes).toBe(60);
    });

    it('is unchanged for a session far from the transition', () => {
      // The Frankfurt default sits at 08:00, so both days behave normally.
      const marchBars = minuteCandles(Date.UTC(2024, 2, 31, 0, 0), 60 * 12);
      const ib = new InitialBalanceDetector().detect(marchBars)[0];
      expect(ib.startTime).toBe(Date.UTC(2024, 2, 31, 6, 0)); // 08:00 CEST
      expect(ib.endTime).toBe(Date.UTC(2024, 2, 31, 6, 59));
    });
  });

  describe('validation', () => {
    it('rejects a malformed session start', () => {
      expect(() => new InitialBalanceDetector({ sessionStart: '25:00' })).toThrow();
      expect(() => new InitialBalanceDetector({ sessionStart: 'bogus' })).toThrow();
    });

    it('rejects a non-positive duration', () => {
      expect(() => new InitialBalanceDetector({ durationMinutes: 0 })).toThrow(
        /duration_minutes must be positive/,
      );
    });

    it('rejects a window that would cross local midnight', () => {
      const detector = new InitialBalanceDetector({
        sessionStart: '23:30',
        durationMinutes: 120,
      });
      expect(() => detector.detect(minuteCandles(JAN_1))).toThrow(/must not cross local midnight/);
    });
  });
});
