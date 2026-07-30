import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestOutcome, BacktestRunnerService } from '@bot/app/backtest-runner.service';
import { ReportService } from '@bot/app/report.service';
import { InitialBalanceDetector } from '@bot/core/detectors/initial-balance.detector';
import { BacktestReport } from '@bot/core/execution/backtest.adapter';
import { renderChart } from '@bot/infra/visualization/chart.renderer';
import { formatReportLines, percent1, percent2, profitFactor, signedPercent2 } from './report-format';

interface FrankfurtOptions {
  source?: 'mt5' | 'yahoo';
  csv?: string;
  dir?: string;
  from?: string;
  to?: string;
  tz?: string;
  charts?: boolean;
  losers?: boolean;
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

    if (source === 'yahoo') {
      await this.runSingle(options, balance);
      return;
    }

    // --dir: run one backtest per CSV file found in the directory
    const dir = options.dir;
    if (dir !== undefined || options.csv === undefined) {
      const searchDir = dir ?? 'data';
      if (!existsSync(searchDir)) {
        console.log(`Directory not found: ${searchDir}`);
        return;
      }
      const csvFiles = readdirSync(searchDir)
        .filter((f) => {
          if (!f.toLowerCase().endsWith('.csv') || !f.includes('_ASK_')) return false;
          const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
          if (m === null) return true;
          const date = m[1];
          if (options.from !== undefined && date < options.from) return false;
          if (options.to !== undefined && date > options.to) return false;
          return true;
        })
        .sort()
        .map((f) => join(searchDir, f));

      if (csvFiles.length === 0) {
        console.log(`No CSV files found in ${searchDir}.`);
        return;
      }

      const chartPaths: string[] = [];
      const fileOutcomes: Array<{ file: string; outcome: BacktestOutcome }> = [];
      for (const csvPath of csvFiles) {
        console.log(`\n=== ${basename(csvPath)} ===`);
        const result = await this.runSingle({ ...options, csv: csvPath }, balance);
        if (result.chartPath !== undefined) {
          chartPaths.push(result.chartPath);
        }
        fileOutcomes.push({ file: basename(csvPath), outcome: result.outcome });
      }

      printMultiFileSummary(fileOutcomes, balance);

      const openCharts = options.charts === true || options.losers === true;
      if (openCharts && chartPaths.length > 0) {
        const toOpen = options.losers === true
          ? chartPaths.filter((_, i) => (fileOutcomes[i]?.outcome.report.losers ?? 0) > 0)
          : chartPaths;
        for (const p of toOpen) {
          execSync(`open "${p}"`);
        }
      }
      return;
    }

    await this.runSingle(options, balance);
  }

  // ---- helpers ----

  private async runSingle(
    options: FrankfurtOptions,
    balance: number,
  ): Promise<{ chartPath: string | undefined; outcome: BacktestOutcome }> {
    const source = options.source ?? 'mt5';

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
        return { chartPath: undefined, outcome: undefined as never };
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
    if (options.charts !== true && options.losers !== true) {
      if (trades.length === 0) {
        console.log('No closed trades — nothing to visualise.');
      } else {
        console.log('Pass --charts to render the HTML chart audits.');
      }
      return { chartPath: undefined, outcome };
    }

    const ibDetector = new InitialBalanceDetector({
      timeframe: '1m',
      sessionStart: '06:00',
      sessionTz: 'UTC',
      durationMinutes: 60,
    });

    const overviewStart = span?.fromMs ?? 0;
    const overviewEnd = span?.toMs ?? 0;
    const ibs = ibDetector.detect(candles);

    const dateTag = new Date(overviewStart).toISOString().slice(0, 10);
    const chartPath = join(this.reports.ensureDir(), `frankfurt_ib_50_chart_${dateTag}.html`);
    renderChart({
      context: outcome.context,
      timeframe: '1m',
      patterns: ibs,
      trades,
      startMs: overviewStart,
      endMs: overviewEnd,
      title: `${symbolLabel} 1m — ${dateTag} — ${outcome.strategy.name}`,
      savePath: chartPath,
    });
    console.log(`→ wrote ${chartPath}`);

    if (trades.length > 0) {
      trades.forEach((trade, i) => {
        const tradeDayStart = Math.floor(trade.entryTime / DAY_MS) * DAY_MS;
        const tradeDayEnd = tradeDayStart + DAY_MS;
        const tradeIbs = ibDetector.detect(candles.between(tradeDayStart, tradeDayEnd));

        const filename = ReportService.tradeFilename('frankfurt_ib_50', i + 1, trade, 2);
        renderChart({
          context: outcome.context,
          timeframe: '1m',
          patterns: tradeIbs,
          trades: [trade],
          startMs: tradeDayStart,
          endMs: tradeDayEnd,
          title: `${symbolLabel} — ${new Date(tradeDayStart).toISOString().slice(0, 10)} — ${trade.signal.direction.toUpperCase()} → ${trade.exitReason ?? 'open'}`,
          savePath: join(this.reports.reportsDir, filename),
        });
      });
      console.log(
        `→ wrote ${trades.length} trade audits to ${this.reports.reportsDir}/frankfurt_ib_50_trade_*.html`,
      );
    }

    return { chartPath, outcome };
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

  @Option({ flags: '--dir <path>', description: 'Run one backtest per CSV in this directory (default data/)' })
  parseDir(value: string): string {
    return value;
  }

  @Option({ flags: '--from <date>', description: 'Skip files before this date (YYYY-MM-DD)' })
  parseFrom(value: string): string {
    return value;
  }

  @Option({ flags: '--to <date>', description: 'Skip files after this date (YYYY-MM-DD)' })
  parseTo(value: string): string {
    return value;
  }

  @Option({ flags: '--tz <zone>', description: 'MT5 broker timezone (default Europe/Berlin)' })
  parseTz(value: string): string {
    return value;
  }

  @Option({ flags: '--charts', description: 'Render and open HTML chart audits for all days' })
  parseCharts(): boolean {
    return true;
  }

  @Option({ flags: '--losers', description: 'Render charts and open only losing days' })
  parseLosers(): boolean {
    return true;
  }

  @Option({ flags: '--balance <eur>', description: 'Starting balance (default 10000)' })
  parseBalance(value: string): number {
    return Number.parseFloat(value);
  }
}

function printMultiFileSummary(
  rows: Array<{ file: string; outcome: BacktestOutcome }>,
  initialBalance: number,
): void {
  if (rows.length === 0) return;

  const usd = (dollars: number) =>
    `${dollars >= 0 ? '+' : '-'}$${Math.round(Math.abs(dollars)).toLocaleString('en-US')}`;

  const col = {
    date: 10,
    bars: 5,
    trades: 6,
    wl: 7,
    wr: 7,
    pnl: 9,
    usd: 10,
    dd: 8,
    pf: 7,
  };

  const pad = (s: string, w: number) => s.padStart(w);
  const header = [
    'Date'.padEnd(col.date),
    pad('Bars', col.bars),
    pad('Trades', col.trades),
    pad('W / L', col.wl),
    pad('WinR', col.wr),
    pad('PnL%', col.pnl),
    pad('PnL $', col.usd),
    pad('MaxDD', col.dd),
    pad('PF', col.pf),
  ].join('  ');
  const divider = '-'.repeat(header.length);

  console.log('\n\n=== Multi-file summary ===');
  console.log(divider);
  console.log(header);
  console.log(divider);

  let totalTrades = 0;
  let totalWinners = 0;
  let totalLosers = 0;
  let sumDollars = 0;
  let maxDd = 0;
  let sumPf = 0;
  let pfCount = 0;

  for (const { file, outcome } of rows) {
    const r: BacktestReport = outcome.report;
    const candles = outcome.context.candles('1m');
    const span = BacktestRunnerService.span(candles);
    const dateTag = span ? new Date(span.fromMs).toISOString().slice(0, 10) : file.slice(0, 10);

    const dollars = outcome.finalBalance - initialBalance;
    const portfolioPct = dollars / initialBalance;

    const line = [
      dateTag.padEnd(col.date),
      pad(String(candles.length), col.bars),
      pad(String(r.totalTrades), col.trades),
      pad(`${r.winners} / ${r.losers}`, col.wl),
      pad(r.totalTrades > 0 ? percent1(r.winRate) : '—', col.wr),
      pad(r.totalTrades > 0 ? signedPercent2(portfolioPct) : '—', col.pnl),
      pad(r.totalTrades > 0 ? usd(dollars) : '—', col.usd),
      pad(r.totalTrades > 0 ? percent2(r.maxDrawdownPct) : '—', col.dd),
      pad(r.totalTrades > 0 ? profitFactor(r.profitFactor) : '—', col.pf),
    ].join('  ');
    console.log(line);

    totalTrades += r.totalTrades;
    totalWinners += r.winners;
    totalLosers += r.losers;
    sumDollars += dollars;
    maxDd = Math.max(maxDd, r.maxDrawdownPct);
    if (Number.isFinite(r.profitFactor) && r.totalTrades > 0) {
      sumPf += r.profitFactor;
      pfCount += 1;
    }
  }

  const avgWr = totalTrades > 0 ? totalWinners / totalTrades : 0;
  const avgPf = pfCount > 0 ? sumPf / pfCount : 0;
  const totalPortfolioPct = sumDollars / initialBalance;

  console.log(divider);
  const total = [
    'TOTAL'.padEnd(col.date),
    pad('', col.bars),
    pad(String(totalTrades), col.trades),
    pad(`${totalWinners} / ${totalLosers}`, col.wl),
    pad(totalTrades > 0 ? percent1(avgWr) : '—', col.wr),
    pad(totalTrades > 0 ? signedPercent2(totalPortfolioPct) : '—', col.pnl),
    pad(totalTrades > 0 ? usd(sumDollars) : '—', col.usd),
    pad(totalTrades > 0 ? percent2(maxDd) : '—', col.dd),
    pad(totalTrades > 0 ? profitFactor(avgPf) : '—', col.pf),
  ].join('  ');
  console.log(total);
  console.log(divider);

  printStreaks(rows, initialBalance);
}

function printStreaks(
  rows: Array<{ file: string; outcome: BacktestOutcome }>,
  initialBalance: number,
): void {
  // Flatten to one result per trade (days without trades are skipped).
  const results: Array<{ date: string; won: boolean; dollars: number }> = [];
  for (const { file, outcome } of rows) {
    if (outcome.report.totalTrades === 0) continue;
    const candles = outcome.context.candles('1m');
    const span = BacktestRunnerService.span(candles);
    const date = span ? new Date(span.fromMs).toISOString().slice(0, 10) : file.slice(0, 10);
    const dollars = outcome.finalBalance - initialBalance;
    results.push({ date, won: dollars >= 0, dollars });
  }

  if (results.length === 0) return;

  // Compute all streaks.
  type Streak = { won: boolean; count: number; dollars: number; from: string; to: string };
  const streaks: Streak[] = [];
  let cur: Streak = { won: results[0].won, count: 1, dollars: results[0].dollars, from: results[0].date, to: results[0].date };

  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    if (r.won === cur.won) {
      cur.count += 1;
      cur.dollars += r.dollars;
      cur.to = r.date;
    } else {
      streaks.push(cur);
      cur = { won: r.won, count: 1, dollars: r.dollars, from: r.date, to: r.date };
    }
  }
  streaks.push(cur);

  const winStreaks  = streaks.filter((s) => s.won);
  const lossStreaks = streaks.filter((s) => !s.won);

  const maxWin  = winStreaks.reduce((m, s) => (s.count > m.count ? s : m), winStreaks[0]  ?? { count: 0, dollars: 0, from: '—', to: '—' });
  const maxLoss = lossStreaks.reduce((m, s) => (s.count > m.count ? s : m), lossStreaks[0] ?? { count: 0, dollars: 0, from: '—', to: '—' });

  const last = streaks[streaks.length - 1];
  const currentLabel = last.won ? `+${last.count} winning` : `-${last.count} losing`;

  const usd = (d: number) => `${d >= 0 ? '+' : '-'}$${Math.round(Math.abs(d)).toLocaleString('en-US')}`;

  console.log('\n=== Streak analysis ===');
  console.log(`  Max winning streak : ${maxWin.count} trades   ${usd(maxWin.dollars)}   (${maxWin.from} → ${maxWin.to})`);
  console.log(`  Max losing streak  : ${maxLoss.count} trades   ${usd(maxLoss.dollars)}   (${maxLoss.from} → ${maxLoss.to})`);
  console.log(`  Current streak     : ${currentLabel}   (since ${last.from})`);
  console.log();

  console.log('  All losing streaks:');
  for (const s of lossStreaks) {
    console.log(`    ${s.count} × loss   ${usd(s.dollars).padStart(10)}   ${s.from} → ${s.to}`);
  }
}
