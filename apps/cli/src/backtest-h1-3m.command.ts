import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '@bot/app/backtest-runner.service';
import { formatBacktestReport } from './report-format';

interface H1m3mOptions {
  ticker?: string;
  days?: number;
  balance?: number;
  risk?: number;
}

const DAY_MS = 86_400_000;

/** Replaces `run_backtest_1h3m.py`. */
@Command({
  name: 'backtest:h1-3m',
  description: 'Backtest 1h3m_classic on forex data from Yahoo Finance',
})
export class BacktestH1m3mCommand extends CommandRunner {
  constructor(private readonly runner: BacktestRunnerService) {
    super();
  }

  async run(_args: string[], options: H1m3mOptions = {}): Promise<void> {
    const ticker = options.ticker ?? 'EURUSD=X';
    // Yahoo serves at most 60 days of 5m bars; 58 leaves room for the request
    // to straddle a day boundary.
    const days = options.days ?? 58;
    const balance = options.balance ?? 10_000;

    const endMs = Date.now();
    const startMs = endMs - days * DAY_MS;

    console.log(`Loading ${ticker} data …`);
    console.log(
      `  1h : ${new Date(endMs - 120 * DAY_MS).toISOString().slice(0, 10)} → ` +
        `${new Date(endMs).toISOString().slice(0, 10)}`,
    );
    console.log(
      `  5m : ${new Date(startMs).toISOString().slice(0, 10)} → ` +
        `${new Date(endMs).toISOString().slice(0, 10)}`,
    );

    const outcome = await this.runner.run({
      strategy: '1h3m_classic',
      strategyParams: { symbol: ticker },
      data: { source: 'yahoo', symbol: ticker, timeframes: ['1h', '5m'], startMs, endMs },
      engine: { baseTimeframe: '5m', window: 500 },
      account: { initialBalance: balance, riskPerTrade: options.risk ?? 0.01 },
    });

    console.log(`\nRunning backtest on 5m bars (${outcome.barsByTimeframe['5m']} bars) …`);
    console.log(
      formatBacktestReport(
        {
          symbol: ticker,
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

  @Option({ flags: '--ticker <symbol>', description: 'Yahoo ticker (default EURUSD=X)' })
  parseTicker(value: string): string {
    return value;
  }

  @Option({ flags: '--days <n>', description: 'Days of 5m history (default 58, Yahoo caps at 60)' })
  parseDays(value: string): number {
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
