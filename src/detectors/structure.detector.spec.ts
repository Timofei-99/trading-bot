import { barTime, candlesFromHighsLows } from '../../test/fixtures/candles';
import { PatternType } from '../domain/pattern';
import { StructureDetector } from './structure.detector';

const detect = (highs: number[], lows: number[], timeframe?: string) =>
  new StructureDetector({ swingLength: 1, timeframe }).detect(candlesFromHighsLows(highs, lows));

describe('StructureDetector', () => {
  describe('edge cases', () => {
    it('needs 2 * swingLength + 2 bars', () => {
      const candles = candlesFromHighsLows([10, 20, 30, 15], [8, 18, 28, 12]);
      expect(new StructureDetector({ swingLength: 2 }).detect(candles)).toEqual([]);
    });

    it('reports nothing while price oscillates inside the swings', () => {
      // Closes are the midpoints, so they stay between 6 and 19 — never
      // beyond the swing high at 20 or the swing low at 5.
      expect(detect([10, 15, 20, 12, 9, 12, 15, 12, 10], [8, 12, 18, 9, 5, 9, 12, 9, 7])).toEqual(
        [],
      );
    });
  });

  describe('first break of a series', () => {
    it('classifies a bullish break with no trend yet as CHOCH', () => {
      // Swing high at i=2 (20), confirmed from i=4. At i=6 the close is
      // (22 + 19) / 2 = 20.5, above it.
      const patterns = detect([10, 15, 20, 12, 10, 12, 22], [8, 12, 18, 9, 7, 9, 19]);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].type).toBe(PatternType.Choch);
      expect(patterns[0].meta.direction).toBe('bullish');
      expect(patterns[0].meta.broken_level).toBeCloseTo(20, 12);
      expect(patterns[0].startTime).toBe(barTime(2)); // the swing bar
      expect(patterns[0].endTime).toBe(barTime(6)); // the breaking bar
    });

    it('classifies a bearish break with no trend yet as CHOCH', () => {
      // Swing low at i=2 (18). At i=6 the close is (15 + 12) / 2 = 13.5.
      const patterns = detect([30, 25, 20, 22, 25, 20, 15], [28, 22, 18, 20, 23, 18, 12]);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].type).toBe(PatternType.Choch);
      expect(patterns[0].meta.direction).toBe('bearish');
      expect(patterns[0].meta.broken_level).toBeCloseTo(18, 12);
      expect(patterns[0].startTime).toBe(barTime(2));
      expect(patterns[0].endTime).toBe(barTime(6));
    });
  });

  describe('once a trend is established', () => {
    it('calls the next break in the same direction a bullish BOS', () => {
      const patterns = detect(
        [10, 15, 20, 12, 10, 12, 22, 23, 30, 22, 25, 35],
        [8, 12, 18, 9, 7, 9, 19, 20, 27, 19, 22, 32],
      );

      expect(patterns).toHaveLength(2);

      expect(patterns[0].type).toBe(PatternType.Choch);
      expect(patterns[0].meta.broken_level).toBeCloseTo(20, 12);
      expect(patterns[0].endTime).toBe(barTime(6));

      expect(patterns[1].type).toBe(PatternType.Bos);
      expect(patterns[1].meta.direction).toBe('bullish');
      expect(patterns[1].meta.broken_level).toBeCloseTo(30, 12);
      expect(patterns[1].startTime).toBe(barTime(8));
      expect(patterns[1].endTime).toBe(barTime(11));
    });

    it('calls the next break in the same direction a bearish BOS', () => {
      const patterns = detect(
        [30, 25, 20, 22, 25, 20, 18, 17, 14, 18, 16, 12],
        [28, 22, 18, 20, 23, 18, 15, 14, 10, 15, 13, 7],
      );

      expect(patterns).toHaveLength(2);

      expect(patterns[0].type).toBe(PatternType.Choch);
      expect(patterns[0].meta.direction).toBe('bearish');
      expect(patterns[0].meta.broken_level).toBeCloseTo(18, 12);

      expect(patterns[1].type).toBe(PatternType.Bos);
      expect(patterns[1].meta.direction).toBe('bearish');
      expect(patterns[1].meta.broken_level).toBeCloseTo(10, 12);
      expect(patterns[1].startTime).toBe(barTime(8));
    });
  });

  it('emits a price line, not a zone', () => {
    const pattern = detect([10, 15, 20, 12, 10, 12, 22], [8, 12, 18, 9, 7, 9, 19])[0];
    expect(pattern.high).toBe(pattern.low);
    expect(pattern.high).toBe(pattern.meta.broken_level);
  });

  it('stamps the configured timeframe on every pattern', () => {
    const patterns = detect([10, 15, 20, 12, 10, 12, 22], [8, 12, 18, 9, 7, 9, 19], '4h');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].timeframe).toBe('4h');
  });
});
