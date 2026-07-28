import { barTime, candlesFromHighsLows } from '../../../../test/fixtures/candles';
import { Pattern, PatternType } from '../domain/pattern';
import { PremiumDiscountDetector } from './premium-discount.detector';

const detect = (highs: number[], lows: number[], timeframe?: string): Pattern[] =>
  new PremiumDiscountDetector({ swingLength: 1, timeframe }).detect(
    candlesFromHighsLows(highs, lows),
  );

const zone = (patterns: Pattern[], name: string): Pattern =>
  patterns.find((p) => p.meta.zone === name) as Pattern;

// Swing low at i=2 (80), swing high at i=5 (120) -> bullish range [80, 120].
const BULL_HIGHS = [100, 90, 85, 90, 110, 120, 110, 105];
const BULL_LOWS = [90, 82, 80, 82, 95, 112, 95, 90];

// Swing high at i=2 (120), swing low at i=5 (78) -> bearish range [78, 120].
const BEAR_HIGHS = [80, 90, 120, 110, 90, 85, 90, 100];
const BEAR_LOWS = [70, 82, 112, 82, 80, 78, 82, 90];

describe('PremiumDiscountDetector', () => {
  describe('edge cases', () => {
    it('needs 2 * swingLength + 1 bars', () => {
      const candles = candlesFromHighsLows([10, 15, 12, 8], [7, 11, 8, 5]);
      expect(new PremiumDiscountDetector({ swingLength: 2 }).detect(candles)).toEqual([]);
    });

    it('finds no range in a monotone series, which has no pivots at all', () => {
      expect(detect([20, 18, 16, 14, 12, 10], [15, 13, 11, 9, 7, 5])).toEqual([]);
      expect(detect([10, 12, 14, 16, 18, 20], [8, 10, 12, 14, 16, 18])).toEqual([]);
    });
  });

  describe('bullish range (low then high)', () => {
    const patterns = detect(BULL_HIGHS, BULL_LOWS);

    it('emits exactly one premium and one discount zone', () => {
      expect(patterns).toHaveLength(2);
      expect(patterns.every((p) => p.type === PatternType.PremiumDiscount)).toBe(true);
    });

    it('splits the range at the equilibrium', () => {
      expect(zone(patterns, 'premium').high).toBeCloseTo(120, 12);
      expect(zone(patterns, 'premium').low).toBeCloseTo(100, 12);
      expect(zone(patterns, 'discount').high).toBeCloseTo(100, 12);
      expect(zone(patterns, 'discount').low).toBeCloseTo(80, 12);
      expect(zone(patterns, 'premium').meta.equilibrium).toBeCloseTo((120 + 80) / 2, 12);
    });

    it('puts the zone midpoints at the 75% and 25% levels', () => {
      expect(zone(patterns, 'premium').mid).toBeCloseTo(110, 12);
      expect(zone(patterns, 'discount').mid).toBeCloseTo(90, 12);
    });

    it('starts both zones at the later swing, when the range completed', () => {
      expect(zone(patterns, 'premium').startTime).toBe(barTime(5));
      expect(zone(patterns, 'discount').startTime).toBe(barTime(5));
    });

    it('never expires', () => {
      expect(patterns.every((p) => p.endTime === null)).toBe(true);
    });

    it('is tagged bullish and carries the full range on both zones', () => {
      for (const pattern of patterns) {
        expect(pattern.meta.direction).toBe('bullish');
        expect(pattern.meta.range_high).toBeCloseTo(120, 12);
        expect(pattern.meta.range_low).toBeCloseTo(80, 12);
      }
    });
  });

  describe('bearish range (high then low)', () => {
    const patterns = detect(BEAR_HIGHS, BEAR_LOWS);
    const equilibrium = (120 + 78) / 2;

    it('emits two zones tagged bearish', () => {
      expect(patterns).toHaveLength(2);
      expect(patterns.every((p) => p.meta.direction === 'bearish')).toBe(true);
    });

    it('splits the range at the equilibrium', () => {
      expect(zone(patterns, 'premium').high).toBeCloseTo(120, 12);
      expect(zone(patterns, 'premium').low).toBeCloseTo(equilibrium, 12);
      expect(zone(patterns, 'discount').high).toBeCloseTo(equilibrium, 12);
      expect(zone(patterns, 'discount').low).toBeCloseTo(78, 12);
    });

    it('starts at the swing low that completed the range', () => {
      expect(patterns.every((p) => p.startTime === barTime(5))).toBe(true);
    });
  });

  describe('several ranges', () => {
    it('pairs each alternating swing into its own range', () => {
      // low@2 -> high@5 (bullish), then high@5 -> low@8 (bearish): 4 zones.
      const patterns = detect(
        [100, 90, 85, 90, 110, 120, 110, 90, 85, 90],
        [90, 82, 80, 82, 95, 112, 95, 82, 78, 82],
      );
      expect(patterns).toHaveLength(4);
      expect(new Set(patterns.map((p) => p.meta.direction))).toEqual(
        new Set(['bullish', 'bearish']),
      );
    });

    it('skips two swings of the same kind in a row', () => {
      // low@2 -> high@5 forms a range; high@5 -> high@7 does not.
      const patterns = detect(
        [100, 90, 85, 90, 110, 120, 118, 125, 110],
        [90, 82, 80, 82, 95, 112, 115, 118, 95],
      );
      expect(patterns.filter((p) => p.meta.direction === 'bullish')).toHaveLength(2);
    });

    it('returns zones in chronological order', () => {
      const times = detect(
        [100, 90, 85, 90, 110, 120, 110, 90, 85, 90],
        [90, 82, 80, 82, 95, 112, 95, 82, 78, 82],
      ).map((p) => p.startTime);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });
  });

  it('stamps the configured timeframe on every zone', () => {
    expect(detect(BULL_HIGHS, BULL_LOWS, '4h').every((p) => p.timeframe === '4h')).toBe(true);
  });
});
