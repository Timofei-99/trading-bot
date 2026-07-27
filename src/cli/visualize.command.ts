import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '../application/backtest-runner.service';
import { ReportService } from '../application/report.service';
import { FvgDetector } from '../detectors/fvg.detector';
import { KillzoneDetector } from '../detectors/killzone.detector';
import { LiquidityDetector } from '../detectors/liquidity.detector';
import { OrderBlockDetector } from '../detectors/order-block.detector';
import { PremiumDiscountDetector } from '../detectors/premium-discount.detector';
import { StructureDetector } from '../detectors/structure.detector';
import { Pattern } from '../domain/pattern';
import { renderChart } from '../infrastructure/visualization/chart.renderer';
import { renderTrade } from '../infrastructure/visualization/trade-chart.renderer';

interface VisualizeOptions {
  symbol?: string;
  start?: string;
  end?: string;
  chartMonth?: string;
  top?: number;
}

/** Replaces `run_visualization.py` and `run_ib_preview.py`. */
@Command({
  name: 'visualize',
  description: 'Run OB_4h_FVG_15m and render an annotated chart plus trade audits',
})
export class VisualizeCommand extends CommandRunner {
  constructor(
    private readonly runner: BacktestRunnerService,
    private readonly reports: ReportService,
  ) {
    super();
  }

  async run(_args: string[], options: VisualizeOptions = {}): Promise<void> {
    const symbol = options.symbol ?? 'BTC/USDT';
    const startMs = Date.parse(options.start ?? '2023-01-01T00:00:00Z');
    const endMs = Date.parse(options.end ?? '2023-04-01T00:00:00Z');
    const top = options.top ?? 3;

    console.log(
      `Loading ${symbol} data ${new Date(startMs).toISOString().slice(0, 10)} → ` +
        `${new Date(endMs).toISOString().slice(0, 10)} …`,
    );

    const outcome = await this.runner.run({
      strategy: 'OB_4h_FVG_15m',
      data: { source: 'binance', symbol, timeframes: ['4h', '15m'], startMs, endMs },
      engine: { baseTimeframe: '15m', window: 500 },
      account: { initialBalance: 10_000 },
    });

    console.log(
      `  total trades: ${outcome.report.totalTrades}, ` +
        `win rate: ${(outcome.report.winRate * 100).toFixed(1)}%`,
    );

    const htf = outcome.context.candles('4h');
    const patterns: Pattern[] = [
      ...new OrderBlockDetector({ timeframe: '4h' }).detect(htf),
      ...new PremiumDiscountDetector({ timeframe: '4h' }).detect(htf),
      ...new StructureDetector({ timeframe: '4h' }).detect(htf),
      ...new LiquidityDetector({ timeframe: '4h' }).detect(htf),
      ...new FvgDetector({ timeframe: '4h' }).detect(htf),
      ...new KillzoneDetector({ timeframe: '4h' }).detect(htf),
    ];
    console.log(`\nDetected ${patterns.length} 4h patterns`);

    const month = options.chartMonth ?? '2023-02';
    const chartStart = Date.parse(`${month}-01T00:00:00Z`);
    const chartEnd = new Date(chartStart);
    chartEnd.setUTCMonth(chartEnd.getUTCMonth() + 1);

    const chartPath = join(
      this.reports.ensureDir(),
      `chart_${month.replace('-', '_')}.html`,
    );
    renderChart({
      context: outcome.context,
      timeframe: '4h',
      patterns,
      trades: outcome.trades,
      startMs: chartStart,
      endMs: chartEnd.getTime(),
      title: `${symbol} 4h — ${month} — ${outcome.strategy.name}`,
      savePath: chartPath,
    });
    console.log(`  → wrote ${chartPath}`);

    const closed = outcome.trades.filter((trade) => trade.pnlPct !== null);
    if (closed.length === 0) {
      console.log('\nNo closed trades — skipping trade audits');
      return;
    }

    const ranked = [...closed]
      .sort((a, b) => Math.abs(b.pnlPct as number) - Math.abs(a.pnlPct as number))
      .slice(0, top);

    console.log(`\nRendering top ${ranked.length} trades by |PnL %|:`);
    ranked.forEach((trade, i) => {
      const tag = ReportService.pnlTag(trade.pnlPct, 1);
      const filename = `trade_${i + 1}_${symbol.replace('/', '_')}_${tag}.html`;
      renderTrade({
        trade,
        context: outcome.context,
        htf: '4h',
        ltf: '15m',
        barsBefore: 100,
        barsAfter: 50,
        savePath: join(this.reports.reportsDir, filename),
      });
      const pnl = (trade.pnlPct as number) * 100;
      console.log(
        `  #${i + 1}  entry ${new Date(trade.entryTime).toISOString()}  ` +
          `PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%  → ${filename}`,
      );
    });
  }

  @Option({ flags: '--symbol <symbol>', description: 'Trading pair (default BTC/USDT)' })
  parseSymbol(value: string): string {
    return value;
  }

  @Option({ flags: '--start <iso>', description: 'Range start (default 2023-01-01)' })
  parseStart(value: string): string {
    return value;
  }

  @Option({ flags: '--end <iso>', description: 'Range end (default 2023-04-01)' })
  parseEnd(value: string): string {
    return value;
  }

  @Option({ flags: '--chart-month <YYYY-MM>', description: 'Month to chart (default 2023-02)' })
  parseChartMonth(value: string): string {
    return value;
  }

  @Option({ flags: '--top <n>', description: 'Trade audits to render (default 3)' })
  parseTop(value: string): number {
    return Number.parseInt(value, 10);
  }
}
