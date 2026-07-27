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
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const [time, open, high, low, close, volume] = JSON.parse(line) as number[];
      bars.push([time, open, high, low, close, volume]);
    }
    return CandleSeries.fromBars(bars);
  }

  write(key: CacheKey, series: CandleSeries): void {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < series.length; i++) {
      lines.push(
        JSON.stringify([
          series.time[i],
          series.open[i],
          series.high[i],
          series.low[i],
          series.close[i],
          series.volume[i],
        ]),
      );
    }
    writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  }
}
