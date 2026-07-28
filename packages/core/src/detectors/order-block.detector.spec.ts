import { barTime, candlesFromOhlc, OhlcRow } from '../../../../test/fixtures/candles';
import { Pattern, PatternType } from '../domain/pattern';
import { OrderBlockDetector } from './order-block.detector';

function rows(opens: number[], highs: number[], lows: number[], closes: number[]): OhlcRow[] {
  return opens.map((open, i) => ({ open, high: highs[i], low: lows[i], close: closes[i] }));
}

const bullish = (patterns: Pattern[]): Pattern[] =>
  patterns.filter((p) => p.meta.direction === 'bullish');
const bearish = (patterns: Pattern[]): Pattern[] =>
  patterns.filter((p) => p.meta.direction === 'bearish');

// Down-leg into a swing low at i=3, then a clean recovery.
//   directions: i=0..2 bearish, i=3..8 bullish
//   swing low at i=3 (87 < 88 and 87 < 94)
//   last bearish candle at or before it: i=2 (close 89 < open 93)
//   zone = body of i=2 -> [89, 93]; recovery lows never come back to 93
const BULL = rows(
  [100, 97, 93, 89, 94, 98, 102, 106, 110],
  [101, 98, 94, 93, 98, 102, 106, 110, 114],
  [96, 92, 88, 87, 94, 98, 102, 106, 110],
  [97, 93, 89, 92, 97, 101, 105, 109, 113],
);

// Up-leg into a swing high at i=3, then a clean sell-off.
//   swing high at i=3 (113 > 112 and 113 > 107)
//   last bullish candle at or before it: i=2 (close 111 > open 107)
//   zone = body of i=2 -> [107, 111]
const BEAR = rows(
  [100, 103, 107, 111, 106, 100, 94, 88, 82],
  [104, 108, 112, 113, 107, 101, 95, 89, 83],
  [99, 102, 106, 106, 99, 93, 87, 81, 75],
  [103, 107, 111, 107, 100, 94, 88, 82, 76],
);

describe('OrderBlockDetector', () => {
  describe('edge cases', () => {
    it('needs 2 * swingLength + 1 bars', () => {
      const candles = candlesFromOhlc(
        rows([10, 9, 8, 7], [11, 10, 9, 8], [9, 8, 7, 6], [9, 8, 7, 8]),
      );
      expect(new OrderBlockDetector({ swingLength: 2 }).detect(candles)).toEqual([]);
    });

    it('finds no bullish block when every candle into the swing low is bullish', () => {
      const candles = candlesFromOhlc(
        rows(
          [88, 89, 88, 86, 91, 95],
          [92, 93, 92, 91, 95, 99],
          [87, 88, 87, 85, 90, 94],
          [91, 92, 91, 89, 94, 98],
        ),
      );
      const patterns = new OrderBlockDetector({ swingLength: 1, lookback: 3 }).detect(candles);
      expect(bullish(patterns)).toEqual([]);
    });
  });

  describe('bullish order block', () => {
    const candles = candlesFromOhlc(BULL);
    const detect = (): Pattern[] => new OrderBlockDetector({ swingLength: 1 }).detect(candles);

    it('finds exactly one at the swing low', () => {
      expect(
        bullish(new OrderBlockDetector({ swingLength: 1, lookback: 5 }).detect(candles)),
      ).toHaveLength(1);
    });

    it('is tagged as an order block', () => {
      expect(detect()[0].type).toBe(PatternType.OrderBlock);
    });

    it('uses the body of the last bearish candle as the zone', () => {
      const pattern = detect()[0];
      expect(pattern.high).toBeCloseTo(93, 12);
      expect(pattern.low).toBeCloseTo(89, 12);
    });

    it('starts at the order-block candle, not the swing', () => {
      const pattern = detect()[0];
      expect(pattern.startTime).toBe(barTime(2));
      expect(pattern.meta.swing_time).toBe(barTime(3));
    });

    it('stays unmitigated while price never returns', () => {
      const pattern = detect()[0];
      expect(pattern.endTime).toBeNull();
      expect(pattern.meta.mitigated).toBe(false);
    });

    it('is mitigated once price departs and then pulls back in', () => {
      // Close at i=6 is 105 > zone high 93 (departure), low at i=7 is 91 <= 93.
      const withPullback = candlesFromOhlc(
        rows(
          [100, 97, 93, 89, 94, 98, 102, 97, 93],
          [101, 98, 94, 93, 98, 102, 107, 100, 96],
          [96, 92, 88, 87, 94, 98, 102, 91, 88],
          [97, 93, 89, 92, 97, 101, 105, 94, 90],
        ),
      );
      const pattern = new OrderBlockDetector({ swingLength: 1 }).detect(withPullback)[0];
      expect(pattern.meta.mitigated).toBe(true);
      expect(pattern.endTime).toBe(barTime(7));
    });
  });

  describe('bearish order block', () => {
    const candles = candlesFromOhlc(BEAR);
    const detect = (): Pattern[] =>
      bearish(new OrderBlockDetector({ swingLength: 1 }).detect(candles));

    it('finds exactly one at the swing high', () => {
      expect(detect()).toHaveLength(1);
    });

    it('uses the body of the last bullish candle as the zone', () => {
      const pattern = detect()[0];
      expect(pattern.high).toBeCloseTo(111, 12);
      expect(pattern.low).toBeCloseTo(107, 12);
    });

    it('starts at the order-block candle', () => {
      expect(detect()[0].startTime).toBe(barTime(2));
    });

    it('stays unmitigated while highs stay below the zone', () => {
      const pattern = detect()[0];
      expect(pattern.endTime).toBeNull();
      expect(pattern.meta.mitigated).toBe(false);
    });

    it('is mitigated once price closes below and rallies back in', () => {
      // Close at i=4 is 100 < zone low 107 (departure), high at i=7 is 109 >= 107.
      const withRally = candlesFromOhlc(
        rows(
          [100, 103, 107, 111, 98, 94, 96, 104, 108],
          [104, 108, 112, 113, 101, 97, 100, 109, 112],
          [99, 102, 106, 106, 94, 90, 93, 102, 106],
          [103, 107, 111, 107, 100, 94, 98, 108, 111],
        ),
      );
      const pattern = bearish(new OrderBlockDetector({ swingLength: 1 }).detect(withRally))[0];
      expect(pattern.meta.mitigated).toBe(true);
      expect(pattern.endTime).toBe(barTime(7));
    });
  });

  describe('lookback and zone options', () => {
    // The swing-low bar at i=3 is itself bearish (close 86 < open 95), so it is
    // the last bearish candle and becomes the block.
    const candles = candlesFromOhlc(
      rows(
        [100, 97, 93, 95, 98, 102],
        [101, 98, 94, 96, 99, 103],
        [96, 92, 88, 84, 94, 98],
        [97, 93, 89, 86, 97, 101],
      ),
    );

    it('lets the swing candle itself be the order block', () => {
      const patterns = bullish(
        new OrderBlockDetector({ swingLength: 1, lookback: 5 }).detect(candles),
      );
      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const pattern = patterns[patterns.length - 1];
      expect(pattern.high).toBeCloseTo(95, 12); // open of i=3
      expect(pattern.low).toBeCloseTo(86, 12); // close of i=3
    });

    it('searches only the swing candle at lookback 0', () => {
      const patterns = bullish(
        new OrderBlockDetector({ swingLength: 1, lookback: 0 }).detect(candles),
      );
      expect(patterns).toHaveLength(1);
      expect(patterns[0].startTime).toBe(barTime(3));
    });

    it('takes the full candle range when useBody is off', () => {
      const pattern = new OrderBlockDetector({ swingLength: 1, useBody: false }).detect(
        candlesFromOhlc(BULL),
      )[0];
      expect(pattern.high).toBeCloseTo(94, 12); // high of i=2
      expect(pattern.low).toBeCloseTo(88, 12); // low of i=2
    });
  });

  it('stamps the configured timeframe on every pattern', () => {
    const pattern = new OrderBlockDetector({ swingLength: 1, timeframe: '4h' }).detect(
      candlesFromOhlc(BULL),
    )[0];
    expect(pattern.timeframe).toBe('4h');
  });
});
