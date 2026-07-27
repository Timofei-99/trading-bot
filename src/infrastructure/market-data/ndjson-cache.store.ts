import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BarTuple, CandleSeries } from '../../domain/candle-series';

export interface CacheKey {
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
}

/**
 * On-disk candle cache, one newline-delimited JSON array per bar.
 *
 * The Python version used Parquet. NDJSON replaces it because the maintained
 * Parquet bindings for Node are heavyweight and the one property that matters
 * here — exact round-tripping of IEEE-754 doubles — is something JSON already
 * guarantees: both `JSON.stringify` and Python's `repr` emit the shortest
 * decimal that reads back to the same bits.
 *
 * Appending is also cheap and the file stays greppable, which a binary
 * columnar format is not.
 */
export class NdjsonCacheStore {
  constructor(readonly cacheDir: string) {}

  pathFor(key: CacheKey): string {
    const safeSymbol = key.symbol.replace(/\//g, '_');
    return join(this.cacheDir, `${key.source}_${safeSymbol}_${key.timeframe}.ndjson`);
  }

  has(key: CacheKey): boolean {
    return existsSync(this.pathFor(key));
  }

  read(key: CacheKey): CandleSeries | null {
    const path = this.pathFor(key);
    if (!existsSync(path)) {
      return null;
    }

    const bars: BarTuple[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      if (line.trim() === '') {
        continue;
      }
      const values = JSON.parse(line) as unknown[];
      if (values.length !== 6) {
        throw new Error(
          `Corrupt cache line ${lineNumber + 1} in ${path}: expected 6 values, got ${values.length}`,
        );
      }
      const bar = values.map((value, field) =>
        assertFinite(value, `${path}:${lineNumber + 1}`, FIELDS[field]),
      ) as unknown as BarTuple;
      bars.push(bar);
    }
    return CandleSeries.fromBars(bars);
  }

  write(key: CacheKey, series: CandleSeries): void {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const bar: BarTuple = [
        series.time[i],
        series.open[i],
        series.high[i],
        series.low[i],
        series.close[i],
        series.volume[i],
      ];
      bar.forEach((value, field) => assertFinite(value, `bar ${i}`, FIELDS[field]));
      lines.push(JSON.stringify(bar));
    }
    writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  }
}

const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

/**
 * Refuse anything JSON cannot represent.
 *
 * `JSON.stringify(NaN)` is the string `null`, which reads back as a zero once
 * it reaches a `Float64Array`. A price of zero passes straight through every
 * stop-loss check and silently rewrites a backtest's statistics, so a bad
 * value from a feed has to stop here rather than be persisted.
 */
function assertFinite(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Refusing a non-finite ${field} at ${where}: ${String(value)}. ` +
        'JSON cannot round-trip NaN or Infinity, and a silent zero here would corrupt every run that reads this cache.',
    );
  }
  return value;
}
