import {
  BacktestOutcome,
  BacktestRequest,
  BacktestRunnerService,
} from '@bot/app/backtest-runner.service';
import { BUILT_IN_STRATEGIES, StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { CandleSeries } from '@bot/core/domain/candle-series';
import { MarketContext } from '@bot/core/domain/market-context';
import { Direction, Signal } from '@bot/core/domain/signal';
import { Trade } from '@bot/core/domain/trade';

import { BacktestCommand } from './backtest.command';
import { capture, captureError } from './testing';

const T = Date.UTC(2023, 0, 1);
const HOUR = 3_600_000;

/** Records what the command asked for, and answers with a fixed outcome. */
class StubRunner {
  readonly requests: BacktestRequest[] = [];
  outcome: Partial<BacktestOutcome> = {};

  async run(request: BacktestRequest): Promise<BacktestOutcome> {
    this.requests.push(request);

    // Answer in the shape the command asked for, so a test that varies the
    // strategy does not have to know this stub's hardcoded timeframes.
    const timeframes = [...request.data.timeframes];
    const base = request.engine?.baseTimeframe ?? timeframes[timeframes.length - 1];
    const context = new MarketContext(request.data.symbol, timeframes, 500);
    context.load(
      base,
      CandleSeries.fromBars([
        [T, 100, 101, 99, 100, 1],
        [T + HOUR, 100, 101, 99, 100, 1],
      ]),
    );

    return {
      context,
      strategy: { name: 'OB_4h_FVG_15m', version: '1.0' },
      baseTimeframe: base,
      barsByTimeframe: { [base]: 2 },
      trades: [],
      openTrades: [],
      finalBalance: 10_000,
      report: {
        totalTrades: 0,
        winners: 0,
        losers: 0,
        winRate: 0,
        profitFactor: 0,
        totalPnlPct: 0,
        maxDrawdownPct: 0,
      },
      ...this.outcome,
    } as BacktestOutcome;
  }

  get only(): BacktestRequest {
    expect(this.requests).toHaveLength(1);
    return this.requests[0];
  }
}

function trade(): Trade {
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
  result.exitReason = 'tp';
  return result;
}

function command(runner = new StubRunner()) {
  const registry = new StrategyRegistryService(BUILT_IN_STRATEGIES);
  return {
    runner,
    command: new BacktestCommand(runner as unknown as BacktestRunnerService, registry),
  };
}

describe('backtest', () => {
  describe('without --strategy', () => {
    it('lists what it could have run instead of guessing', async () => {
      // Picking a default strategy here would run somebody's money question
      // against a strategy they did not name.
      const { runner, command: subject } = command();

      const out = await capture(() => subject.run([], {}));

      expect(runner.requests).toHaveLength(0);
      expect(out.text()).toContain('--strategy is required');
      expect(out.text()).toContain('OB_4h_FVG_15m');
      expect(out.text()).toContain('4h, 15m');
    });
  });

  describe('defaults', () => {
    it('takes the timeframes the strategy declared', async () => {
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'OB_4h_FVG_15m' }));

      expect(runner.only.data.timeframes).toEqual(['4h', '15m']);
    });

    it('drives the loop from the finest timeframe', async () => {
      // The registry lists them coarse-to-fine, so the base is the last one.
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'OB_4h_FVG_15m' }));

      expect(runner.only.engine?.baseTimeframe).toBe('15m');
    });

    it('lets --base override it', async () => {
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'OB_4h_FVG_15m', base: '4h' }));

      expect(runner.only.engine?.baseTimeframe).toBe('4h');
    });

    it('reads the symbol a forex strategy names for itself', async () => {
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: '1h3m_classic', source: 'yahoo' }));

      expect(runner.only.data.symbol).toBe('EURUSD=X');
    });

    it('falls back to BTC/USDT for a strategy that names none', async () => {
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'OB_4h_FVG_15m' }));

      expect(runner.only.data.symbol).toBe('BTC/USDT');
    });

    it('assumes an MT5 export when a csv is given', async () => {
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'frankfurt_ib_50', csv: 'dax.csv' }));

      expect(runner.only.data.source).toBe('mt5');
    });
  });

  describe('the date range', () => {
    it('is unbounded for an MT5 export, which carries its own', async () => {
      // A CSV is whatever the broker exported; clamping it to a default year
      // would silently drop bars the operator meant to test.
      const { runner, command: subject } = command();

      await capture(() => subject.run([], { strategy: 'frankfurt_ib_50', csv: 'dax.csv' }));

      expect(runner.only.data.startMs).toBe(Number.NEGATIVE_INFINITY);
      expect(runner.only.data.endMs).toBe(Number.POSITIVE_INFINITY);
    });

    it('is checked for order on a live source', async () => {
      const { error } = await captureError(() =>
        command().command.run([], {
          strategy: 'OB_4h_FVG_15m',
          start: '2024-01-01',
          end: '2023-01-01',
        }),
      );

      expect(error?.message).toMatch(/must be before/);
    });
  });

  describe('costs', () => {
    it('warns that a fee-less result is not tradeable', async () => {
      const out = await capture(() => command().command.run([], { strategy: 'OB_4h_FVG_15m' }));

      expect(out.text()).toContain('GROSS, not tradeable');
    });

    it('stops warning once a fee is set', async () => {
      const out = await capture(() =>
        command().command.run([], { strategy: 'OB_4h_FVG_15m', fee: 0.001 }),
      );

      expect(out.text()).not.toContain('GROSS');
    });

    it('passes every cost knob through to the run', async () => {
      const { runner, command: subject } = command();

      await capture(() =>
        subject.run([], {
          strategy: 'OB_4h_FVG_15m',
          fee: 0.001,
          slippage: 0.0005,
          worstCase: true,
          maxDailyDd: 0.03,
          risk: 0.02,
          balance: 5_000,
        }),
      );

      expect(runner.only.account).toMatchObject({
        feeRate: 0.001,
        slippage: 0.0005,
        worstCase: true,
        maxDailyDrawdown: 0.03,
        riskPerTrade: 0.02,
        initialBalance: 5_000,
      });
    });
  });

  describe('output', () => {
    it('names the strategy and the data it ran on', async () => {
      const out = await capture(() =>
        command().command.run([], { strategy: 'OB_4h_FVG_15m', fee: 0.001 }),
      );

      expect(out.text()).toContain('OB_4h_FVG_15m v1.0');
      expect(out.text()).toContain('binance BTC/USDT');
      expect(out.text()).toContain('15m: 2 bars');
    });

    it('prints the trade list only when asked', async () => {
      const runner = new StubRunner();
      runner.outcome = { trades: [trade()] };

      const quiet = await capture(() =>
        command(runner).command.run([], { strategy: 'OB_4h_FVG_15m' }),
      );
      const loud = await capture(() =>
        command(runner).command.run([], { strategy: 'OB_4h_FVG_15m', trades: true }),
      );

      expect(quiet.text()).not.toContain('=== Trades ===');
      expect(loud.text()).toContain('=== Trades ===');
      expect(loud.text()).toContain('tp');
    });
  });

  describe('option parsing', () => {
    const subject = () => command().command;

    it('reads --params as a JSON object', () => {
      expect(subject().parseParams('{"minRr":2}')).toEqual({ minRr: 2 });
    });

    it.each(['[1,2]', '"text"', 'null'])('refuses --params %s', (value) => {
      expect(() => subject().parseParams(value)).toThrow(/expected a JSON object/);
    });

    it.each(['binance', 'yahoo', 'mt5'])('accepts --source %s', (value) => {
      expect(subject().parseSource(value)).toBe(value);
    });

    it('refuses an unknown --source', () => {
      expect(() => subject().parseSource('kraken')).toThrow(/expected binance, yahoo or mt5/);
    });

    it('splits and trims --timeframes', () => {
      expect(subject().parseTimeframes(' 4h , 15m ,, ')).toEqual(['4h', '15m']);
    });

    it.each([
      ['--fee', (value: string) => subject().parseFee(value)],
      ['--slippage', (value: string) => subject().parseSlippage(value)],
      ['--max-daily-dd', (value: string) => subject().parseMaxDailyDd(value)],
    ])('bounds %s to a sane fraction', (_flag, parse) => {
      expect(parse('0.001')).toBe(0.001);
      // A "fee" of 50% is a typo, not an instruction — most likely someone
      // typed a percentage where a fraction was wanted.
      expect(() => parse('0.5')).toThrow(/fraction in \[0, 0.5\)/);
      expect(() => parse('-1')).toThrow();
      expect(() => parse('abc')).toThrow();
    });

    it('passes the plain string flags through', () => {
      const parser = subject();
      expect(parser.parseStrategy('x')).toBe('x');
      expect(parser.parseSymbol('BTC/USDT')).toBe('BTC/USDT');
      expect(parser.parseCsv('a.csv')).toBe('a.csv');
      expect(parser.parseTz('Europe/Berlin')).toBe('Europe/Berlin');
      expect(parser.parseBase('4h')).toBe('4h');
      expect(parser.parseStart('2023-01-01')).toBe('2023-01-01');
      expect(parser.parseEnd('2024-01-01')).toBe('2024-01-01');
      expect(parser.parseWindow('500')).toBe(500);
      expect(parser.parseBalance('10000')).toBe(10_000);
      expect(parser.parseRisk('0.01')).toBe(0.01);
      expect(parser.parseWorstCase()).toBe(true);
      expect(parser.parseTrades()).toBe(true);
    });
  });
});
