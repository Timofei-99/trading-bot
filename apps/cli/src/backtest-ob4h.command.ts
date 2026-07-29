import { BacktestRunnerService } from '@bot/app/backtest-runner.service';
import { Command, CommandRunner, Option } from 'nest-commander';

import { printBarCounts, printCosts, printReport } from './backtest-output';
import { assertRange, parseInstant } from './parse-time';

interface Ob4hOptions {
  symbol?: string;
  start?: string;
  end?: string;
  window?: number;
  balance?: number;
  risk?: number;
  fee?: number;
  slippage?: number;
  worstCase?: boolean;
  maxDailyDd?: number;
}

/**
 * Replaces `run_backtest.py` and `_run_2025.py`.
 *
 * A fixed preset over the same path `backtest --strategy OB_4h_FVG_15m` takes:
 * Binance, 4h context, 15m base. It exists so the common case is one word, not
 * because it does anything the generic command cannot.
 */
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
    const startMs = parseInstant(options.start ?? '2023-01-01', '--start');
    const endMs = parseInstant(options.end ?? '2024-01-01', '--end');
    assertRange(startMs, endMs);
    const balance = options.balance ?? 10_000;
    const log = (line: string) => console.log(line);

    log(
      `Loading ${symbol} data ${new Date(startMs).toISOString().slice(0, 10)} → ` +
        `${new Date(endMs).toISOString().slice(0, 10)} …`,
    );
    printCosts(options, log);

    const outcome = await this.runner.run({
      strategy: 'OB_4h_FVG_15m',
      data: { source: 'binance', symbol, timeframes: ['4h', '15m'], startMs, endMs },
      engine: { baseTimeframe: '15m', window: options.window ?? 500 },
      account: {
        initialBalance: balance,
        riskPerTrade: options.risk ?? 0.01,
        feeRate: options.fee,
        slippage: options.slippage,
        worstCase: options.worstCase,
        maxDailyDrawdown: options.maxDailyDd,
      },
    });

    printBarCounts(outcome, log);
    printReport(outcome, { symbol, initialBalance: balance, baseTimeframe: '15m' }, log);
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

  @Option({
    flags: '--fee <fraction>',
    description: 'Taker fee per side, e.g. 0.001 for Bybit spot (default 0)',
  })
  parseFee(value: string): number {
    return parseFraction(value, '--fee');
  }

  @Option({
    flags: '--slippage <fraction>',
    description: 'Adverse fill on SL/expiry exits, e.g. 0.0005 (default 0)',
  })
  parseSlippage(value: string): number {
    return parseFraction(value, '--slippage');
  }

  @Option({
    flags: '--worst-case',
    description: 'Resolve a bar that spans both TP and SL against the trade',
  })
  parseWorstCase(): boolean {
    return true;
  }

  @Option({
    flags: '--max-daily-dd <fraction>',
    description: 'Pause entries for the day once realized loss exceeds this, e.g. 0.03',
  })
  parseMaxDailyDd(value: string): number {
    return parseFraction(value, '--max-daily-dd');
  }
}

/** A rate flag must be a small non-negative fraction, not a percentage. */
function parseFraction(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 0.5) {
    throw new Error(`${flag}: expected a fraction in [0, 0.5), got ${JSON.stringify(value)}`);
  }
  return parsed;
}
