import { Command, CommandRunner, Option } from 'nest-commander';

import { BacktestRunnerService } from '@bot/app/backtest-runner.service';
import { StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { printBarCounts, printCosts, printReport, printTrades } from './backtest-output';
import { assertRange, parseInstant } from './parse-time';

interface BacktestOptions {
  strategy?: string;
  params?: Record<string, unknown>;
  symbol?: string;
  source?: 'binance' | 'yahoo' | 'mt5';
  csv?: string;
  tz?: string;
  timeframes?: string[];
  base?: string;
  start?: string;
  end?: string;
  window?: number;
  balance?: number;
  risk?: number;
  fee?: number;
  slippage?: number;
  worstCase?: boolean;
  maxDailyDd?: number;
  trades?: boolean;
}

/**
 * Backtest ANY registered strategy.
 *
 * The `backtest:*` commands are fixed presets for the bundled strategies;
 * this one takes a strategy id, which is what a strategy you wrote yourself
 * needs. Timeframes default to the ones the strategy declared in the
 * registry, so the usual invocation is just `--strategy <id> --fee 0.001`.
 */
@Command({
  name: 'backtest',
  description: 'Backtest any registered strategy by id (see `strategies`)',
})
export class BacktestCommand extends CommandRunner {
  constructor(
    private readonly runner: BacktestRunnerService,
    private readonly registry: StrategyRegistryService,
  ) {
    super();
  }

  async run(_args: string[], options: BacktestOptions = {}): Promise<void> {
    if (options.strategy === undefined) {
      console.log('--strategy is required. Known strategies:');
      for (const descriptor of this.registry.list()) {
        console.log(`  ${descriptor.id}  (${descriptor.requiredTimeframes.join(', ')})`);
      }
      return;
    }

    const descriptor = this.registry.describe(options.strategy);
    const timeframes = options.timeframes ?? [...descriptor.requiredTimeframes];
    // The base timeframe drives the loop; the finest one is the sensible
    // default, and the registry lists them coarse-to-fine.
    const baseTimeframe = options.base ?? timeframes[timeframes.length - 1];
    const source = options.source ?? (options.csv === undefined ? 'binance' : 'mt5');

    const startMs =
      source === 'mt5'
        ? Number.NEGATIVE_INFINITY
        : parseInstant(options.start ?? '2023-01-01', '--start');
    const endMs =
      source === 'mt5'
        ? Number.POSITIVE_INFINITY
        : parseInstant(options.end ?? '2024-01-01', '--end');
    if (source !== 'mt5') {
      assertRange(startMs, endMs);
    }

    const symbol = options.symbol ?? defaultSymbol(source, descriptor.defaultParams);
    const balance = options.balance ?? 10_000;

    console.log(`strategy : ${descriptor.id} v${descriptor.version}`);
    console.log(`data     : ${source} ${symbol} [${timeframes.join(', ')}], base ${baseTimeframe}`);
    printCosts(options, (line) => console.log(line));

    const outcome = await this.runner.run({
      strategy: descriptor.id,
      strategyParams: options.params,
      data: {
        source,
        symbol,
        timeframes,
        startMs,
        endMs,
        csvPath: options.csv,
        sourceTz: options.tz,
      },
      engine: { baseTimeframe, window: options.window ?? 500 },
      account: {
        initialBalance: balance,
        riskPerTrade: options.risk ?? 0.01,
        feeRate: options.fee,
        slippage: options.slippage,
        worstCase: options.worstCase,
        maxDailyDrawdown: options.maxDailyDd,
      },
    });

    printBarCounts(outcome, (line) => console.log(line));
    printReport(outcome, { symbol, initialBalance: balance, baseTimeframe }, (line) =>
      console.log(line),
    );

    if (options.trades === true) {
      printTrades(outcome, (line) => console.log(line));
    }
  }

  @Option({ flags: '--strategy <id>', description: 'Strategy id — see `strategies`' })
  parseStrategy(value: string): string {
    return value;
  }

  @Option({ flags: '--params <json>', description: 'Strategy parameter overrides as JSON' })
  parseParams(value: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--params: expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  @Option({ flags: '--symbol <symbol>', description: 'Market symbol' })
  parseSymbol(value: string): string {
    return value;
  }

  @Option({
    flags: '--source <name>',
    description: 'binance (default) | yahoo | mt5',
  })
  parseSource(value: string): 'binance' | 'yahoo' | 'mt5' {
    if (value !== 'binance' && value !== 'yahoo' && value !== 'mt5') {
      throw new Error(`--source: expected binance, yahoo or mt5, got ${JSON.stringify(value)}`);
    }
    return value;
  }

  @Option({ flags: '--csv <path>', description: 'MT5 export path (implies --source mt5)' })
  parseCsv(value: string): string {
    return value;
  }

  @Option({ flags: '--tz <zone>', description: 'Broker timezone for an MT5 export' })
  parseTz(value: string): string {
    return value;
  }

  @Option({
    flags: '--timeframes <list>',
    description: 'Comma-separated override, e.g. 4h,15m (default: what the strategy declares)',
  })
  parseTimeframes(value: string): string[] {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }

  @Option({
    flags: '--base <tf>',
    description: 'Timeframe the loop iterates (default: the finest)',
  })
  parseBase(value: string): string {
    return value;
  }

  @Option({ flags: '--start <iso>', description: 'Range start (default 2023-01-01)' })
  parseStart(value: string): string {
    return value;
  }

  @Option({ flags: '--end <iso>', description: 'Range end (default 2024-01-01)' })
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

  @Option({ flags: '--fee <fraction>', description: 'Taker fee per side, e.g. 0.001 (default 0)' })
  parseFee(value: string): number {
    return parseFraction(value, '--fee');
  }

  @Option({ flags: '--slippage <fraction>', description: 'Adverse fill on SL/expiry (default 0)' })
  parseSlippage(value: string): number {
    return parseFraction(value, '--slippage');
  }

  @Option({ flags: '--worst-case', description: 'Resolve TP+SL bars against the trade' })
  parseWorstCase(): boolean {
    return true;
  }

  @Option({
    flags: '--max-daily-dd <fraction>',
    description: 'Pause entries for the day once realized loss exceeds this',
  })
  parseMaxDailyDd(value: string): number {
    return parseFraction(value, '--max-daily-dd');
  }

  @Option({ flags: '--trades', description: 'Print every trade, not just the summary' })
  parseTrades(): boolean {
    return true;
  }
}

function parseFraction(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 0.5) {
    throw new Error(`${flag}: expected a fraction in [0, 0.5), got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Strategies that name their own instrument (forex) win over the crypto default. */
function defaultSymbol(source: string, defaults: Readonly<Record<string, unknown>>): string {
  if (typeof defaults.symbol === 'string') {
    return defaults.symbol;
  }
  return source === 'yahoo' ? 'EURUSD=X' : 'BTC/USDT';
}
