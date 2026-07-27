import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BarTuple, CandleSeries } from '../src/domain/candle-series';
import { NdjsonCacheStore } from '../src/infrastructure/market-data/ndjson-cache.store';

/**
 * Fill the candle cache from the committed golden fixtures.
 *
 * Lets `npm run cli -- backtest:ob4h` run without touching the network, which
 * is what makes the CLI's output comparable against the golden report on any
 * machine, including CI.
 */

interface GoldenCandles {
  symbol: string;
  timeframe: string;
  bars: BarTuple[];
}

const GOLDEN = join(__dirname, '..', 'test', 'fixtures', 'golden', 'candles');
const DATASETS = [
  { file: 'btc_4h.json', source: 'binance' },
  { file: 'btc_15m.json', source: 'binance' },
];

function main(): void {
  const store = new NdjsonCacheStore(join('data', 'cache'));

  for (const dataset of DATASETS) {
    const payload = JSON.parse(readFileSync(join(GOLDEN, dataset.file), 'utf8')) as GoldenCandles;
    const series = CandleSeries.fromBars(payload.bars);
    const key = { source: dataset.source, symbol: payload.symbol, timeframe: payload.timeframe };

    store.write(key, series);
    console.log(`seeded ${series.length} bars → ${store.pathFor(key)}`);
  }
}

main();
