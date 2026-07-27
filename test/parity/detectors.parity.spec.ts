import {
  FractalDetector,
  FvgDetector,
  InitialBalanceDetector,
  KillzoneDetector,
  LiquidityDetector,
  OrderBlockDetector,
  PremiumDiscountDetector,
  SnrDetector,
  StructureDetector,
} from '../../src/detectors';
import { KillzoneWindow } from '../../src/detectors/killzone.detector';
import { Pattern } from '../../src/domain/pattern';
import { Detector } from '../../src/domain/ports';
import { GoldenPattern, GoldenPatternFile, loadGolden, loadGoldenCandles } from '../fixtures/helpers';

/**
 * Every detector, replayed over the same bars the Python implementation saw,
 * asserted pattern-for-pattern against what Python produced.
 *
 * This is the correctness proof for Phase 3 of the migration: there is no
 * written specification for these detectors, so the previous behaviour *is*
 * the specification, captured as data by `scripts/export_golden.py`.
 */

interface IndexEntry {
  name: string;
  detector: string;
  dataset: string;
  count: number;
}

type Params = Record<string, unknown>;

const num = (params: Params, key: string): number | undefined =>
  params[key] === undefined ? undefined : Number(params[key]);

const str = (params: Params, key: string): string | undefined =>
  params[key] === undefined ? undefined : String(params[key]);

/** Rebuild the exact detector configuration the fixture was generated with. */
function buildDetector(className: string, params: Params): Detector {
  switch (className) {
    case 'FVGDetector':
      return new FvgDetector({ timeframe: str(params, 'timeframe'), minGap: num(params, 'min_gap') });

    case 'OrderBlockDetector':
      return new OrderBlockDetector({
        swingLength: num(params, 'swing_length'),
        lookback: num(params, 'lookback'),
        timeframe: str(params, 'timeframe'),
        useBody: params['use_body'] as boolean | undefined,
      });

    case 'LiquidityDetector':
      return new LiquidityDetector({
        swingLength: num(params, 'swing_length'),
        timeframe: str(params, 'timeframe'),
      });

    case 'StructureDetector':
      return new StructureDetector({
        swingLength: num(params, 'swing_length'),
        timeframe: str(params, 'timeframe'),
      });

    case 'PremiumDiscountDetector':
      return new PremiumDiscountDetector({
        swingLength: num(params, 'swing_length'),
        timeframe: str(params, 'timeframe'),
      });

    case 'SNRDetector':
      return new SnrDetector({
        swingLength: num(params, 'swing_length'),
        tolerance: num(params, 'tolerance'),
        minTouches: num(params, 'min_touches'),
        timeframe: str(params, 'timeframe'),
      });

    case 'FractalDetector':
      return new FractalDetector({ timeframe: str(params, 'timeframe') });

    case 'KillzoneDetector': {
      const zones = params['killzones'];
      return new KillzoneDetector({
        timeframe: str(params, 'timeframe'),
        killzones:
          zones === 'default' || zones === undefined
            ? undefined
            : (zones as [string, number, number][]).map(
                ([name, from, to]) => [name, from, to] as KillzoneWindow,
              ),
      });
    }

    case 'InitialBalanceDetector':
      return new InitialBalanceDetector({
        sessionStart: str(params, 'session_start'),
        sessionTz: str(params, 'session_tz'),
        durationMinutes: num(params, 'duration_minutes'),
        session: str(params, 'session'),
        timeframe: str(params, 'timeframe'),
      });

    default:
      throw new Error(`no TypeScript detector registered for ${className}`);
  }
}

function serialize(pattern: Pattern): GoldenPattern {
  return {
    type: pattern.type,
    timeframe: pattern.timeframe,
    startTime: pattern.startTime,
    endTime: pattern.endTime,
    high: pattern.high,
    low: pattern.low,
    meta: pattern.meta,
  };
}

const index = loadGolden<IndexEntry[]>('detectors', 'index.json');

describe('detector parity with the Python implementation', () => {
  it('covers every fixture the exporter produced', () => {
    // 28 configurations across all 9 detectors: every one on its default
    // parameters plus at least one non-default set, on 5 datasets.
    expect(index.length).toBe(28);
    expect(new Set(index.map((entry) => entry.detector)).size).toBe(9);
    expect(index.every((entry) => entry.count > 0)).toBe(true);
  });

  describe.each(index.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const fixture = loadGolden<GoldenPatternFile>('detectors', `${entry.name}.json`);
    const candles = loadGoldenCandles(fixture.dataset);
    const detector = buildDetector(fixture.detector, fixture.params);
    const actual = detector.detect(candles).map(serialize);

    it(`produces ${fixture.count} patterns`, () => {
      expect(actual.length).toBe(fixture.count);
    });

    it('matches every field of every pattern', () => {
      for (let i = 0; i < fixture.patterns.length; i++) {
        // Named so a failure points at the offending pattern immediately.
        expect({ index: i, ...actual[i] }).toEqual({ index: i, ...fixture.patterns[i] });
      }
    });

    it('matches exactly, including float bit patterns', () => {
      // toEqual compares numbers with Object.is, so this is exact equality
      // rather than an epsilon — no silent drift in zone boundaries.
      expect(actual).toEqual(fixture.patterns);
    });
  });
});
