import { Injectable } from '@nestjs/common';

import { CandleSeries } from '../domain/candle-series';
import { MarketContext } from '../domain/market-context';
import { Strategy } from '../domain/ports';
import { Trade } from '../domain/trade';
import { BacktestEngine } from '../engine/backtest.engine';
import { BacktestAdapter, BacktestReport } from '../execution/backtest.adapter';
import { CandleSourceService } from './candle-source.service';
import { StrategyRegistryService } from './strategy-registry.service';

export interface BacktestDataRequest {
  /** `binance` (ccxt, cache-first), `yahoo`, or `mt5` for a broker CSV. */
  readonly source: 'binance' | 'yahoo' | 'mt5';
  readonly symbol: string;
  readonly timeframes: string[];
  readonly startMs: number;
  readonly endMs: number;
  /** MT5 only. */
  readonly csvPath?: string;
  readonly sourceTz?: string;
}

export interface BacktestRequest {
  readonly strategy: string;
  readonly strategyParams?: Record<string, unknown>;
  readonly data: BacktestDataRequest;
  readonly engine?: { readonly baseTimeframe?: string; readonly window?: number };
  readonly account?: { readonly initialBalance?: number; readonly riskPerTrade?: number };
}

export interface BacktestOutcome {
  readonly strategy: Strategy;
  readonly context: MarketContext;
  readonly report: BacktestReport;
  readonly trades: Trade[];
  readonly openTrades: Trade[];
  readonly finalBalance: number;
  readonly baseTimeframe: string;
  readonly barsByTimeframe: Record<string, number>;
}

/**
 * The one place a backtest is assembled.
 *
 * In the Python code this sequence — load a context, build the strategy, run
 * the engine, format the report — was copied into five `run_*.py` scripts that
 * had drifted apart. Keeping it here means the CLI and the HTTP API run
 * exactly the same thing.
 */
@Injectable()
export class BacktestRunnerService {
  constructor(
    private readonly strategies: StrategyRegistryService,
    private readonly candles: CandleSourceService,
  ) {}

  async run(request: BacktestRequest): Promise<BacktestOutcome> {
    const descriptor = this.strategies.describe(request.strategy);
    const timeframes =
      request.data.timeframes.length > 0
        ? request.data.timeframes
        : [...descriptor.requiredTimeframes];

    const context = new MarketContext(request.data.symbol, timeframes, 1_000_000);
    const barsByTimeframe: Record<string, number> = {};

    for (const timeframe of timeframes) {
      const series = await this.candles.load({ ...request.data, timeframes }, timeframe);
      context.load(timeframe, series);
      barsByTimeframe[timeframe] = series.length;
    }

    const baseTimeframe = request.engine?.baseTimeframe ?? timeframes[timeframes.length - 1];
    const base = context.candles(baseTimeframe);
    if (base.isEmpty) {
      throw new Error(`No candles loaded for the base timeframe ${baseTimeframe}`);
    }

    const strategy = this.strategies.create(request.strategy, request.strategyParams ?? {});
    const adapter = new BacktestAdapter({
      initialBalance: request.account?.initialBalance ?? 10_000,
      riskPerTrade: request.account?.riskPerTrade ?? 0.01,
    });

    const report = new BacktestEngine(context, strategy, adapter, {
      window: request.engine?.window ?? 500,
    }).run(baseTimeframe);

    return {
      strategy,
      context,
      report,
      trades: adapter.trades,
      openTrades: adapter.openTrades,
      finalBalance: adapter.balance,
      baseTimeframe,
      barsByTimeframe,
    };
  }

  static span(series: CandleSeries): { fromMs: number; toMs: number } | null {
    if (series.isEmpty) {
      return null;
    }
    return { fromMs: series.firstTime as number, toMs: series.lastTime as number };
  }
}
