import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '../application/backtest-runner.service';
import { ReportService } from '../application/report.service';
import { InitialBalanceDetector } from '../detectors/initial-balance.detector';
import { renderChart } from '../infrastructure/visualization/chart.renderer';
import { renderTrade } from '../infrastructure/visualization/trade-chart.renderer';
import { formatReportLines } from './report-format';

interface FrankfurtOptions {
  csv?: string;
  tz?: string;
  charts?: boolean;
  balance?: number;
}

const DAY_MS = 86_400_000;

/** Replaces `run_frankfurt_ib_50.py`. */
@Command({
  name: 'backtest:frankfurt',
  description: 'Backtest frankfurt_ib_50 on 1m bars exported from MetaTrader 5',
})
export class BacktestFrankfurtCommand extends CommandRunner {
  constructor(
    private readonly runner: BacktestRunnerService,
    private readonly reports: ReportService,
  ) {
    super();
  }

  async run(_args: string[], options: FrankfurtOptions = {}): Promise<void> {
    const csvPath = options.csv ?? join('data', 'dax_1m.csv');
    if (!existsSync(csvPath)) {
      console.log(`Missing ${csvPath}.`);
      console.log('Export FDAX 1m data from MT5 (right-click chart → Save As → CSV) and');
      console.log(`drop the file at ${csvPath}. Tab or comma separators both work.`);
      return;
    }

    const balance = options.balance ?? 10_000;
    console.log(`Loading ${csvPath} …`);

    const outcome = await this.runner.run({
      strategy: 'frankfurt_ib_50',
      data: {
        source: 'mt5',
        symbol: 'FDAX',
        timeframes: ['1m'],
        startMs: Number.NEGATIVE_INFINITY,
        endMs: Number.POSITIVE_INFINITY,
        csvPath,
        sourceTz: options.tz ?? 'Europe/Berlin',
      },
      engine: { baseTimeframe: '1m', window: 500 },
      account: { initialBalance: balance },
    });

    const candles = outcome.context.candles('1m');
    const span = BacktestRunnerService.span(candles);
    console.log(
      `  ${candles.length} bars  (${new Date(span?.fromMs ?? 0).toISOString()} … ` +
        `${new Date(span?.toMs ?? 0).toISOString()})`,
    );

    const summary = [
      `Symbol: FDAX`,
      `Strategy: ${outcome.strategy.name} v${outcome.strategy.version}`,
      `Period: ${new Date(span?.fromMs ?? 0).toISOString()} .. ${new Date(span?.toMs ?? 0).toISOString()}`,
      `Initial balance: ${balance.toFixed(2)}`,
      formatReportLines(outcome.report),
      '',
    ].join('\n');

    const summaryPath = this.reports.writeText('frankfurt_ib_50_summary.txt', summary);
    console.log('\n=== Report ===');
    console.log(formatReportLines(outcome.report));
    console.log(`\n→ wrote ${summaryPath}`);

    const trades = outcome.trades;
    if (trades.length === 0) {
      console.log('\nNo closed trades — nothing to visualise.');
      return;
    }
    if (options.charts !== true) {
      console.log('\nPass --charts to render the HTML audits.');
      return;
    }

    // Chart of the day of the last trade, with the Frankfurt IB marked.
    const lastTrade = trades[trades.length - 1];
    const dayStart = Math.floor(lastTrade.entryTime / DAY_MS) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const ibs = new InitialBalanceDetector({ timeframe: '1m' }).detect(
      candles.between(dayStart, dayEnd),
    );

    const chartPath = join(this.reports.ensureDir(), 'frankfurt_ib_50_chart.html');
    renderChart({
      context: outcome.context,
      timeframe: '1m',
      patterns: ibs,
      trades: [lastTrade],
      startMs: dayStart,
      endMs: dayEnd,
      title: `FDAX 1m — ${new Date(dayStart).toISOString().slice(0, 10)} — ${outcome.strategy.name}`,
      savePath: chartPath,
    });
    console.log(`\n→ wrote ${chartPath}`);

    trades.forEach((trade, i) => {
      const filename = ReportService.tradeFilename('frankfurt_ib_50', i + 1, trade, 2);
      renderTrade({
        trade,
        context: outcome.context,
        htf: '1m',
        ltf: '1m',
        barsBefore: 90,
        barsAfter: 60,
        savePath: join(this.reports.reportsDir, filename),
      });
    });
    console.log(
      `→ wrote ${trades.length} trade audits to ${this.reports.reportsDir}/frankfurt_ib_50_trade_*.html`,
    );
  }

  @Option({ flags: '--csv <path>', description: 'MT5 export (default data/dax_1m.csv)' })
  parseCsv(value: string): string {
    return value;
  }

  @Option({ flags: '--tz <zone>', description: 'Broker timezone (default Europe/Berlin)' })
  parseTz(value: string): string {
    return value;
  }

  @Option({ flags: '--charts', description: 'Also render HTML chart audits' })
  parseCharts(): boolean {
    return true;
  }

  @Option({ flags: '--balance <eur>', description: 'Starting balance (default 10000)' })
  parseBalance(value: string): number {
    return Number.parseFloat(value);
  }
}
