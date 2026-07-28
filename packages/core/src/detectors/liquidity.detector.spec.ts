import { barTime, candlesFromHighsLows } from '../../../../test/fixtures/candles';
import { Pattern, PatternType } from '../domain/pattern';
import { LiquidityDetector } from './liquidity.detector';

const detect = (
  candles: Parameters<LiquidityDetector['detect']>[0],
  timeframe?: string,
): Pattern[] => new LiquidityDetector({ swingLength: 1, timeframe }).detect(candles);

const buySide = (patterns: Pattern[]): Pattern[] => patterns.filter((p) => p.meta.side === 'buy');
const sellSide = (patterns: Pattern[]): Pattern[] => patterns.filter((p) => p.meta.side === 'sell');

// Swing high at i=2 (20 > 15 and 20 > 14); later highs stay at or below it.
const BSL_HIGHS = [10, 15, 20, 14, 12, 12, 18];
const BSL_LOWS = [7, 12, 17, 10, 8, 8, 14];

// Swing low at i=2 (6 < 10 and 6 < 10); later lows stay at or above it.
const SSL_HIGHS = [20, 15, 10, 14, 18, 18, 12];
const SSL_LOWS = [14, 10, 6, 10, 14, 14, 8];

describe('LiquidityDetector', () => {
  describe('edge cases', () => {
    it('needs 2 * swingLength + 1 bars', () => {
      const candles = candlesFromHighsLows([10, 15, 12, 8], [7, 11, 8, 5]);
      expect(new LiquidityDetector({ swingLength: 2 }).detect(candles)).toEqual([]);
    });

    it('finds nothing in a strictly rising series', () => {
      const candles = candlesFromHighsLows([10, 12, 14, 16, 18, 20], [8, 10, 12, 14, 16, 18]);
      expect(detect(candles)).toEqual([]);
    });
  });

  describe('buy-side liquidity', () => {
    const candles = candlesFromHighsLows(BSL_HIGHS, BSL_LOWS);

    it('sits on the swing high', () => {
      const levels = buySide(detect(candles));
      expect(levels).toHaveLength(1);
      expect(levels[0].type).toBe(PatternType.Liquidity);
      expect(levels[0].high).toBeCloseTo(20, 12);
      expect(levels[0].low).toBeCloseTo(20, 12);
      expect(levels[0].startTime).toBe(barTime(2));
    });

    it('is unswept while highs stay below it', () => {
      const level = buySide(detect(candles))[0];
      expect(level.endTime).toBeNull();
      expect(level.meta.swept).toBe(false);
    });

    it('is swept by a wick, even when the candle closes back below', () => {
      // Bar 7: high 21 > 20, but close = (21 + 17) / 2 = 19 < 20.
      const swept = candlesFromHighsLows(
        [10, 15, 20, 14, 12, 12, 18, 21],
        [7, 12, 17, 10, 8, 8, 14, 17],
      );
      const level = buySide(detect(swept))[0];
      expect(level.meta.swept).toBe(true);
      expect(level.endTime).toBe(barTime(7));
      expect((21 + 17) / 2).toBeLessThan(20); // the close never mattered
    });

    it('is not swept by a high exactly equal to the level', () => {
      const candlesWithTouch = candlesFromHighsLows(
        [10, 15, 20, 14, 12, 12, 18, 20, 21],
        [7, 12, 17, 10, 8, 8, 14, 16, 17],
      );
      // Bar 7 touches 20 exactly; only bar 8 at 21 sweeps.
      expect(buySide(detect(candlesWithTouch))[0].endTime).toBe(barTime(8));
    });
  });

  describe('sell-side liquidity', () => {
    const candles = candlesFromHighsLows(SSL_HIGHS, SSL_LOWS);

    it('sits on the swing low', () => {
      const levels = sellSide(detect(candles));
      expect(levels).toHaveLength(1);
      expect(levels[0].high).toBeCloseTo(6, 12);
      expect(levels[0].low).toBeCloseTo(6, 12);
    });

    it('is unswept while lows stay above it', () => {
      const level = sellSide(detect(candles))[0];
      expect(level.endTime).toBeNull();
      expect(level.meta.swept).toBe(false);
    });

    it('is swept by a wick below the level', () => {
      const swept = candlesFromHighsLows(
        [20, 15, 10, 14, 18, 18, 12, 9],
        [14, 10, 6, 10, 14, 14, 8, 5],
      );
      const level = sellSide(detect(swept))[0];
      expect(level.meta.swept).toBe(true);
      expect(level.endTime).toBe(barTime(7));
    });

    it('is not swept by a low exactly equal to the level', () => {
      const candlesWithTouch = candlesFromHighsLows(
        [20, 15, 10, 14, 18, 18, 12, 9, 8],
        [14, 10, 6, 10, 14, 14, 8, 6, 5],
      );
      expect(sellSide(detect(candlesWithTouch))[0].endTime).toBe(barTime(8));
    });
  });

  describe('mixed series', () => {
    // Swing high at i=1 (20 > 10 and 20 > 18); swing low at i=3 (6 < 12 and 6 < 8).
    const candles = candlesFromHighsLows([10, 20, 18, 14, 16, 10, 8], [7, 15, 12, 6, 8, 5, 3]);

    it('reports both sides', () => {
      const patterns = detect(candles);
      expect(buySide(patterns).length).toBeGreaterThanOrEqual(1);
      expect(sellSide(patterns).length).toBeGreaterThanOrEqual(1);
    });

    it('returns levels in chronological order', () => {
      const times = detect(candles).map((p) => p.startTime);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });
  });

  it('emits price lines, not zones', () => {
    for (const level of detect(candlesFromHighsLows(BSL_HIGHS, BSL_LOWS))) {
      expect(level.high).toBe(level.low);
    }
  });

  it('stamps the configured timeframe on every level', () => {
    const patterns = detect(candlesFromHighsLows(BSL_HIGHS, BSL_LOWS), '1h');
    expect(patterns.every((p) => p.timeframe === '1h')).toBe(true);
  });
});
