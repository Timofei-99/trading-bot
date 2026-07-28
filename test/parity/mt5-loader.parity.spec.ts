import { readFileSync } from 'node:fs';

import { parseMt5Csv } from '@bot/infra/market-data/mt5-csv.loader';
import { goldenPath, loadGolden } from '../fixtures/helpers';

interface Mt5Expected {
  sourceTz: string;
  sep: string;
  inputRows: number;
  outputRows: number;
  natRows: number;
  rows: {
    timestamp: number | null;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
}

/**
 * The MT5 loader against the row-for-row output of `load_mt5_csv`.
 *
 * The sample CSV is written to cover the daylight-saving edges that a broker
 * export actually hits: bars inside the spring-forward gap, bars inside the
 * repeated fall-back hour, an out-of-order row and a duplicated timestamp.
 */
describe('MT5 loader parity with the Python implementation', () => {
  const expected = loadGolden<Mt5Expected>('mt5', 'fdax_dst_expected.json');
  const csv = readFileSync(goldenPath('mt5', 'fdax_dst_sample.csv'), 'utf8');
  const result = parseMt5Csv(csv, { sourceTz: expected.sourceTz });

  it('collapses the same rows the original did', () => {
    expect(result.rows).toHaveLength(expected.outputRows);
    expect(expected.inputRows).toBeGreaterThan(expected.outputRows);
  });

  it('reproduces every row, field for field', () => {
    expect(result.rows).toEqual(expected.rows);
  });

  it('keeps ambiguous bars without a timestamp, sorted last', () => {
    expect(result.ambiguousRows).toBe(expected.natRows);

    const timestamps = result.rows.map((row) => row.timestamp);
    const firstNull = timestamps.indexOf(null);
    expect(firstNull).toBeGreaterThanOrEqual(0);
    expect(timestamps.slice(firstNull).every((t) => t === null)).toBe(true);
  });

  it('shifts nonexistent wall times forward, letting a real bar win the collision', () => {
    // 2024-03-31 02:00 and 02:30 Berlin do not exist; both land on 03:00 local
    // (01:00 UTC), where a genuine 03:00 row already sits.
    const gapEnd = result.rows.filter((row) => row.timestamp === Date.UTC(2024, 2, 31, 1, 0));
    expect(gapEnd).toHaveLength(1);
    expect(gapEnd[0].open).toBe(18107); // the real 03:00 bar, not a shifted one
  });

  it('sorts an out-of-order export and keeps the last of a duplicate', () => {
    const timed = result.rows.filter((row) => row.timestamp !== null);
    const times = timed.map((row) => row.timestamp as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const duplicated = timed.filter((row) => row.timestamp === Date.UTC(2024, 5, 3, 6, 0));
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0].open).toBe(18501); // the second of the two rows
  });

  it('exposes a replayable series without the untimed bar', () => {
    expect(result.series.length).toBe(result.rows.length - expected.natRows);
    const times = Array.from(result.series.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  describe('ambiguousPolicy', () => {
    it('defaults to the behaviour the fixture records', () => {
      const explicit = parseMt5Csv(csv, {
        sourceTz: expected.sourceTz,
        ambiguousPolicy: 'drop',
      });
      expect(explicit.rows).toEqual(expected.rows);
    });

    it('keeps the bar when asked to pick an occurrence', () => {
      for (const policy of ['earlier', 'later'] as const) {
        const kept = parseMt5Csv(csv, { sourceTz: expected.sourceTz, ambiguousPolicy: policy });

        expect(kept.ambiguousRows).toBe(expected.natRows);
        expect(kept.rows.every((row) => row.timestamp !== null)).toBe(true);
        expect(kept.series.length).toBe(kept.rows.length);
      }
    });

    it('places the two occurrences an hour apart', () => {
      const earlier = parseMt5Csv(csv, { sourceTz: expected.sourceTz, ambiguousPolicy: 'earlier' });
      const later = parseMt5Csv(csv, { sourceTz: expected.sourceTz, ambiguousPolicy: 'later' });

      // The 02:30 bar on 2024-10-27: 00:30 UTC while still CEST, 01:30 after.
      const findByOpen = (rows: { timestamp: number | null; open: number }[]): number =>
        rows.find((row) => row.open === 19002)?.timestamp as number;

      expect(findByOpen(later.rows) - findByOpen(earlier.rows)).toBe(3_600_000);
    });

    it('refuses the file outright when told to', () => {
      expect(() =>
        parseMt5Csv(csv, { sourceTz: expected.sourceTz, ambiguousPolicy: 'throw' }),
      ).toThrow(/occurs twice in Europe\/Berlin/);
    });
  });
});
