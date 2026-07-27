import { BarTuple, CandleSeries } from '../domain/candle-series';
import { Pattern, PatternType } from '../domain/pattern';
import { KillzoneDetector, KillzoneWindow } from './killzone.detector';

const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);

/**
 * `n * 24` hourly bars from 2024-01-01T00:00Z, where the bar at absolute hour
 * `i` has high = i + 1 and low = i. That makes every window's high and low
 * readable straight off the hour numbers.
 */
function hourlyCandles(days = 1): CandleSeries {
  const count = days * 24;
  return CandleSeries.fromBars(
    Array.from({ length: count }, (_, i) => {
      const high = i + 1;
      const low = i;
      const mid = (high + low) / 2;
      return [START + i * HOUR, mid, high, low, mid, 1000] as BarTuple;
    }),
  );
}

const named = (patterns: Pattern[], name: string): Pattern =>
  patterns.find((p) => p.meta.name === name) as Pattern;

describe('KillzoneDetector', () => {
  describe('edge cases', () => {
    it('returns nothing for an empty series', () => {
      expect(new KillzoneDetector().detect(CandleSeries.empty())).toEqual([]);
    });

    it('returns nothing when no candle falls inside a window', () => {
      // One bar per day, all at 00:00 UTC — outside every default window.
      const candles = CandleSeries.fromBars(
        Array.from(
          { length: 3 },
          (_, i) => [START + i * 24 * HOUR, 100, 101, 99, 100, 1000] as BarTuple,
        ),
      );
      expect(new KillzoneDetector().detect(candles)).toEqual([]);
    });
  });

  describe('a single day', () => {
    const patterns = new KillzoneDetector().detect(hourlyCandles(1));

    it('finds all four default killzones', () => {
      expect(patterns).toHaveLength(4);
      expect(new Set(patterns.map((p) => p.meta.name))).toEqual(
        new Set(['asian', 'london_open', 'ny_open', 'london_close']),
      );
      expect(patterns.every((p) => p.type === PatternType.Killzone)).toBe(true);
    });

    it('spans the asian window, hours 1 to 4', () => {
      const asian = named(patterns, 'asian');
      expect(asian.meta.candle_count).toBe(4);
      expect(asian.high).toBeCloseTo(5, 12); // hour 4 -> high 5
      expect(asian.low).toBeCloseTo(1, 12); // hour 1 -> low 1
      expect(asian.startTime).toBe(START + 1 * HOUR);
      expect(asian.endTime).toBe(START + 4 * HOUR);
    });

    it('counts three bars in london_open and two in london_close', () => {
      expect(named(patterns, 'london_open').meta.candle_count).toBe(3);
      expect(named(patterns, 'london_close').meta.candle_count).toBe(2);
    });

    it('spans the ny_open window, hours 12 to 14', () => {
      const ny = named(patterns, 'ny_open');
      expect(ny.high).toBeCloseTo(15, 12);
      expect(ny.low).toBeCloseTo(12, 12);
    });

    it('always has a definite end', () => {
      expect(patterns.every((p) => p.endTime !== null)).toBe(true);
    });

    it('exposes the window midpoint', () => {
      for (const pattern of patterns) {
        expect(pattern.mid).toBeCloseTo((pattern.high + pattern.low) / 2, 12);
      }
    });
  });

  describe('several days', () => {
    const patterns = new KillzoneDetector().detect(hourlyCandles(2));

    it('emits one pattern per killzone per day', () => {
      expect(patterns).toHaveLength(8);
    });

    it('returns them in chronological order', () => {
      const times = patterns.map((p) => p.startTime);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('keeps each day separate', () => {
      const asians = patterns.filter((p) => p.meta.name === 'asian');
      expect(asians).toHaveLength(2);
      expect(asians[1].high).toBeCloseTo(29, 12); // day 2, hour 28 -> high 29
    });
  });

  describe('custom windows', () => {
    it('accepts a window outside the defaults', () => {
      const patterns = new KillzoneDetector({
        killzones: [['custom', 5, 7] as KillzoneWindow],
      }).detect(hourlyCandles(1));

      expect(patterns).toHaveLength(1);
      expect(patterns[0].meta.name).toBe('custom');
      expect(patterns[0].meta.candle_count).toBe(2); // hours 5 and 6
    });

    it('skips a window no candle falls into', () => {
      const candles = CandleSeries.fromBars(
        Array.from(
          { length: 4 },
          (_, i) => [START + (7 + i) * HOUR, 100, 101, 99, 100, 1000] as BarTuple,
        ),
      );
      expect(
        new KillzoneDetector({ killzones: [['night', 0, 6] as KillzoneWindow] }).detect(candles),
      ).toEqual([]);
    });

    it('handles a window that crosses midnight', () => {
      const patterns = new KillzoneDetector({
        killzones: [['overnight', 22, 2] as KillzoneWindow],
      }).detect(hourlyCandles(2));

      // Grouping is by UTC calendar day, and the window is evaluated per bar,
      // so a day collects hours 0, 1, 22 and 23 *of that same day* — the early
      // and late ends of one day rather than a contiguous overnight stretch.
      expect(patterns.map((p) => p.meta.candle_count)).toEqual([4, 4]);
      expect(patterns[0].startTime).toBe(START); // hour 0, not hour 22
      expect(patterns[0].endTime).toBe(START + 23 * HOUR);
    });
  });

  it('bands are defined in UTC, so only the instants matter', () => {
    // There is no "naive vs localized" index here: bars are epoch milliseconds,
    // so relabelling a series into another zone cannot change the result.
    expect(new KillzoneDetector().detect(hourlyCandles(2))).toHaveLength(8);
  });

  it('stamps the configured timeframe on every pattern', () => {
    const patterns = new KillzoneDetector({ timeframe: '1h' }).detect(hourlyCandles(1));
    expect(patterns.every((p) => p.timeframe === '1h')).toBe(true);
  });
});
