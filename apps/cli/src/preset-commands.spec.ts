import {
  BacktestOutcome,
  BacktestRequest,
  BacktestRunnerService,
} from '@bot/app/backtest-runner.service';
import { ReportService } from '@bot/app/report.service';
import { BUILT_IN_STRATEGIES, StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { BarTuple, CandleSeries } from '@bot/core/domain/candle-series';
import { MarketContext } from '@bot/core/domain/market-context';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BacktestFrankfurtCommand } from './backtest-frankfurt.command';
import { BacktestH1m3mCommand } from './backtest-h1-3m.command';
import { BacktestOb4hCommand } from './backtest-ob4h.command';
import { StrategiesCommand } from './strategies.command';
import { capture } from './testing';
import { VersionCommand } from './version.command';

const T = Date.UTC(2023, 0, 1);

class StubRunner {
  readonly requests: BacktestRequest[] = [];

  async run(request: BacktestRequest): Promise<BacktestOutcome> {
    this.requests.push(request);
    const base = request.engine?.baseTimeframe ?? request.data.timeframes[0];
    const context = new MarketContext(request.data.symbol, [...request.data.timeframes], 500);
    context.load(
      base,
      CandleSeries.fromBars([
        [T, 100, 101, 99, 100, 1],
        [T + 3_600_000, 100, 101, 99, 100, 1],
      ] as BarTuple[]),
    );
    return {
      context,
      strategy: { name: request.strategy, version: '1.0' },
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
    } as unknown as BacktestOutcome;
  }

  get only(): BacktestRequest {
    expect(this.requests).toHaveLength(1);
    return this.requests[0];
  }
}

const runnerAs = (stub: StubRunner) => stub as unknown as BacktestRunnerService;

describe('version', () => {
  it('prints the name and version', async () => {
    const out = await capture(() => new VersionCommand().run());

    expect(out.text()).toMatch(/^trading-bot \d+\.\d+\.\d+$/);
  });
});

describe('strategies', () => {
  it('lists every registered strategy with enough detail to invoke it', async () => {
    const registry = new StrategyRegistryService(BUILT_IN_STRATEGIES);

    const out = await capture(() => new StrategiesCommand(registry).run());

    // Whatever else it prints, an operator has to be able to read off the id,
    // the timeframes and the parameters they can override.
    for (const descriptor of BUILT_IN_STRATEGIES) {
      expect(out.text()).toContain(`${descriptor.id} v${descriptor.version}`);
      expect(out.text()).toContain(descriptor.requiredTimeframes.join(', '));
    }
    expect(out.text()).toContain('minRr');
  });
});

describe('backtest:ob4h', () => {
  const command = (stub = new StubRunner()) => ({
    stub,
    subject: new BacktestOb4hCommand(runnerAs(stub)),
  });

  it('is the generic command with the preset filled in', async () => {
    const { stub, subject } = command();

    await capture(() => subject.run([], {}));

    expect(stub.only).toMatchObject({
      strategy: 'OB_4h_FVG_15m',
      data: { source: 'binance', symbol: 'BTC/USDT', timeframes: ['4h', '15m'] },
      engine: { baseTimeframe: '15m' },
    });
  });

  it('warns about a gross result, like the generic command does', async () => {
    // The presets used to print costs differently from `backtest`; they now
    // share one implementation and this is the check that they still do.
    const out = await capture(() => command().subject.run([], {}));

    expect(out.text()).toContain('GROSS, not tradeable');
  });

  it('accepts the range and cost overrides', async () => {
    const { stub, subject } = command();

    await capture(() =>
      subject.run([], { symbol: 'ETH/USDT', start: '2022-01-01', end: '2022-06-01', fee: 0.001 }),
    );

    expect(stub.only.data.symbol).toBe('ETH/USDT');
    expect(stub.only.account?.feeRate).toBe(0.001);
  });

  it('rejects a reversed range', async () => {
    await expect(
      command().subject.run([], { start: '2024-01-01', end: '2023-01-01' }),
    ).rejects.toThrow(/must be before/);
  });

  it('parses its own flags', () => {
    const { subject } = command();
    expect(subject.parseSymbol('BTC/USDT')).toBe('BTC/USDT');
    expect(subject.parseWindow('300')).toBe(300);
    expect(subject.parseBalance('5000')).toBe(5_000);
    expect(subject.parseFee('0.001')).toBe(0.001);
    expect(() => subject.parseFee('0.9')).toThrow();
  });
});

describe('backtest:h1-3m', () => {
  const command = (stub = new StubRunner()) => ({
    stub,
    subject: new BacktestH1m3mCommand(runnerAs(stub)),
  });

  it('asks Yahoo for the pair, on 1h and 5m', async () => {
    const { stub, subject } = command();

    await capture(() => subject.run([], {}));

    expect(stub.only).toMatchObject({
      strategy: '1h3m_classic',
      data: { source: 'yahoo', symbol: 'EURUSD=X', timeframes: ['1h', '5m'] },
    });
  });

  it('stays inside the window Yahoo actually serves', async () => {
    // Yahoo caps 5m history at 60 days; asking for more returns nothing and
    // the backtest silently has no bars.
    const { stub, subject } = command();

    await capture(() => subject.run([], {}));

    const days = (stub.only.data.endMs - stub.only.data.startMs) / 86_400_000;
    expect(days).toBeLessThanOrEqual(60);
  });

  it('honours --days and --ticker', async () => {
    const { stub, subject } = command();

    await capture(() => subject.run([], { days: 10, ticker: 'GBPUSD=X' }));

    expect(stub.only.data.symbol).toBe('GBPUSD=X');
    expect((stub.only.data.endMs - stub.only.data.startMs) / 86_400_000).toBeCloseTo(10, 5);
  });

  it('parses its own flags', () => {
    const { subject } = command();
    expect(subject.parseTicker('EURUSD=X')).toBe('EURUSD=X');
    expect(subject.parseDays('30')).toBe(30);
    expect(subject.parseBalance('5000')).toBe(5_000);
    expect(subject.parseRisk('0.02')).toBe(0.02);
  });
});

describe('backtest:frankfurt', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frankfurt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const command = (stub = new StubRunner()) => ({
    stub,
    subject: new BacktestFrankfurtCommand(runnerAs(stub), new ReportService(dir)),
  });

  it('explains what to do instead of failing when the export is missing', async () => {
    // The default path is an MT5 export the operator has to produce by hand,
    // so a bare ENOENT would be a poor way to say "go export the data".
    const { stub, subject } = command();

    const out = await capture(() => subject.run([], { csv: join(dir, 'absent.csv') }));

    expect(stub.requests).toHaveLength(0);
    expect(out.text()).toContain('Missing');
    expect(out.text()).toContain('--source yahoo');
  });

  it('reads an MT5 export when one is there', async () => {
    const csv = join(dir, 'dax.csv');
    writeFileSync(csv, 'date,time,open,high,low,close,volume\n', 'utf8');
    const { stub, subject } = command();

    await capture(() => subject.run([], { csv }));

    expect(stub.only.data).toMatchObject({ source: 'mt5', symbol: 'FDAX', csvPath: csv });
  });

  it('falls back to Yahoo when told to', async () => {
    const { stub, subject } = command();

    await capture(() => subject.run([], { source: 'yahoo' }));

    expect(stub.only.data.source).toBe('yahoo');
    expect(stub.only.data.timeframes).toEqual(['1m']);
  });

  it('parses its own flags', () => {
    const { subject } = command();
    expect(subject.parseCsv('a.csv')).toBe('a.csv');
    expect(subject.parseTz('Europe/Berlin')).toBe('Europe/Berlin');
    expect(subject.parseBalance('5000')).toBe(5_000);
    expect(subject.parseCharts()).toBe(true);
  });
});
