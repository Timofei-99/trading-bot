import { BarTuple, CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { RiskManager } from '../domain/risk-manager';
import { Direction, Signal } from '../domain/signal';
import { BacktestAdapter } from '../execution/backtest.adapter';
import { BacktestEngine } from './backtest.engine';

const MINUTE_15 = 15 * 60_000;
const SYMBOL = 'BTC/USDT';

/**
 * The engine-level daily-loss gate.
 *
 * Every bar reaches the stop immediately, so each entry realizes a -10% loss
 * on the same bar it opens. With a RiskManager configured, entries must pause
 * for the rest of the UTC day once the cap is breached and resume on the next
 * day; without one, the engine must keep entering exactly as before.
 */

/** Signals a long on every bar; the stop sits inside every bar's range. */
class AlwaysEnterStrategy extends Strategy {
  readonly name = 'always';
  readonly version = '0';

  checkEntry(context: MarketContext): Signal | null {
    const series = context.candles('15m');
    if (series.isEmpty) {
      return null;
    }
    return new Signal({
      symbol: SYMBOL,
      direction: Direction.Long,
      entry: 100,
      stopLoss: 90, // low of every bar is 89 -> instant -10%
      takeProfit: 200,
      timeframe: '15m',
      timestamp: series.lastTime as number,
      strategyName: 'always',
      strategyVersion: '0',
    });
  }
}

/** Flat bars spanning two UTC days, `perDay` bars each. */
function twoDayContext(perDay: number): MarketContext {
  const day1 = Date.UTC(2024, 0, 1);
  const day2 = Date.UTC(2024, 0, 2);
  const bars: BarTuple[] = [];
  for (const dayStart of [day1, day2]) {
    for (let i = 0; i < perDay; i++) {
      bars.push([dayStart + i * MINUTE_15, 100, 101, 89, 100, 1000]);
    }
  }
  const context = new MarketContext(SYMBOL, ['15m'], 50_000);
  context.load('15m', CandleSeries.fromBars(bars));
  return context;
}

describe('engine risk gate', () => {
  it('without a RiskManager, enters on every bar as before', () => {
    const adapter = new BacktestAdapter({ initialBalance: 10_000 });
    new BacktestEngine(twoDayContext(5), new AlwaysEnterStrategy(), adapter, {
      window: 500,
    }).run('15m');

    expect(adapter.trades).toHaveLength(10);
  });

  it('pauses entries for the day once the realized loss breaches the cap', () => {
    const adapter = new BacktestAdapter({ initialBalance: 10_000 });
    new BacktestEngine(twoDayContext(5), new AlwaysEnterStrategy(), adapter, {
      window: 500,
      // Each trade loses 10%; the cap allows one loss (-0.1 < -0.15 is false),
      // blocks after the second would breach: after trade 1, dailyPnl = -0.1;
      // -0.1 >= -0.15 so trade 2 opens; after it dailyPnl = -0.2 -> blocked.
      riskManager: new RiskManager(0.01, 0.15),
    }).run('15m');

    const byDay = new Map<number, number>();
    for (const trade of adapter.trades) {
      const day = Math.floor(trade.exitTime! / 86_400_000);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    // Two trades per day, then the gate holds until the next UTC day resets it.
    expect([...byDay.values()]).toEqual([2, 2]);
    expect(adapter.trades).toHaveLength(4);
  });

  it('a generous cap never engages', () => {
    const adapter = new BacktestAdapter({ initialBalance: 10_000 });
    new BacktestEngine(twoDayContext(5), new AlwaysEnterStrategy(), adapter, {
      window: 500,
      riskManager: new RiskManager(0.01, 10),
    }).run('15m');

    expect(adapter.trades).toHaveLength(10);
  });
});
