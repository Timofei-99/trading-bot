import { BacktestOutcome } from '@bot/app/backtest-runner.service';
import { CandleSeries } from '@bot/core/domain/candle-series';
import { MarketContext } from '@bot/core/domain/market-context';
import { Direction, Signal } from '@bot/core/domain/signal';
import { Trade } from '@bot/core/domain/trade';

import { printBarCounts, printCosts, printReport, printTrades } from './backtest-output';

const T = Date.UTC(2023, 0, 1);
const HOUR = 3_600_000;

function lines(): { log: (line: string) => void; out: string[] } {
  const out: string[] = [];
  return { log: (line) => out.push(line), out };
}

function outcome(over: Partial<BacktestOutcome> = {}): BacktestOutcome {
  const context = new MarketContext('BTC/USDT', ['15m'], 500);
  context.load(
    '15m',
    CandleSeries.fromBars([
      [T, 100, 101, 99, 100, 1],
      [T + HOUR, 100, 101, 99, 100, 1],
    ]),
  );
  return {
    context,
    strategy: { name: 'OB_4h_FVG_15m', version: '1.0' },
    barsByTimeframe: { '15m': 2 },
    trades: [],
    openTrades: [],
    report: {
      totalTrades: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      profitFactor: 0,
      totalPnlPct: 0,
      maxDrawdownPct: 0,
    },
    ...over,
  } as BacktestOutcome;
}

function trade(pnlPct: number, exitReason: string): Trade {
  const signal = new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    timeframe: '15m',
    timestamp: T,
    strategyName: 'test',
    strategyVersion: '1.0',
  });
  const result = new Trade({
    signal,
    orderId: 'o1',
    entryTime: T,
    entryPrice: 100,
    positionSize: 1,
  });
  result.exitTime = T + HOUR;
  result.exitPrice = 110;
  result.exitReason = exitReason as Trade['exitReason'];
  Object.defineProperty(result, 'pnlPct', { get: () => pnlPct });
  return result;
}

describe('printCosts', () => {
  it('warns loudly when no fee was set', () => {
    // A gross backtest is not a tradeable result and looks exactly as
    // authoritative as a net one, so silence is the one unacceptable option.
    const { log, out } = lines();

    printCosts({}, log);

    expect(out[0]).toContain('fee 0 per side');
    expect(out[1]).toContain('GROSS, not tradeable');
  });

  it('does not warn once a fee is set', () => {
    const { log, out } = lines();

    printCosts({ fee: 0.001 }, log);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('fee 0.001 per side');
  });

  it('reports slippage and worst-case resolution', () => {
    const { log, out } = lines();

    printCosts({ fee: 0.001, slippage: 0.0005, worstCase: true }, log);

    expect(out[0]).toContain('slippage 0.0005');
    expect(out[0]).toContain('worst-case bars');
  });

  it('mentions worst-case only when it is on', () => {
    const { log, out } = lines();

    printCosts({ fee: 0.001, worstCase: false }, log);

    expect(out[0]).not.toContain('worst-case');
  });
});

describe('printBarCounts', () => {
  it('reports the count and the span actually loaded', () => {
    const { log, out } = lines();

    printBarCounts(outcome(), log);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('15m: 2 bars');
    expect(out[0]).toContain('2023-01-01');
  });

  it('omits the span when a timeframe loaded nothing', () => {
    const context = new MarketContext('BTC/USDT', ['15m'], 500);
    const { log, out } = lines();

    printBarCounts(outcome({ context, barsByTimeframe: { '15m': 0 } }), log);

    expect(out[0]).toBe('  15m: 0 bars');
  });
});

describe('printReport', () => {
  it('dates the report from the bars loaded, not the range requested', () => {
    // Asking for a year the venue only partly serves must not print a year
    // that was never tested.
    const { log, out } = lines();

    printReport(
      outcome(),
      { symbol: 'BTC/USDT', initialBalance: 10_000, baseTimeframe: '15m' },
      log,
    );

    expect(out[0]).toContain('2023-01-01');
    expect(out[0]).toContain('OB_4h_FVG_15m');
  });
});

describe('printTrades', () => {
  it('numbers each trade and shows its exit', () => {
    const { log, out } = lines();

    printTrades(outcome({ trades: [trade(0.1, 'tp')] }), log);

    expect(out[1]).toContain('  1  ');
    expect(out[1]).toContain('long');
    expect(out[1]).toContain('tp');
    expect(out[1]).toContain('10.00%');
  });

  it('says how many positions were still open at the end', () => {
    const { log, out } = lines();

    printTrades(outcome({ trades: [], openTrades: [trade(0, 'tp')] }), log);

    expect(out[out.length - 1]).toContain('+1 still open');
  });

  it('says nothing about open trades when there are none', () => {
    const { log, out } = lines();

    printTrades(outcome({ trades: [trade(0.1, 'tp')] }), log);

    expect(out.join('\n')).not.toContain('still open');
  });
});
