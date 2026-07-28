import { barTime, candlesFromHighsLows } from '../../test/fixtures/candles';
import { Pattern, PatternType } from '../domain/pattern';
import { SnrDetector, SnrOptions } from './snr.detector';

const detect = (highs: number[], lows: number[], options: SnrOptions = {}): Pattern[] =>
  new SnrDetector({ swingLength: 1, ...options }).detect(candlesFromHighsLows(highs, lows));

const side = (patterns: Pattern[], name: string): Pattern[] =>
  patterns.filter((p) => p.meta.side === name);

// Swing highs at i=1 and i=4, both exactly 20 -> one resistance zone.
const RES_HIGHS = [10, 20, 18, 14, 20, 16, 10];
const RES_LOWS = [7, 16, 12, 10, 16, 12, 7];

// Swing lows at i=1 and i=4, both exactly 10 -> one support zone.
const SUP_HIGHS = [20, 14, 16, 20, 14, 16, 20];
const SUP_LOWS = [15, 10, 12, 15, 10, 12, 15];

// Two swing highs at 20 and two swing lows at 8.
const BOTH_HIGHS = [12, 20, 15, 12, 18, 20, 15, 12, 18];
const BOTH_LOWS = [8, 15, 10, 8, 14, 15, 10, 8, 14];

describe('SnrDetector', () => {
  describe('edge cases', () => {
    it('needs 2 * swingLength + 1 bars', () => {
      const candles = candlesFromHighsLows([10, 20, 15], [7, 15, 10]);
      expect(new SnrDetector({ swingLength: 2 }).detect(candles)).toEqual([]);
    });

    it('drops a cluster below minTouches', () => {
      expect(detect([10, 20, 18, 14, 12, 10], [7, 16, 12, 10, 8, 6])).toEqual([]);
    });

    it('does not cluster levels beyond the tolerance', () => {
      // 20 and 21 are 5% apart, far outside the 0.2% default.
      expect(
        detect([10, 20, 18, 14, 21, 16, 10], [7, 16, 12, 10, 16, 12, 7], {
          tolerance: 0.002,
          minTouches: 2,
        }),
      ).toEqual([]);
    });
  });

  describe('resistance', () => {
    const patterns = detect(RES_HIGHS, RES_LOWS);

    it('emits one zone from the two equal swing highs', () => {
      const zones = side(patterns, 'resistance');
      expect(zones).toHaveLength(1);
      expect(zones[0].type).toBe(PatternType.Snr);
      expect(zones[0].high).toBeCloseTo(20, 12);
      expect(zones[0].low).toBeCloseTo(20, 12);
      expect(zones[0].meta.touches).toBe(2);
    });

    it('starts at the first touch', () => {
      expect(side(patterns, 'resistance')[0].startTime).toBe(barTime(1));
    });

    it('is intact while no candle closes above it', () => {
      const zone = side(patterns, 'resistance')[0];
      expect(zone.endTime).toBeNull();
      expect(zone.meta.broken).toBe(false);
    });

    it('breaks on a close above the zone', () => {
      // Bar 7: high 22, low 21 -> close 21.5 > 20.
      const zone = side(
        detect([10, 20, 18, 14, 20, 16, 10, 22], [7, 16, 12, 10, 16, 12, 7, 21]),
        'resistance',
      )[0];
      expect(zone.meta.broken).toBe(true);
      expect(zone.endTime).toBe(barTime(7));
    });

    it('is not broken by a wick alone', () => {
      // Bar 7: high 21 pierces the zone, but close = (21 + 18) / 2 = 19.5.
      const zone = side(
        detect([10, 20, 18, 14, 20, 16, 10, 21], [7, 16, 12, 10, 16, 12, 7, 18]),
        'resistance',
      )[0];
      expect(zone.meta.broken).toBe(false);
      expect(zone.endTime).toBeNull();
    });
  });

  describe('support', () => {
    const patterns = detect(SUP_HIGHS, SUP_LOWS);

    it('emits one zone from the two equal swing lows', () => {
      const zones = side(patterns, 'support');
      expect(zones).toHaveLength(1);
      expect(zones[0].high).toBeCloseTo(10, 12);
      expect(zones[0].low).toBeCloseTo(10, 12);
    });

    it('is intact while no candle closes below it', () => {
      const zone = side(patterns, 'support')[0];
      expect(zone.endTime).toBeNull();
      expect(zone.meta.broken).toBe(false);
    });

    it('breaks on a close below the zone', () => {
      const zone = side(
        detect([20, 14, 16, 20, 14, 16, 20, 9], [15, 10, 12, 15, 10, 12, 15, 8]),
        'support',
      )[0];
      expect(zone.meta.broken).toBe(true);
      expect(zone.endTime).toBe(barTime(7));
    });

    it('is not broken by a close exactly on the boundary', () => {
      // Bar 7: close = (11 + 9) / 2 = 10, equal to the zone, not strictly below.
      const zone = side(
        detect([20, 14, 16, 20, 14, 16, 20, 11], [15, 10, 12, 15, 10, 12, 15, 9]),
        'support',
      )[0];
      expect(zone.meta.broken).toBe(false);
    });
  });

  describe('clustering', () => {
    const NEAR_HIGHS = [10, 20, 18, 14, 20.3, 16, 10];
    const NEAR_LOWS = [7, 16, 12, 10, 16, 12, 7];

    it('merges levels within the tolerance', () => {
      // 20.0 and 20.3 are 1.5% apart, inside a 2% tolerance.
      const zones = side(detect(NEAR_HIGHS, NEAR_LOWS, { tolerance: 0.02 }), 'resistance');
      expect(zones).toHaveLength(1);
      expect(zones[0].meta.touches).toBe(2);
    });

    it('spans the whole cluster', () => {
      const zone = side(detect(NEAR_HIGHS, NEAR_LOWS, { tolerance: 0.02 }), 'resistance')[0];
      expect(zone.high).toBeCloseTo(20.3, 12);
      expect(zone.low).toBeCloseTo(20, 12);
    });
  });

  describe('minTouches', () => {
    it('rejects a two-touch cluster when three are required', () => {
      expect(detect(RES_HIGHS, RES_LOWS, { minTouches: 3 })).toEqual([]);
    });

    it('accepts a three-touch cluster', () => {
      const zones = side(
        detect([10, 20, 18, 14, 20, 18, 14, 20, 16], [7, 16, 12, 10, 16, 12, 10, 16, 12], {
          minTouches: 3,
        }),
        'resistance',
      );
      expect(zones).toHaveLength(1);
      expect(zones[0].meta.touches).toBe(3);
    });
  });

  describe('both sides present', () => {
    const patterns = detect(BOTH_HIGHS, BOTH_LOWS);

    it('emits one zone per side', () => {
      expect(side(patterns, 'resistance')).toHaveLength(1);
      expect(side(patterns, 'support')).toHaveLength(1);
    });

    it('returns zones in chronological order', () => {
      const times = patterns.map((p) => p.startTime);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });
  });

  it('exposes the zone midpoint', () => {
    for (const zone of detect(RES_HIGHS, RES_LOWS)) {
      expect(zone.mid).toBeCloseTo((zone.high + zone.low) / 2, 12);
    }
  });

  it('stamps the configured timeframe on every zone', () => {
    expect(
      detect(RES_HIGHS, RES_LOWS, { timeframe: '4h' }).every((p) => p.timeframe === '4h'),
    ).toBe(true);
  });
});
