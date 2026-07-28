import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { KillSwitch } from '@bot/core/domain/kill-switch';
import { RiskManager } from '@bot/core/domain/risk-manager';
import { LiveEngine } from '@bot/core/engine/live.engine';
import { LoggedExchangeClient } from '@bot/infra/execution/logged-exchange-client';
import { StructuredLogger } from '@bot/infra/logging/structured-logger';
import { describeCredentials, loadExchangeCredentials } from '@bot/infra/config/exchange-config';
import { BybitAdapter } from '@bot/infra/execution/bybit.adapter';
import { CcxtExchangeClient } from '@bot/infra/execution/exchange-client';
import { NdjsonTradeJournal } from '@bot/infra/journal/ndjson-trade-journal';
import { CcxtCandleRepository } from '@bot/infra/market-data/ccxt-candle.repository';

interface TradeOptions {
  strategy?: string;
  params?: Record<string, unknown>;
  symbol?: string;
  risk?: number;
  fee?: number;
  entryTimeout?: number;
  maxDailyDd?: number;
  maxLosses?: number;
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

    // Every exchange call and its outcome are written down; secrets are
    // redacted by the logger, not by the caller.
    const logger = new StructuredLogger({
      filePath: journalPath.replace(/\.ndjson$/, '.log.ndjson'),
      base: { symbol, strategy: strategyId, mode: credentials.sandbox ? 'testnet' : 'live' },
    });

    const adapter = new BybitAdapter(
      new LoggedExchangeClient(
        new CcxtExchangeClient({
          exchangeId: credentials.exchangeId,
          apiKey: credentials.apiKey,
          secret: credentials.secret,
          sandbox: credentials.sandbox,
          category: credentials.category,
        }),
        logger,
      ),
      {
        symbol,
        riskPerTrade: options.risk ?? 0.01,
        feeRate: options.fee ?? 0.001,
        entryTimeoutMs: (options.entryTimeout ?? 60) * 60_000,
        journal,
        log: (line) => {
          console.log(`[${new Date().toISOString()}] ${line}`);
          logger.info(line);
        },
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
        killSwitch:
          options.maxDailyDd === undefined && options.maxLosses === undefined
            ? undefined
            : new KillSwitch({
                maxDailyDrawdown: options.maxDailyDd,
                maxConsecutiveLosses: options.maxLosses,
              }),
        journal,
        log: (line) => {
          console.log(`[${new Date().toISOString()}] ${line}`);
          logger.info(line);
        },
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
    description: 'Halt trading once the day realized this much loss, e.g. 0.03',
  })
  parseMaxDailyDd(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({
    flags: '--max-losses <count>',
    description: 'Halt trading after this many consecutive losing trades',
  })
  parseMaxLosses(value: string): number {
    return Number.parseInt(value, 10);
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
