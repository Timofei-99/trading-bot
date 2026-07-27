import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BarTuple, CandleSeries } from '../../domain/candle-series';
import { CandleRequest, MarketDataPort } from '../../domain/ports';
import { CachedCandleRepository } from './cached-candle.repository';
import { NdjsonCacheStore } from './ndjson-cache.store';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

const at = (hour: number): number => T0 + hour * HOUR;

function bars(fromHour: number, toHour: number, offset = 0): CandleSeries {
  const rows: BarTuple[] = [];
  for (let h = fromHour; h <= toHour; h++) {
    rows.push([at(h), h + offset, h + offset, h + offset, h + offset, 100]);
  }
  return CandleSeries.fromBars(rows);
}

/** Records what it was asked for, so the stitching can be inspected. */
class FakeUpstream implements MarketDataPort {
  readonly requests: CandleRequest[] = [];

  constructor(private readonly respond: (request: CandleRequest) => CandleSeries) {}

  async getCandles(request: CandleRequest): Promise<CandleSeries> {
    this.requests.push(request);
    return this.respond(request);
  }
}

describe('CachedCandleRepository', () => {
  let cacheDir: string;
  let store: NdjsonCacheStore;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'candle-cache-'));
    store = new NdjsonCacheStore(cacheDir);
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const repo = (upstream: MarketDataPort): CachedCandleRepository =>
    new CachedCandleRepository(upstream, store, { source: 'binance' });

  const request = (fromHour: number, toHour: number): CandleRequest => ({
    symbol: 'BTC/USDT',
    timeframe: '1h',
    startMs: at(fromHour),
    endMs: at(toHour),
  });

  it('fetches the whole range on a cold cache and stores it', async () => {
    const upstream = new FakeUpstream(() => bars(0, 10));
    const series = await repo(upstream).getCandles(request(0, 10));

    expect(series.length).toBe(11);
    expect(upstream.requests).toHaveLength(1);
    expect(store.read({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' })?.length).toBe(11);
  });

  it('serves a fully covered range without touching upstream', async () => {
    store.write({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' }, bars(0, 10));
    const upstream = new FakeUpstream(() => CandleSeries.empty());

    const series = await repo(upstream).getCandles(request(2, 5));

    expect(upstream.requests).toHaveLength(0);
    expect(Array.from(series.time)).toEqual([at(2), at(3), at(4), at(5)]);
  });

  it('fetches only the missing prefix', async () => {
    store.write({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' }, bars(5, 10));
    const upstream = new FakeUpstream(() => bars(0, 4));

    const series = await repo(upstream).getCandles(request(0, 10));

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].startMs).toBe(at(0));
    // One millisecond before the first cached bar, so the ranges never overlap.
    expect(upstream.requests[0].endMs).toBe(at(5) - 1);
    expect(series.length).toBe(11);
  });

  it('fetches only the missing suffix', async () => {
    store.write({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' }, bars(0, 5));
    const upstream = new FakeUpstream(() => bars(6, 10));

    const series = await repo(upstream).getCandles(request(0, 10));

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].startMs).toBe(at(5) + 1);
    expect(upstream.requests[0].endMs).toBe(at(10));
    expect(series.length).toBe(11);
  });

  it('fetches both ends when the cache sits in the middle', async () => {
    store.write({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' }, bars(4, 6));
    const upstream = new FakeUpstream((r) =>
      r.startMs < at(4) ? bars(0, 3) : bars(7, 10),
    );

    const series = await repo(upstream).getCandles(request(0, 10));

    expect(upstream.requests).toHaveLength(2);
    expect(series.length).toBe(11);
    expect(Array.from(series.time)).toEqual(
      Array.from({ length: 11 }, (_, h) => at(h)),
    );
  });

  it('lets a re-fetched bar replace the cached one', async () => {
    store.write({ source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' }, bars(0, 5));
    // The suffix fetch overlaps bar 5 and returns a different price for it.
    const upstream = new FakeUpstream(() => bars(5, 8, 1000));

    const series = await repo(upstream).getCandles(request(0, 8));

    const index = Array.from(series.time).indexOf(at(5));
    expect(series.close[index]).toBe(5 + 1000);
  });

  it('keeps the cache growing across calls', async () => {
    const key = { source: 'binance', symbol: 'BTC/USDT', timeframe: '1h' };
    const upstream = new FakeUpstream((r) => (r.startMs === at(0) ? bars(0, 5) : bars(6, 10)));
    const repository = repo(upstream);

    await repository.getCandles(request(0, 5));
    await repository.getCandles(request(0, 10));

    expect(store.read(key)?.length).toBe(11);
  });

  it('returns nothing when neither cache nor upstream has data', async () => {
    const upstream = new FakeUpstream(() => CandleSeries.empty());
    const series = await repo(upstream).getCandles(request(0, 10));

    expect(series.isEmpty).toBe(true);
  });

  it('trims the answer to the requested range', async () => {
    const upstream = new FakeUpstream(() => bars(0, 20));
    const series = await repo(upstream).getCandles(request(3, 6));

    expect(Array.from(series.time)).toEqual([at(3), at(4), at(5), at(6)]);
  });
});

describe('NdjsonCacheStore', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'ndjson-cache-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const key = { source: 'binance', symbol: 'BTC/USDT', timeframe: '15m' };

  it('names files without the symbol separator', () => {
    const store = new NdjsonCacheStore(cacheDir);
    expect(store.pathFor(key)).toBe(join(cacheDir, 'binance_BTC_USDT_15m.ndjson'));
  });

  it('reports a miss for an unknown key', () => {
    const store = new NdjsonCacheStore(cacheDir);
    expect(store.has(key)).toBe(false);
    expect(store.read(key)).toBeNull();
  });

  it('round-trips awkward doubles without losing a bit', () => {
    const store = new NdjsonCacheStore(cacheDir);
    const original = CandleSeries.fromBars([
      [T0, 0.1 + 0.2, 1 / 3, Math.PI, 1e-9, 1e21],
      [
        T0 + HOUR,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        -Number.EPSILON,
        Number.MIN_VALUE,
        0,
      ],
    ]);

    store.write(key, original);
    const restored = store.read(key) as CandleSeries;

    expect(restored.toBars()).toEqual(original.toBars());
    expect(restored.high[1]).toBe(Number.MAX_SAFE_INTEGER);
    expect(restored.open[0]).toBe(0.1 + 0.2);
  });

  it('writes an empty file for an empty series', () => {
    const store = new NdjsonCacheStore(cacheDir);
    store.write(key, CandleSeries.empty());
    expect(store.read(key)?.isEmpty).toBe(true);
  });
});
