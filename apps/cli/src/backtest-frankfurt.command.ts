import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '@bot/app/backtest-runner.service';
import { ReportService } from '@bot/app/report.service';
import { InitialBalanceDetector } from '@bot/core/detectors/initial-balance.detector';
import { renderChart } from '@bot/infra/visualization/chart.renderer';
import { formatReportLines } from './report-format';

interface FrankfurtOptions {
  source?: 'mt5' | 'yahoo';
  csv?: string;
  tz?: string;
  charts?: boolean;
  balance?: number;
}

const DAY_MS = 86_400_000;
const YAHOO_SYMBOL = '^GDAXI';
const YAHOO_LOOKBACK_DAYS = 7;

@Command({
  name: 'backtest:frankfurt',
  description: 'Backtest frankfurt_ib_50 on DAX 1m bars (MT5 CSV or Yahoo Finance)',
})
export class BacktestFrankfurtCommand extends CommandRunner {
  constructor(
    private readonly runner: BacktestRunnerService,
    private readonly reports: ReportService,
  ) {
    super();
  }

  async run(_args: string[], options: FrankfurtOptions = {}): Promise<void> {
    const source = options.source ?? 'mt5';
    const balance = options.balance ?? 10_000;

    let dataRequest: Parameters<BacktestRunnerService['run']>[0]['data'];
    let symbolLabel: string;

    if (source === 'yahoo') {
      const endMs = Date.now();
      const startMs = endMs - YAHOO_LOOKBACK_DAYS * DAY_MS;
      console.log(
        `Fetching ${YAHOO_SYMBOL} 1m from Yahoo Finance (last ${YAHOO_LOOKBACK_DAYS} days) …`,
      );
      dataRequest = {
        source: 'yahoo',
        symbol: YAHOO_SYMBOL,
        timeframes: ['1m'],
        startMs,
        endMs,
      };
      symbolLabel = YAHOO_SYMBOL;
    } else {
      const csvPath = options.csv ?? join('data', 'dax_1m.csv');
      if (!existsSync(csvPath)) {
        console.log(`Missing ${csvPath}.`);
        console.log('Export FDAX/GER40 1m from MT5 and drop the file there.');
        console.log('Or run with --source yahoo for the last 7 days from Yahoo Finance.');
        return;
      }
      console.log(`Loading ${csvPath} …`);
      dataRequest = {
        source: 'mt5',
        symbol: 'FDAX',
        timeframes: ['1m'],
        startMs: Number.NEGATIVE_INFINITY,
        endMs: Number.POSITIVE_INFINITY,
        csvPath,
        sourceTz: options.tz ?? 'Europe/Berlin',
      };
      symbolLabel = 'FDAX';
    }

    const outcome = await this.runner.run({
      strategy: 'frankfurt_ib_50',
      data: dataRequest,
      engine: { baseTimeframe: '1m', window: 500 },
      account: { initialBalance: balance, riskPerTrade: 0.02 },
    });

    const candles = outcome.context.candles('1m');
    const span = BacktestRunnerService.span(candles);
    console.log(
      `  ${candles.length} bars  (${new Date(span?.fromMs ?? 0).toISOString()} … ` +
        `${new Date(span?.toMs ?? 0).toISOString()})`,
    );

    const summary = [
      `Symbol: ${symbolLabel}`,
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
      console.log('\nPass --charts to render the HTML chart audits.');
      return;
    }

    const ibDetector = new InitialBalanceDetector({
      timeframe: '1m',
      sessionStart: '08:00',
      sessionTz: 'UTC',
      durationMinutes: 60,
    });

    const lastTrade = trades[trades.length - 1];
    const dayStart = Math.floor(lastTrade.entryTime / DAY_MS) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const ibs = ibDetector.detect(candles.between(dayStart, dayEnd));

    const chartPath = join(this.reports.ensureDir(), 'frankfurt_ib_50_chart.html');
    renderChart({
      context: outcome.context,
      timeframe: '1m',
      patterns: ibs,
      trades: [lastTrade],
      startMs: dayStart,
      endMs: dayEnd,
      title: `${symbolLabel} 1m — ${new Date(dayStart).toISOString().slice(0, 10)} — ${outcome.strategy.name}`,
      savePath: chartPath,
    });
    console.log(`\n→ wrote ${chartPath}`);

    trades.forEach((trade, i) => {
      const tradeDayStart = Math.floor(trade.entryTime / DAY_MS) * DAY_MS;
      const tradeDayEnd = tradeDayStart + DAY_MS;
      const tradeIbs = ibDetector.detect(candles.between(tradeDayStart, tradeDayEnd));

      // Show 2 h before entry → 1 h after exit (or entry + 3 h minimum).
      const viewStart = trade.entryTime - 2 * 3_600_000;
      const viewEnd = Math.max(
        (trade.exitTime ?? trade.entryTime) + 3_600_000,
        trade.entryTime + 3 * 3_600_000,
      );

      const filename = ReportService.tradeFilename('frankfurt_ib_50', i + 1, trade, 2);
      renderChart({
        context: outcome.context,
        timeframe: '1m',
        patterns: tradeIbs,
        trades: [trade],
        startMs: viewStart,
        endMs: viewEnd,
        title: `${symbolLabel} — ${new Date(tradeDayStart).toISOString().slice(0, 10)} — ${trade.signal.direction.toUpperCase()} → ${trade.exitReason ?? 'open'}`,
        savePath: join(this.reports.reportsDir, filename),
      });
    });
    console.log(
      `→ wrote ${trades.length} trade audits to ${this.reports.reportsDir}/frankfurt_ib_50_trade_*.html`,
    );
  }

  @Option({
    flags: '--source <source>',
    description: 'Data source: mt5 (default) or yahoo (last 7 days)',
  })
  parseSource(value: string): 'mt5' | 'yahoo' {
    if (value !== 'mt5' && value !== 'yahoo') throw new Error('--source must be mt5 or yahoo');
    return value;
  }

  @Option({ flags: '--csv <path>', description: 'MT5 CSV export path (default data/dax_1m.csv)' })
  parseCsv(value: string): string {
    return value;
  }

  @Option({ flags: '--tz <zone>', description: 'MT5 broker timezone (default Europe/Berlin)' })
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
