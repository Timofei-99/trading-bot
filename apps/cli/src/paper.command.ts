import { join } from 'node:path';

import { Command, CommandRunner, Option } from 'nest-commander';

import { StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { KillSwitch } from '@bot/core/domain/kill-switch';
import { RiskManager } from '@bot/core/domain/risk-manager';
import { Trade } from '@bot/core/domain/trade';
import { LiveEngine } from '@bot/core/engine/live.engine';
import { PaperAdapter } from '@bot/core/execution/paper.adapter';
import { CcxtCandleRepository } from '@bot/infra/market-data/ccxt-candle.repository';
import { NdjsonTradeJournal } from '@bot/infra/journal/ndjson-trade-journal';

interface PaperOptions {
  strategy?: string;
  params?: Record<string, unknown>;
  symbol?: string;
  exchange?: string;
  balance?: number;
  risk?: number;
  fee?: number;
  slippage?: number;
  worstCase?: boolean;
  entryTimeout?: number;
  maxDailyDd?: number;
  maxLosses?: number;
  journal?: string;
  once?: boolean;
}

/**
 * Dry-run: the injected strategy runs on LIVE exchange data with simulated
 * fills — freqtrade's dry_run, and the mandatory step between a backtest and
 * money. Public market data only; no API keys involved.
 *
 * State survives restarts through the journal: stop the bot mid-position,
 * start it again, and it resumes with the same balance, resting order and
 * open position.
 */
@Command({
  name: 'paper',
  description: 'Run a strategy on live exchange data with simulated fills (no keys, no money)',
})
export class PaperCommand extends CommandRunner {
  constructor(private readonly registry: StrategyRegistryService) {
    super();
  }

  async run(_args: string[], options: PaperOptions = {}): Promise<void> {
    const strategyId = options.strategy ?? 'OB_4h_FVG_15m';
    const symbol = options.symbol ?? 'BTC/USDT';
    const exchange = options.exchange ?? 'bybit';

    const descriptor = this.registry.describe(strategyId);
    const strategy = this.registry.create(strategyId, options.params ?? {});
    const timeframes = [...descriptor.requiredTimeframes];
    const baseTimeframe = timeframes[timeframes.length - 1];

    const journalPath =
      options.journal ??
      join('data', 'journal', `paper_${strategyId}_${symbol.replace(/\//g, '_')}.ndjson`);
    const journal = new NdjsonTradeJournal(journalPath);
    const hadHistory = journal.readAll().length > 0;

    const adapter = PaperAdapter.restore({
      initialBalance: options.balance ?? 10_000,
      riskPerTrade: options.risk ?? 0.01,
      feeRate: options.fee ?? 0.001, // paper defaults to REALISTIC costs
      slippage: options.slippage ?? 0,
      worstCase: options.worstCase ?? false,
      entryTimeoutMs: (options.entryTimeout ?? 60) * 60_000,
      journal,
    });
    journal.append({
      type: 'session',
      at: Date.now(),
      note: hadHistory ? 'resume' : 'start',
      balance: adapter.balance,
    });

    console.log(`paper: ${strategyId} on ${exchange} ${symbol} (${timeframes.join(', ')})`);
    console.log(`journal: ${journalPath}${hadHistory ? ' (state restored)' : ''}`);
    if (hadHistory) {
      await this.printState(adapter, symbol);
    }

    const engine = new LiveEngine(
      new CcxtCandleRepository({ exchangeId: exchange }),
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
        log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
      },
    );

    if (options.once === true) {
      await engine.warmup(Date.now());
      const tick = await engine.tick(Date.now());
      console.log(
        tick.processedBar === null
          ? 'tick: no newly closed bar to process'
          : `tick: processed bar ${new Date(tick.processedBar).toISOString()}`,
      );
      await this.printState(adapter, symbol);
      return;
    }

    process.once('SIGINT', () => {
      console.log('\nstopping…');
      engine.stop();
      void this.printState(adapter, symbol).then(() => process.exit(0));
    });

    await engine.start();
    await this.printState(adapter, symbol);
  }

  private async printState(adapter: PaperAdapter, symbol: string): Promise<void> {
    console.log(`balance: ${adapter.balance.toFixed(2)}`);

    const resting = await adapter.getRestingEntry(symbol);
    if (resting !== null) {
      console.log(
        `resting entry: ${resting.signal.direction} @ ${resting.signal.entry} ` +
          `(placed ${new Date(resting.placedAt).toISOString()})`,
      );
    }
    const position = await adapter.getPosition(symbol);
    if (position !== null) {
      console.log(
        `open position: ${position.signal.direction} @ ${position.entryPrice} ` +
          `(sl ${position.signal.stopLoss}, tp ${position.signal.takeProfit})`,
      );
    }

    const closed = await adapter.getClosedTrades();
    console.log(`closed trades: ${closed.length}`);
    for (const trade of closed.slice(-3)) {
      console.log(`  ${formatTrade(trade)}`);
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

  @Option({ flags: '--exchange <id>', description: 'ccxt exchange id (default bybit)' })
  parseExchange(value: string): string {
    return value;
  }

  @Option({ flags: '--balance <usd>', description: 'Paper balance (default 10000)' })
  parseBalance(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--risk <fraction>', description: 'Risk per trade (default 0.01)' })
  parseRisk(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--fee <fraction>', description: 'Taker fee per side (default 0.001)' })
  parseFee(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--slippage <fraction>', description: 'Adverse fill on SL/expiry (default 0)' })
  parseSlippage(value: string): number {
    return Number.parseFloat(value);
  }

  @Option({ flags: '--worst-case', description: 'Resolve TP+SL bars against the trade' })
  parseWorstCase(): boolean {
    return true;
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

  @Option({ flags: '--once', description: 'Warm up, process one tick, print state and exit' })
  parseOnce(): boolean {
    return true;
  }
}

function formatTrade(trade: Trade): string {
  const pnl = ((trade.pnlPct ?? 0) * 100).toFixed(3);
  return (
    `${new Date(trade.entryTime).toISOString()} ${trade.signal.direction} ` +
    `@ ${trade.entryPrice} → ${trade.exitReason} @ ${trade.exitPrice} (${pnl}%)`
  );
}
