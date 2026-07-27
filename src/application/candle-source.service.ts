import { Injectable } from '@nestjs/common';

import { CandleSeries } from '../domain/candle-series';
import { CachedCandleRepository } from '../infrastructure/market-data/cached-candle.repository';
import { CcxtCandleRepository } from '../infrastructure/market-data/ccxt-candle.repository';
import { loadMt5Csv } from '../infrastructure/market-data/mt5-csv.loader';
import { NdjsonCacheStore } from '../infrastructure/market-data/ndjson-cache.store';
import { YahooCandleRepository } from '../infrastructure/market-data/yahoo-candle.repository';
import { BacktestDataRequest } from './backtest-runner.service';

export interface CandleSourceOptions {
  readonly cacheDir?: string;
  readonly verbose?: boolean;
}

/**
 * Picks the repository behind a `source` name and hands back candles.
 *
 * This is the anti-corruption boundary: everything downstream sees a
 * `CandleSeries`, never a ccxt response, a Yahoo quote or a broker CSV row.
 */
@Injectable()
export class CandleSourceService {
  private readonly cache: NdjsonCacheStore;

  constructor(private readonly options: CandleSourceOptions = {}) {
    this.cache = new NdjsonCacheStore(options.cacheDir ?? 'data/cache');
  }

  async load(request: BacktestDataRequest, timeframe: string): Promise<CandleSeries> {
    switch (request.source) {
      case 'binance': {
        const repository = new CachedCandleRepository(
          new CcxtCandleRepository({ exchangeId: 'binance', verbose: this.options.verbose }),
          this.cache,
          { source: 'binance', verbose: this.options.verbose },
        );
        return repository.getCandles({
          symbol: request.symbol,
          timeframe,
          startMs: request.startMs,
          endMs: request.endMs,
        });
      }

      case 'yahoo': {
        const repository = new YahooCandleRepository({ verbose: this.options.verbose });
        return repository.getCandles({
          symbol: request.symbol,
          timeframe,
          startMs: request.startMs,
          endMs: request.endMs,
        });
      }

      case 'mt5': {
        if (request.csvPath === undefined) {
          throw new Error('An MT5 backtest needs csvPath');
        }
        const { series } = loadMt5Csv(request.csvPath, { sourceTz: request.sourceTz });
        return series.between(request.startMs, request.endMs);
      }

      default:
        throw new Error(`Unknown data source: ${String(request.source)}`);
    }
  }
}
