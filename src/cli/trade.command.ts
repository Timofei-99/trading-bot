import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { StrategyRegistryService } from '../application/strategy-registry.service';
import { RiskManager } from '../domain/risk-manager';
import { LiveEngine } from '../engine/live.engine';
import {
  describeCredentials,
  loadExchangeCredentials,
} from '../infrastructure/config/exchange-config';
import { BybitAdapter } from '../infrastructure/execution/bybit.adapter';
import { CcxtExchangeClient } from '../infrastructure/execution/exchange-client';
import { NdjsonTradeJournal } from '../infrastructure/journal/ndjson-trade-journal';
import { CcxtCandleRepository } from '../infrastructure/market-data/ccxt-candle.repository';

interface TradeOptions {
  strategy?: string;
  params?: Record<string, unknown>;
  symbol?: string;
  risk?: number;
  fee?: number;
  entryTimeout?: number;
  maxDailyDd?: number;
  journal?: string;
  live?: boolean;
  yes?: boolean;
}

/**
 * Place real orders through Bybit — testnet unless explicitly told otherwise.
 *
 * Going live needs `BYBIT_LIVE=true` in the environment AND `--live` here;
 * either alone is refused, so one forgotten setting can never move real money.
 * Live mode additionally asks for typed confirmation unless `--yes` is given.
 */
@Command({
  name: 'trade',
  description: 'Run a strategy against Bybit (testnet by default; --live needs BYBIT_LIVE too)',
})
export class TradeCommand extends CommandRunner {
  constructor(private readonly registry: StrategyRegistryService) {
    super();
  }

  async run(_args: string[], options: TradeOptions = {}): Promise<void> {
    const credentials = loadExchangeCredentials({ allowLive: options.live });
    const strategyId = options.strategy ?? 'OB_4h_FVG_15m';
    const symbol = options.symbol ?? 'BTC/USDT';

    console.log(`exchange: ${describeCredentials(credentials)}`);
    console.log(`strategy: ${strategyId} on ${symbol}`);

    if (!credentials.sandbox && options.yes !== true && !(await this.confirmLive(symbol))) {
      console.log('aborted');
      return;
    }

    const descriptor = this.registry.describe(strategyId);
    const strategy = this.registry.create(strategyId, options.params ?? {});
    const timeframes = [...descriptor.requiredTimeframes];
    const baseTimeframe = timeframes[timeframes.length - 1];

    const journalPath =
      options.journal ??
      join(
        'data',
        'journal',
        `${credentials.sandbox ? 'testnet' : 'live'}_${strategyId}_${symbol.replace(/\//g, '_')}.ndjson`,
      );
    const journal = new NdjsonTradeJournal(journalPath);
    console.log(`journal: ${journalPath}`);

    const adapter = new BybitAdapter(
      new CcxtExchangeClient({
        exchangeId: credentials.exchangeId,
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        sandbox: credentials.sandbox,
        category: credentials.category,
      }),
      {
        symbol,
        riskPerTrade: options.risk ?? 0.01,
        feeRate: options.fee ?? 0.001,
        entryTimeoutMs: (options.entryTimeout ?? 60) * 60_000,
        journal,
        log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
      },
    );

    // Reconciles the journal against the venue before anything is placed.
    await adapter.start(Date.now());

    const engine = new LiveEngine(
      new CcxtCandleRepository({ exchangeId: credentials.exchangeId }),
      strategy,
      adapter,
      {
        symbol,
        timeframes,
        baseTimeframe,
        window: 500,
        riskManager:
          options.maxDailyDd === undefined
            ? undefined
            : new RiskManager(options.risk ?? 0.01, options.maxDailyDd),
        log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
      },
    );

    process.once('SIGINT', () => {
      console.log('\nstopping — open orders and positions are LEFT AS THEY ARE at the venue');
      engine.stop();
    });

    await engine.start();
  }

  private async confirmLive(symbol: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\n*** LIVE TRADING — this will spend real funds ***');
      const answer = await prompt.question(`Type the symbol (${symbol}) to confirm: `);
      return answer.trim() === symbol;
    } finally {
      prompt.close();
    }
  }

  @Option({ flags: '--strategy <id>', description: 'Strategy id (see `strategies`)' })
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

  @Option({ flags: '--symbol <symbol>', description: 'Market symbol (default BTC/USDT)' })
  parseSymbol(value: string): string {
    return value;
  }

  @Option({ flags: '--risk <fraction>', description: 'Risk per trade (default 0.01)' })
  parseRisk(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--fee <fraction>', description: 'Taker fee per side (default 0.001)' })
  parseFee(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({
    flags: '--entry-timeout <minutes>',
    description: 'Cancel an unfilled entry after this long (default 60)',
  })
  parseEntryTimeout(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({
    flags: '--max-daily-dd <fraction>',
    description: 'Pause entries for the day once realized loss exceeds this',
  })
  parseMaxDailyDd(value: string): number {
    return Number.parseFloat(value);
  }


  @Option({ flags: '--journal <path>', description: 'Journal file (default data/journal/…)' })
  parseJournal(value: string): string {
    return value;
  }

  @Option({
    flags: '--live',
    description: 'Trade real funds (also needs BYBIT_LIVE=true in the environment)',
  })
  parseLive(): boolean {
    return true;
  }

  @Option({ flags: '--yes', description: 'Skip the live-trading confirmation prompt' })
  parseYes(): boolean {
    return true;
  }
}
