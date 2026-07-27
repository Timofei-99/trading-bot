import { MarketContext } from '../../src/domain/market-context';
import { Strategy } from '../../src/domain/ports';
import { Trade } from '../../src/domain/trade';
import { BacktestEngine } from '../../src/engine/backtest.engine';
import { BacktestAdapter, BacktestReport } from '../../src/execution/backtest.adapter';
import {
  FrankfurtIb50Strategy,
  H1m3mClassicStrategy,
  Ob4hFvg15mStrategy,
} from '../../src/strategies';
import {
  GoldenNumber,
  GoldenReport,
  GoldenTrade,
  GoldenTradesFile,
  goldenNumber,
  loadGolden,
  loadGoldenCandles,
} from '../fixtures/helpers';

/**
 * End-to-end parity: the full backtest, replayed through the TypeScript stack,
 * against the trades the Python stack produced on the same bars.
 *
 * This is the gate for the migration. Everything upstream — candle storage,
 * time handling, all nine detectors, the engine's slicing, the fill model —
 * has to be right simultaneously for a year of BTC to land on the same 150
 * trades with the same prices.
 *
 * Comparison is exact, not approximate. Python floats, numpy float64 and JS
 * numbers are all IEEE-754 doubles, so identical operations in identical order
 * give identical bits; an epsilon here would hide exactly the drift this is
 * meant to catch.
 */

interface RunSpec {
  run: string;
  timeframes: string[];
  datasets: string[];
  build: (params: Record<string, unknown>) => Strategy;
}

const RUNS: RunSpec[] = [
  {
    run: 'ob4h_fvg15m_btc_2023',
    timeframes: ['4h', '15m'],
    datasets: ['btc_4h', 'btc_15m'],
    build: (params) =>
      new Ob4hFvg15mStrategy({
        htf: params.htf as string,
        ltf: params.ltf as string,
        swingLengthHtf: params.swing_length_htf as number,
        swingLengthLtf: params.swing_length_ltf as number,
        obLookback: params.ob_lookback as number,
        liquiditySweepLookback: params.liquidity_sweep_lookback as number,
        minRr: params.min_rr as number,
      }),
  },
  {
    run: 'frankfurt_ib50_synth',
    timeframes: ['1m'],
    datasets: ['frankfurt_1m'],
    build: (params) =>
      new FrankfurtIb50Strategy({
        sessionStart: params.session_start as string,
        sessionTz: params.session_tz as string,
        ibDurationMinutes: params.ib_duration_minutes as number,
        sessionEnd: params.session_end as string,
        swingLength: params.swing_length as number,
        timeframe: params.timeframe as string,
      }),
  },
  {
    run: 'h1_3m_classic_synth',
    timeframes: ['1h', '5m'],
    datasets: ['eurusd_1h', 'eurusd_5m'],
    build: (params) =>
      new H1m3mClassicStrategy({
        htf: params.htf as string,
        ltf: params.ltf as string,
        symbol: params.symbol as string,
        minRr: params.min_rr as number,
        maxStopPips: params.max_stop_pips as number,
        pipSize: params.pip_size as number,
        fractalLookbackDays: params.fractal_lookback_days as number,
        contextThresholdPips: params.context_threshold_pips as number,
      }),
  },
];

/** The golden shape, minus `orderId` — uuid4 is not reproducible. */
function serializeTrade(trade: Trade): GoldenTrade {
  return {
    signal: {
      symbol: trade.signal.symbol,
      direction: trade.signal.direction,
      entry: trade.signal.entry,
      stopLoss: trade.signal.stopLoss,
      takeProfit: trade.signal.takeProfit,
      timeframe: trade.signal.timeframe,
      timestamp: trade.signal.timestamp,
      strategyName: trade.signal.strategyName,
      strategyVersion: trade.signal.strategyVersion,
      triggeredBy: [...trade.signal.triggeredBy],
      meta: trade.signal.meta,
      expiryTime: trade.signal.expiryTime,
    },
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    positionSize: trade.positionSize,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlPct: trade.pnlPct,
    pnlR: trade.pnlR,
    isWinner: trade.isWinner,
  };
}

function serializeReport(report: BacktestReport): Record<string, GoldenNumber> {
  return {
    ...report,
    profitFactor: Number.isFinite(report.profitFactor)
      ? report.profitFactor
      : report.profitFactor > 0
        ? 'inf'
        : '-inf',
  };
}

describe('strategy end-to-end parity with the Python implementation', () => {
  describe.each(RUNS.map((spec) => [spec.run, spec] as const))('%s', (_name, spec) => {
    const golden = loadGolden<GoldenTradesFile>('trades', `${spec.run}.json`);
    const goldenReport = loadGolden<GoldenReport>('reports', `${spec.run}.json`);

    const context = new MarketContext(golden.symbol, spec.timeframes, 60_000);
    spec.timeframes.forEach((timeframe, i) => {
      context.load(timeframe, loadGoldenCandles(spec.datasets[i]));
    });

    const strategy = spec.build(golden.strategyParams);
    const adapter = new BacktestAdapter({
      initialBalance: golden.adapterParams.initial_balance,
      riskPerTrade: golden.adapterParams.risk_per_trade,
    });
    const report = new BacktestEngine(context, strategy, adapter, {
      window: golden.window,
    }).run(golden.baseTimeframe);

    const closed = adapter.trades.map(serializeTrade);
    const open = adapter.openTrades.map(serializeTrade);

    it('identifies itself the same way', () => {
      expect(strategy.name).toBe(golden.strategyName);
      expect(strategy.version).toBe(golden.strategyVersion);
    });

    it('produces the same number of trades', () => {
      expect(closed).toHaveLength(golden.closedTrades.length);
      expect(open).toHaveLength(golden.openTrades.length);
      expect(golden.closedTrades.length).toBeGreaterThan(0);
    });

    it('matches every field of every closed trade', () => {
      golden.closedTrades.forEach((expected, i) => {
        expect({ trade: i, ...closed[i] }).toEqual({ trade: i, ...expected });
      });
    });

    it('matches every open trade left at the end', () => {
      golden.openTrades.forEach((expected, i) => {
        expect({ trade: i, ...open[i] }).toEqual({ trade: i, ...expected });
      });
    });

    it('matches the whole trade list bit for bit', () => {
      expect(closed).toEqual(golden.closedTrades);
    });

    it('ends on the same balance', () => {
      expect(adapter.balance).toBe(golden.finalBalance);
    });

    it('produces the same report', () => {
      expect(serializeReport(report)).toEqual(goldenReport);
      expect(report.profitFactor).toBe(goldenNumber(goldenReport.profitFactor));
    });
  });
});
