import { readFileSync } from 'node:fs';

import { parseMt5Csv } from '../../src/infrastructure/market-data/mt5-csv.loader';
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

});
