import { CandleSeries } from '../../domain/candle-series';
import { CandleRequest, MarketDataPort } from '../../domain/ports';
import { NdjsonCacheStore } from './ndjson-cache.store';

export interface CachedCandleRepositoryOptions {
  /** Cache namespace, e.g. the exchange id. */
  readonly source: string;
  readonly verbose?: boolean;
}

/**
 * Cache-first decorator over any `MarketDataPort`.
 *
 * In the Python code the download loop, the Parquet cache and the range
 * stitching all lived inside one `get_candles` function. Splitting them means
 * the stitching — the part with the interesting edge cases — can be tested
 * offline against a fake upstream, which keeps the "tests never touch the
 * network" convention while still covering the logic that actually breaks.
 *
 * The stitch itself is unchanged: work out which sub-ranges of the request the
 * cache does not cover (a prefix before its first bar, a suffix after its
 * last), fetch only those, and let freshly fetched bars win over cached ones
 * when timestamps collide.
 */
export class CachedCandleRepository implements MarketDataPort {
  constructor(
    private readonly upstream: MarketDataPort,
    private readonly cache: NdjsonCacheStore,
    private readonly options: CachedCandleRepositoryOptions,
  ) {}

  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    const key = {
      source: this.options.source,
      symbol: request.symbol,
      timeframe: request.timeframe,
    };
    const cached = this.cache.read(key);

    const parts: CandleSeries[] = [];
    const missing: { startMs: number; endMs: number }[] = [];

    if (cached === null || cached.isEmpty) {
      missing.push({ startMs: request.startMs, endMs: request.endMs });
    } else {
      const cacheStart = cached.firstTime as number;
      const cacheEnd = cached.lastTime as number;

      if (request.startMs < cacheStart) {
        missing.push({
          startMs: request.startMs,
          endMs: Math.min(cacheStart - 1, request.endMs),
        });
      }

      const overlap = cached.between(request.startMs, request.endMs);
      if (!overlap.isEmpty) {
        parts.push(overlap);
      }

      if (cacheEnd < request.endMs) {
        missing.push({
          startMs: Math.max(cacheEnd + 1, request.startMs),
          endMs: request.endMs,
        });
      }
    }

    const fetched: CandleSeries[] = [];
    for (const range of missing) {
      if (range.startMs > range.endMs) {
        continue;
      }
      if (this.options.verbose) {
        console.log(
          `Fetching ${request.symbol} ${request.timeframe} from ${new Date(range.startMs).toISOString()} …`,
        );
      }
      const series = await this.upstream.getCandles({
        symbol: request.symbol,
        timeframe: request.timeframe,
        startMs: range.startMs,
        endMs: range.endMs,
      });
      if (!series.isEmpty) {
        parts.push(series);
        fetched.push(series);
      }
    }

    if (fetched.length > 0) {
      const merged = CandleSeries.mergeDedupe(cached === null ? fetched : [cached, ...fetched]);
      this.cache.write(key, merged);
      if (this.options.verbose) {
        console.log(`Cache updated → ${this.cache.pathFor(key)}`);
      }
    }

    if (parts.length === 0) {
      return CandleSeries.empty();
    }
    // Cached bars were pushed first, so a re-fetched bar replaces the stored
    // one on a collision.
    return CandleSeries.mergeDedupe(parts).between(request.startMs, request.endMs);
  }
}
