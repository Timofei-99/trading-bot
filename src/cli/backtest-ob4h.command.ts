import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '../application/backtest-runner.service';
import { formatBacktestReport } from './report-format';

interface Ob4hOptions {
  symbol?: string;
  start?: string;
  end?: string;
  window?: number;
  balance?: number;
  risk?: number;
}

/** Replaces `run_backtest.py` and `_run_2025.py`. */
@Command({
  name: 'backtest:ob4h',
  description: 'Backtest OB_4h_FVG_15m on crypto (Binance, cache-first)',
})
export class BacktestOb4hCommand extends CommandRunner {
  constructor(private readonly runner: BacktestRunnerService) {
    super();
  }

  async run(_args: string[], options: Ob4hOptions = {}): Promise<void> {
    const symbol = options.symbol ?? 'BTC/USDT';
    const startMs = Date.parse(options.start ?? '2023-01-01T00:00:00Z');
    const endMs = Date.parse(options.end ?? '2024-01-01T00:00:00Z');
    const balance = options.balance ?? 10_000;

    console.log(
      `Loading ${symbol} data ${new Date(startMs).toISOString().slice(0, 10)} → ` +
        `${new Date(endMs).toISOString().slice(0, 10)} …`,
    );

    const outcome = await this.runner.run({
      strategy: 'OB_4h_FVG_15m',
      data: { source: 'binance', symbol, timeframes: ['4h', '15m'], startMs, endMs },
      engine: { baseTimeframe: '15m', window: options.window ?? 500 },
      account: { initialBalance: balance, riskPerTrade: options.risk ?? 0.01 },
    });

    for (const [timeframe, count] of Object.entries(outcome.barsByTimeframe)) {
      const span = BacktestRunnerService.span(outcome.context.candles(timeframe));
      const range =
        span === null
          ? ''
          : `  (${new Date(span.fromMs).toISOString().slice(0, 10)} – ${new Date(span.toMs)
              .toISOString()
              .slice(0, 10)})`;
      console.log(`  ${timeframe}: ${count} bars${range}`);
    }

    console.log(
      formatBacktestReport(
        {
          symbol,
          strategyName: outcome.strategy.name,
          strategyVersion: outcome.strategy.version,
          initialBalance: balance,
          fromMs: startMs,
          toMs: endMs,
        },
        outcome.report,
      ),
    );
  }

  @Option({ flags: '--symbol <symbol>', description: 'Trading pair (default BTC/USDT)' })
  parseSymbol(value: string): string {
    return value;
  }

  @Option({ flags: '--start <iso>', description: 'Range start, ISO date (default 2023-01-01)' })
  parseStart(value: string): string {
    return value;
  }

  @Option({ flags: '--end <iso>', description: 'Range end, ISO date (default 2024-01-01)' })
  parseEnd(value: string): string {
    return value;
  }

  @Option({ flags: '--window <bars>', description: 'Rolling context window (default 500)' })
  parseWindow(value: string): number {
    return Number.parseInt(value, 10);
  }

  @Option({ flags: '--balance <usd>', description: 'Starting balance (default 10000)' })
  parseBalance(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--risk <fraction>', description: 'Risk per trade (default 0.01)' })
  parseRisk(value: string): number {
    return Number.parseFloat(value);
  }
}
