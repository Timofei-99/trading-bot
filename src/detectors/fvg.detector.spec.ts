import { barTime, candlesFromHighsLows } from '../../test/fixtures/candles';
import { PatternType } from '../domain/pattern';
import { FvgDetector } from './fvg.detector';

// Bullish 3-candle pattern:
//   C1: H=10, L=5    gap boundary (low side)  -> zone low  = 10
//   C2: H=18, L=11   impulse
//   C3: H=20, L=12   gap boundary (high side) -> zone high = 12
// Later bars keep making higher lows, so nothing ever fills the gap.
const BULL_HIGHS = [10, 18, 20, 22, 25];
const BULL_LOWS = [5, 11, 12, 13, 15];

// Bearish mirror:
//   C1: H=20, L=15 -> zone high = 15
//   C3: H=12, L=8  -> zone low  = 12
const BEAR_HIGHS = [20, 14, 12, 11, 10];
const BEAR_LOWS = [15, 10, 8, 7, 5];

describe('FvgDetector', () => {
  describe('edge cases', () => {
    it('needs at least three candles', () => {
      expect(new FvgDetector().detect(candlesFromHighsLows([10, 15], [5, 10]))).toEqual([]);
    });

    it('finds nothing while candle ranges overlap', () => {
      const candles = candlesFromHighsLows([10, 15, 13, 18, 16], [5, 8, 9, 12, 11]);
      expect(new FvgDetector().detect(candles)).toEqual([]);
    });
  });

  describe('bullish gap', () => {
    const candles = candlesFromHighsLows(BULL_HIGHS, BULL_LOWS);

    it('detects exactly one', () => {
      const bullish = new FvgDetector()
        .detect(candles)
        .filter((p) => p.meta.direction === 'bullish');
      expect(bullish).toHaveLength(1);
    });

    it('is tagged as an FVG', () => {
      expect(new FvgDetector().detect(candles)[0].type).toBe(PatternType.Fvg);
    });

    it('spans candle 1 high to candle 3 low', () => {
      const pattern = new FvgDetector().detect(candles)[0];
      expect(pattern.low).toBeCloseTo(10, 12);
      expect(pattern.high).toBeCloseTo(12, 12);
      expect(pattern.mid).toBeCloseTo(11, 12);
    });

    it('starts at candle 1 and records the impulse candle', () => {
      const pattern = new FvgDetector().detect(candles)[0];
      expect(pattern.startTime).toBe(barTime(0));
      expect(pattern.meta.impulse_time).toBe(barTime(1));
    });

    it('records the gap size', () => {
      expect(new FvgDetector().detect(candles)[0].meta.gap_size).toBeCloseTo(2, 12);
    });

    it('stays unmitigated while lows hold above the zone', () => {
      const pattern = new FvgDetector().detect(candles)[0];
      expect(pattern.endTime).toBeNull();
      expect(pattern.meta.mitigated).toBe(false);
    });

    it('is mitigated by a low touching the top of the gap', () => {
      const withPullback = candlesFromHighsLows(
        [10, 18, 20, 22, 25, 14],
        [5, 11, 12, 13, 15, 11], // bar 5 dips to 11 <= zone high 12
      );
      const pattern = new FvgDetector().detect(withPullback)[0];
      expect(pattern.meta.mitigated).toBe(true);
      expect(pattern.endTime).toBe(barTime(5));
    });

    it('cannot be mitigated before a bar exists after candle 3', () => {
      const pattern = new FvgDetector().detect(candlesFromHighsLows([10, 18, 20], [5, 11, 12]))[0];
      expect(pattern.endTime).toBeNull();
    });
  });

  describe('bearish gap', () => {
    const candles = candlesFromHighsLows(BEAR_HIGHS, BEAR_LOWS);

    it('detects exactly one', () => {
      const bearish = new FvgDetector()
        .detect(candles)
        .filter((p) => p.meta.direction === 'bearish');
      expect(bearish).toHaveLength(1);
    });

    it('spans candle 3 high to candle 1 low', () => {
      const pattern = new FvgDetector().detect(candles)[0];
      expect(pattern.low).toBeCloseTo(12, 12);
      expect(pattern.high).toBeCloseTo(15, 12);
    });

    it('stays unmitigated while highs hold below the zone', () => {
      const pattern = new FvgDetector().detect(candles)[0];
      expect(pattern.endTime).toBeNull();
      expect(pattern.meta.mitigated).toBe(false);
    });

    it('is mitigated by a high touching the bottom of the gap', () => {
      const withRally = candlesFromHighsLows(
        [20, 14, 12, 11, 10, 13],
        [15, 10, 8, 7, 5, 9], // bar 5 rallies to 13 >= zone low 12
      );
      const pattern = new FvgDetector().detect(withRally)[0];
      expect(pattern.meta.mitigated).toBe(true);
      expect(pattern.endTime).toBe(barTime(5));
    });
  });

  describe('minGap filter', () => {
    const candles = candlesFromHighsLows(BULL_HIGHS, BULL_LOWS); // gap = 2

    it('drops gaps below the threshold', () => {
      expect(new FvgDetector({ minGap: 3 }).detect(candles)).toEqual([]);
    });

    it('keeps a gap exactly at the threshold', () => {
      expect(new FvgDetector({ minGap: 2 }).detect(candles)).toHaveLength(1);
    });
  });

  it('finds several gaps in sequence', () => {
    //  i:  0   1   2   3   4   5   6
    //  H: 10  18  20  24  22  30  35
    //  L:  5  11  12  10  18  24  26
    // gap #1 at triplet (0,1,2) -> [10, 12]; gap #2 at (4,5,6) -> [22, 26].
    const candles = candlesFromHighsLows([10, 18, 20, 24, 22, 30, 35], [5, 11, 12, 10, 18, 24, 26]);
    const bullish = new FvgDetector().detect(candles).filter((p) => p.meta.direction === 'bullish');

    expect(bullish).toHaveLength(2);
    expect([bullish[0].low, bullish[0].high]).toEqual([10, 12]);
    expect([bullish[1].low, bullish[1].high]).toEqual([22, 26]);
  });

  it('stamps the configured timeframe on every pattern', () => {
    const candles = candlesFromHighsLows(BULL_HIGHS, BULL_LOWS);
    expect(new FvgDetector({ timeframe: '15m' }).detect(candles)[0].timeframe).toBe('15m');
  });
});
