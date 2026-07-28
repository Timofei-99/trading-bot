import { barTime, candlesFromHighsLows } from '../../../../test/fixtures/candles';
import { Pattern, PatternType } from '../domain/pattern';
import { FractalDetector } from './fractal.detector';

/**
 * The Python implementation shipped without a test file for this detector —
 * `detectors/fractals.py` was only ever exercised indirectly through
 * `H1m3mClassicStrategy`. These cases are new, written against the documented
 * behaviour and cross-checked by `detectors.parity.spec.ts`.
 */

const detect = (highs: number[], lows: number[], timeframe?: string): Pattern[] =>
  new FractalDetector({ timeframe }).detect(candlesFromHighsLows(highs, lows));

const ofType = (patterns: Pattern[], kind: string): Pattern[] =>
  patterns.filter((p) => p.meta.fractal_type === kind);

describe('FractalDetector', () => {
  it('needs at least three candles', () => {
    expect(detect([10, 12], [8, 9])).toEqual([]);
  });

  it('finds a fractal high and confirms it on the next bar', () => {
    const patterns = ofType(detect([10, 20, 15], [8, 14, 12]), 'high');

    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe(PatternType.Fractal);
    expect(patterns[0].high).toBe(20);
    expect(patterns[0].low).toBe(20); // a level, not a zone
    expect(patterns[0].meta.level).toBe(20);
    expect(patterns[0].startTime).toBe(barTime(1)); // the fractal bar
    expect(patterns[0].endTime).toBe(barTime(2)); // the confirming bar
  });

  it('finds a fractal low', () => {
    const patterns = ofType(detect([20, 14, 18], [15, 8, 12]), 'low');

    expect(patterns).toHaveLength(1);
    expect(patterns[0].high).toBe(8);
    expect(patterns[0].low).toBe(8);
    expect(patterns[0].startTime).toBe(barTime(1));
    expect(patterns[0].endTime).toBe(barTime(2));
  });

  it('requires a strict extreme on both sides', () => {
    // Equal neighbour on the right disqualifies the middle bar.
    expect(ofType(detect([10, 20, 20], [8, 14, 14]), 'high')).toEqual([]);
    // Equal neighbour on the left, likewise.
    expect(ofType(detect([20, 20, 15], [14, 14, 12]), 'high')).toEqual([]);
  });

  it('can report a high and a low on the same outside bar', () => {
    // Bar 1 has both the highest high and the lowest low of the triplet.
    const patterns = detect([10, 25, 12], [8, 3, 7]);

    expect(patterns).toHaveLength(2);
    expect(patterns[0].meta.fractal_type).toBe('high');
    expect(patterns[1].meta.fractal_type).toBe('low');
    expect(patterns[0].startTime).toBe(patterns[1].startTime);
  });

  it('never confirms a fractal on the last two bars', () => {
    // Bar 3 is the highest bar of the series, but nothing has closed after it,
    // so it cannot be confirmed — this is what keeps a rolling window honest.
    const patterns = detect([10, 20, 15, 30], [8, 14, 12, 25]);

    // Bar 1 is a fractal high, bar 2 a fractal low; bar 3 is neither yet.
    expect(patterns.map((p) => [p.meta.fractal_type, p.startTime])).toEqual([
      ['high', barTime(1)],
      ['low', barTime(2)],
    ]);
    expect(patterns.every((p) => p.startTime < barTime(3))).toBe(true);
  });

  it('finds every fractal in a zig-zag, in bar order', () => {
    const patterns = detect([10, 20, 12, 22, 11, 24], [8, 15, 6, 17, 5, 19]);
    const times = patterns.map((p) => p.startTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(ofType(patterns, 'high').map((p) => p.high)).toEqual([20, 22]);
    expect(ofType(patterns, 'low').map((p) => p.low)).toEqual([6, 5]);
  });

  it('finds nothing in a monotone series', () => {
    expect(detect([10, 12, 14, 16, 18], [8, 10, 12, 14, 16])).toEqual([]);
  });

  it('stamps the configured timeframe on every fractal', () => {
    expect(detect([10, 20, 15], [8, 14, 12], '1h').every((p) => p.timeframe === '1h')).toBe(true);
  });
});
