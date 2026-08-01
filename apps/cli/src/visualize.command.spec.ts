import {
  BacktestOutcome,
  BacktestRequest,
  BacktestRunnerService,
} from '@bot/app/backtest-runner.service';
import { ReportService } from '@bot/app/report.service';
import { BarTuple, CandleSeries } from '@bot/core/domain/candle-series';
import { MarketContext } from '@bot/core/domain/market-context';
import { Direction, Signal } from '@bot/core/domain/signal';
import { Trade } from '@bot/core/domain/trade';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capture, captureError } from './testing';
import { VisualizeCommand } from './visualize.command';

const H4 = 4 * 3_600_000;
const M15 = 15 * 60_000;
/** Inside the default `--chart-month`, so the default path has data to draw. */
const FEB = Date.UTC(2023, 1, 1);

function bars(from: number, step: number, count: number): CandleSeries {
  return CandleSeries.fromBars(
    Array.from({ length: count }, (_, i) => {
      // A gentle zigzag, so the detectors find something rather than nothing.
      const drift = 100 + i * 0.5 + (i % 7) * 3;
      return [from + i * step, drift, drift + 4, drift - 4, drift + 1, 1_000] as BarTuple;
    }),
  );
}

function tradeAt(index: number, exitPrice: number): Trade {
  const entryTime = FEB + index * H4;
  const signal = new Signal({
    symbol: 'BTC/USDT',
    direction: Direction.Long,
    entry: 100,
    stopLoss: 95,
    takeProfit: 120,
    timeframe: '15m',
    timestamp: entryTime,
    strategyName: 'OB_4h_FVG_15m',
    strategyVersion: '1.0',
  });
  const trade = new Trade({
    signal,
    orderId: `o${index}`,
    entryTime,
    entryPrice: 100,
    positionSize: 1,
  });
  trade.exitTime = entryTime + H4;
  trade.exitPrice = exitPrice;
  trade.exitReason = exitPrice > 100 ? 'tp' : 'sl';
  return trade;
}

class StubRunner {
  readonly requests: BacktestRequest[] = [];
  trades: Trade[] = [];

  async run(request: BacktestRequest): Promise<BacktestOutcome> {
    this.requests.push(request);

    const context = new MarketContext('BTC/USDT', ['4h', '15m'], 100_000);
    context.load('4h', bars(FEB, H4, 200));
    context.load('15m', bars(FEB, M15, 3_000));

    return {
      context,
      strategy: { name: 'OB_4h_FVG_15m', version: '1.0' },
      baseTimeframe: '15m',
      barsByTimeframe: { '4h': 200, '15m': 3_000 },
      trades: this.trades,
      openTrades: [],
      finalBalance: 10_000,
      report: {
        totalTrades: this.trades.length,
        winners: 0,
        losers: 0,
        winRate: 0.5,
        profitFactor: 1,
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

/**
 * The chart-rendering command, driven end to end into a temp directory.
 *
 * Nothing is stubbed below the runner: the detectors really run over the
 * candles and Plotly figures really get written to disk, because "did it
 * produce a usable file" is the only thing this command is for.
 */
describe('visualize', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'visualize-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(trades: Trade[] = []) {
    const runner = new StubRunner();
    runner.trades = trades;
    return {
      runner,
      subject: new VisualizeCommand(
        runner as unknown as BacktestRunnerService,
        new ReportService(dir),
      ),
    };
  }

  const written = (): string[] => readdirSync(dir).sort();

  describe('the context chart', () => {
    it('writes a standalone HTML file for the requested month', async () => {
      const { subject } = build();

      await capture(() => subject.run([], {}));

      expect(written()).toContain('chart_2023_02.html');
      const html = readFileSync(join(dir, 'chart_2023_02.html'), 'utf8');
      expect(html).toContain('Plotly.newPlot');
      expect(html).toContain('candlestick');
    });

    it('names the file after the month actually charted', async () => {
      const { subject } = build();

      await capture(() => subject.run([], { chartMonth: '2023-03' }));

      expect(written()).toContain('chart_2023_03.html');
    });

    it('runs the detectors over the higher timeframe and says how many it found', async () => {
      // The whole point of the chart is the annotations; zero patterns would
      // mean the detectors were handed the wrong series.
      const { subject } = build();

      const out = await capture(() => subject.run([], {}));

      const match = out.text().match(/Detected (\d+) 4h patterns/);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(0);
    });

    it('asks the runner for the strategy and timeframes the chart needs', async () => {
      const { runner, subject } = build();

      await capture(() => subject.run([], {}));

      expect(runner.only).toMatchObject({
        strategy: 'OB_4h_FVG_15m',
        data: { source: 'binance', symbol: 'BTC/USDT', timeframes: ['4h', '15m'] },
      });
    });

    it('honours --symbol', async () => {
      const { runner, subject } = build();

      await capture(() => subject.run([], { symbol: 'ETH/USDT' }));

      expect(runner.only.data.symbol).toBe('ETH/USDT');
    });
  });

  describe('trade audits', () => {
    it('renders one file per trade, ranked by absolute PnL', async () => {
      // Ranked by magnitude, not by sign: the biggest loser is as instructive
      // as the biggest winner, which is what these audits are for.
      const { subject } = build([tradeAt(10, 101), tradeAt(20, 130), tradeAt(30, 90)]);

      const out = await capture(() => subject.run([], {}));

      const audits = written().filter((name) => name.startsWith('trade_'));
      expect(audits).toHaveLength(3);
      // 130 -> +30%, 90 -> -10%, 101 -> +1%
      expect(out.text().indexOf('+30.00%')).toBeLessThan(out.text().indexOf('-10.00%'));
      expect(out.text().indexOf('-10.00%')).toBeLessThan(out.text().indexOf('+1.00%'));
    });

    it('caps them at --top', async () => {
      const { subject } = build([tradeAt(10, 130), tradeAt(20, 90), tradeAt(30, 101)]);

      await capture(() => subject.run([], { top: 2 }));

      expect(written().filter((name) => name.startsWith('trade_'))).toHaveLength(2);
    });

    it('puts the outcome in the filename so a directory listing is readable', async () => {
      const { subject } = build([tradeAt(10, 130)]);

      await capture(() => subject.run([], {}));

      const [audit] = written().filter((name) => name.startsWith('trade_'));
      expect(audit).toMatch(/^trade_1_BTC_USDT_.*\.html$/);
      expect(audit).not.toContain('/');
    });

    it('writes a chart that actually loads Plotly', async () => {
      const { subject } = build([tradeAt(10, 130)]);

      await capture(() => subject.run([], {}));

      const [audit] = written().filter((name) => name.startsWith('trade_'));
      expect(readFileSync(join(dir, audit), 'utf8')).toContain('Plotly.newPlot');
    });

    it('says so and stops when nothing closed', async () => {
      const { subject } = build();

      const out = await capture(() => subject.run([], {}));

      expect(out.text()).toContain('No closed trades');
      expect(written().filter((name) => name.startsWith('trade_'))).toEqual([]);
    });

    it('ignores a trade that is still open', async () => {
      // An open trade has no PnL to rank by, and rendering it as an audit
      // would draw an exit that has not happened.
      const open = tradeAt(10, 130);
      open.exitTime = null;
      open.exitPrice = null;
      open.exitReason = null;

      const { subject } = build([open]);
      const out = await capture(() => subject.run([], {}));

      expect(out.text()).toContain('No closed trades');
    });
  });

  describe('argument checking', () => {
    it('rejects a reversed range', async () => {
      const { error } = await captureError(() =>
        build().subject.run([], { start: '2023-04-01', end: '2023-01-01' }),
      );

      expect(error?.message).toMatch(/must be before/);
    });

    it('rejects a month it cannot parse', async () => {
      const { error } = await captureError(() =>
        build().subject.run([], { chartMonth: 'February' }),
      );

      expect(error?.message).toMatch(/--chart-month/);
    });

    it('parses its flags', () => {
      const { subject } = build();
      expect(subject.parseSymbol('BTC/USDT')).toBe('BTC/USDT');
      expect(subject.parseStart('2023-01-01')).toBe('2023-01-01');
      expect(subject.parseEnd('2023-04-01')).toBe('2023-04-01');
      expect(subject.parseChartMonth('2023-02')).toBe('2023-02');
      expect(subject.parseTop('5')).toBe(5);
    });
  });
});
