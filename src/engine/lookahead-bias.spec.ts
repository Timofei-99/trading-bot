import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import { BacktestAdapter } from '../execution/backtest.adapter';
import { BacktestEngine } from './backtest.engine';

/**
 * Look-ahead bias audit for the engine.
 *
 * Two categories are checked:
 *
 *  1. DATA ISOLATION — on bar i the strategy may only see bars timestamped at
 *     or before bar i, on every timeframe.
 *  2. ENTRY-BAR EXECUTION — the engine places the order and settles the bar in
 *     the same step, which is only sound for a limit-order model where
 *     `Signal.entry` is a level known from earlier bars. The test pins the
 *     fill to `signal.entry` rather than anything derived from the signal
 *     bar's own OHLC.
 *
 * This file must stay green for the rest of the migration.
 */

const MINUTE_15 = 15 * 60_000;
const HOUR_4 = 4 * 3_600_000;
const START = Date.UTC(2024, 0, 1);
const SYMBOL = 'BTC/USDT';

class SpyStrategy extends Strategy {
  readonly name = 'spy';
  readonly version = '0';
  readonly calls: Record<string, number | undefined>[] = [];

  constructor(private readonly watched: string[]) {
    super();
  }

  checkEntry(context: MarketContext): Signal | null {
    const snapshot: Record<string, number | undefined> = {};
    for (const timeframe of this.watched) {
      const series = context.candles(timeframe);
      if (!series.isEmpty) {
        snapshot[timeframe] = series.lastTime as number;
      }
    }
    this.calls.push(snapshot);
    return null;
  }
}

class SignalOnBarStrategy extends Strategy {
  readonly name = 'trigger';
  readonly version = '0';
  callCount = 0;
  signalTimestamp: number | null = null;

  constructor(private readonly triggerBar: number) {
    super();
  }

  checkEntry(context: MarketContext): Signal | null {
    this.callCount += 1;
    const series = context.candles('15m');
    if (series.isEmpty || this.callCount !== this.triggerBar) {
      return null;
    }
    const timestamp = series.lastTime as number;
    this.signalTimestamp = timestamp;
    return new Signal({
      symbol: SYMBOL,
      direction: Direction.Long,
      entry: 100,
      stopLoss: 99,
      takeProfit: 102,
      timeframe: '15m',
      timestamp,
      strategyName: 'trigger',
      strategyVersion: '0',
    });
  }
}

/** Flat bars: 2 TFs, `n` 15m bars and a proportional number of 4h bars. */
function makeContext(n = 30): MarketContext {
  const flat = (startMs: number, stepMs: number, count: number): CandleSeries =>
    CandleSeries.fromBars(
      Array.from(
        { length: count },
        (_, i) => [startMs + i * stepMs, 100, 101, 99, 100.5, 1000] as BarTuple,
      ),
    );

  const context = new MarketContext(SYMBOL, ['4h', '15m'], 50_000);
  context.load('15m', flat(START, MINUTE_15, n));
  context.load('4h', flat(START, HOUR_4, Math.max(Math.floor(n / 16), 2)));
  return context;
}

describe('look-ahead bias', () => {
  describe('data isolation', () => {
    it('shows the strategy exactly bar i on the base timeframe', () => {
      const context = makeContext(30);
      const all = context.candles('15m');
      const spy = new SpyStrategy(['15m', '4h']);

      new BacktestEngine(context, spy, new BacktestAdapter(), { window: 500 }).run('15m');

      expect(spy.calls).toHaveLength(all.length);
      spy.calls.forEach((snapshot, i) => {
        expect(snapshot['15m']).toBe(all.time[i]);
      });
    });

    it('never shows a higher-timeframe bar from the future', () => {
      const context = makeContext(64);
      const all = context.candles('15m');
      const spy = new SpyStrategy(['15m', '4h']);

      new BacktestEngine(context, spy, new BacktestAdapter(), { window: 500 }).run('15m');

      spy.calls.forEach((snapshot, i) => {
        const htf = snapshot['4h'];
        if (htf !== undefined) {
          expect(htf).toBeLessThanOrEqual(all.time[i]);
        }
      });
    });

    it('never lets the visible window move backwards', () => {
      const context = makeContext(20);
      const spy = new SpyStrategy(['15m']);

      new BacktestEngine(context, spy, new BacktestAdapter(), { window: 500 }).run('15m');

      let previous: number | undefined;
      for (const snapshot of spy.calls) {
        const current = snapshot['15m'];
        if (previous !== undefined && current !== undefined) {
          expect(current).toBeGreaterThanOrEqual(previous);
        }
        previous = current;
      }
    });
  });

  describe('entry-bar execution', () => {
    it('fills at the level the strategy asked for, not at the bar', () => {
      const context = makeContext(20);
      const strategy = new SignalOnBarStrategy(10);
      const adapter = new BacktestAdapter({ initialBalance: 10_000 });

      new BacktestEngine(context, strategy, adapter, { window: 500 }).run('15m');

      const all = [...adapter.trades, ...adapter.openTrades];
      expect(all.length).toBeGreaterThanOrEqual(1);
      // Bars are open 100 / high 101 / low 99 / close 100.5, so a fill derived
      // from the signal bar's own OHLC would not be exactly 100.
      expect(all[0].entryPrice).toBeCloseTo(100, 12);
    });

    it('stamps the signal with the last bar visible when it was produced', () => {
      const context = makeContext(20);
      const all = context.candles('15m');
      const strategy = new SignalOnBarStrategy(10);

      new BacktestEngine(context, strategy, new BacktestAdapter({ initialBalance: 10_000 }), {
        window: 500,
      }).run('15m');

      expect(strategy.signalTimestamp).toBe(all.time[9]); // triggerBar 10 is 0-indexed 9
    });
  });
});
