import type { Exchange } from 'ccxt';

import { BarTuple, CandleSeries } from '@bot/core/domain/candle-series';
import { CandleRequest, MarketDataPort } from '@bot/core/domain/ports';

/** Binance caps a single OHLCV request at this many bars. */
const BATCH_SIZE = 1000;

export interface CcxtCandleRepositoryOptions {
  readonly exchangeId?: string;
  readonly verbose?: boolean;
}

/**
 * OHLCV from any ccxt-supported exchange, over the public API — no key needed.
 *
 * The same library the Python code used, so `fetchOHLCV` has identical
 * semantics: bars are `[timestamp, open, high, low, close, volume]` with the
 * timestamp at the bar's OPEN, in epoch milliseconds.
 *
 * Pagination walks forward from `startMs`, asking for the maximum batch each
 * time and restarting one millisecond after the last bar received, stopping
 * when the exchange returns a short batch or the range is covered.
 */
export class CcxtCandleRepository implements MarketDataPort {
  readonly exchangeId: string;
  private exchange: Exchange | null = null;

  constructor(private readonly options: CcxtCandleRepositoryOptions = {}) {
    this.exchangeId = options.exchangeId ?? 'binance';
  }

  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    const exchange = this.connect();
    const parts: CandleSeries[] = [];
    let since = request.startMs;
    let total = 0;

    for (;;) {
      const raw = await exchange.fetchOHLCV(request.symbol, request.timeframe, since, BATCH_SIZE);
      if (raw.length === 0) {
        break;
      }

      const bars: BarTuple[] = [];
      for (const row of raw) {
        const time = Number(row[0]);
        if (time > request.endMs) {
          continue;
        }
        bars.push([
          time,
          Number(row[1]),
          Number(row[2]),
          Number(row[3]),
          Number(row[4]),
          Number(row[5]),
        ]);
      }
      if (bars.length === 0) {
        break;
      }

      parts.push(CandleSeries.fromBars(bars));
      total += bars.length;
      const lastTime = bars[bars.length - 1][0];

      if (this.options.verbose) {
        console.log(`  fetched ${total} bars — last: ${new Date(lastTime).toISOString()}`);
      }

      if (lastTime >= request.endMs || raw.length < BATCH_SIZE) {
        break;
      }
      since = lastTime + 1;
    }

    if (parts.length === 0) {
      return CandleSeries.empty();
    }
    return CandleSeries.mergeDedupe(parts);
  }

  private connect(): Exchange {
    if (this.exchange === null) {
      // Loaded on first use rather than at import time: ccxt drags in a large
      // ESM dependency tree, and the cache-first path — which is how the CLI
      // and the tests run — never reaches this line.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ccxt = require('ccxt') as Record<string, new () => Exchange>;

      const factory = ccxt[this.exchangeId];
      if (typeof factory !== 'function') {
        throw new Error(`Unknown ccxt exchange: ${this.exchangeId}`);
      }
      this.exchange = new factory();
    }
    return this.exchange;
  }
}
