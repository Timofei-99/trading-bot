import YahooFinance from 'yahoo-finance2';

import { BarTuple, CandleSeries } from '../../domain/candle-series';
import { CandleRequest, MarketDataPort } from '../../domain/ports';

/**
 * Timeframe to Yahoo interval, with how far back each one is served.
 *
 * The Python map also listed `"4h" -> "4h"`, which Yahoo does not offer; the
 * request simply failed. It is dropped here rather than carried over.
 */
/** The interval strings Yahoo's chart endpoint accepts. */
type YahooInterval =
  '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m' | '1h' | '1d' | '5d' | '1wk' | '1mo' | '3mo';

const INTERVALS: Readonly<Record<string, { interval: YahooInterval; maxDays: number }>> = {
  '1m': { interval: '1m', maxDays: 7 },
  '2m': { interval: '2m', maxDays: 60 },
  '5m': { interval: '5m', maxDays: 60 },
  '15m': { interval: '15m', maxDays: 60 },
  '30m': { interval: '30m', maxDays: 60 },
  '1h': { interval: '1h', maxDays: 730 },
  '1d': { interval: '1d', maxDays: 100_000 },
  '1wk': { interval: '1wk', maxDays: 100_000 },
};

export interface YahooCandleRepositoryOptions {
  readonly verbose?: boolean;
}

/** Chart data from Yahoo Finance — forex, indices and futures. */
export class YahooCandleRepository implements MarketDataPort {
  private client: InstanceType<typeof YahooFinance> | null = null;

  constructor(private readonly options: YahooCandleRepositoryOptions = {}) {}

  static supports(timeframe: string): boolean {
    return timeframe in INTERVALS;
  }

  static maxLookbackDays(timeframe: string): number {
    const spec = INTERVALS[timeframe];
    if (spec === undefined) {
      throw new Error(`Unsupported timeframe for Yahoo Finance: ${timeframe}`);
    }
    return spec.maxDays;
  }

  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    const spec = INTERVALS[request.timeframe];
    if (spec === undefined) {
      throw new Error(`Unsupported timeframe for Yahoo Finance: ${request.timeframe}`);
    }

    const result = await this.connect().chart(request.symbol, {
      period1: new Date(request.startMs),
      period2: new Date(request.endMs),
      interval: spec.interval,
    });

    const bars: BarTuple[] = [];
    for (const quote of result.quotes) {
      const time = quote.date.getTime();
      if (
        time < request.startMs ||
        time > request.endMs ||
        quote.open === null ||
        quote.high === null ||
        quote.low === null ||
        quote.close === null
      ) {
        continue;
      }
      bars.push([time, quote.open, quote.high, quote.low, quote.close, quote.volume ?? 0]);
    }

    if (this.options.verbose) {
      console.log(`  ${request.symbol} ${request.timeframe}: ${bars.length} bars`);
    }
    return CandleSeries.mergeDedupe([CandleSeries.fromBars(bars)]);
  }

  private connect(): InstanceType<typeof YahooFinance> {
    if (this.client === null) {
      this.client = new YahooFinance();
    }
    return this.client;
  }
}
