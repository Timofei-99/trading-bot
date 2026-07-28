import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { BacktestRequest } from '../application/backtest-runner.service';
import { RunRecord, RunRegistryService } from '../application/run-registry.service';
import { Trade } from '../domain/trade';
import { BacktestRequestDto } from './dto/backtest-request.dto';

interface RunSummary {
  id: string;
  status: string;
  strategy: string;
  symbol: string;
  createdAt: string;
  finishedAt: string | null;
  report: Record<string, unknown> | null;
  finalBalance: number | null;
  error: string | null;
}

@Controller('backtests')
export class BacktestsController {
  constructor(private readonly runs: RunRegistryService) {}

  /**
   * Accepts the run and returns immediately.
   *
   * A year of 15m bars takes a few seconds to replay, which is too long to
   * hold a request open and too short to justify a queue, so the run continues
   * in the background and the client polls.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Body() dto: BacktestRequestDto): { id: string; status: string } {
    const record = this.runs.submit(toDomainRequest(dto));
    return { id: record.id, status: record.status };
  }

  @Get()
  list(): RunSummary[] {
    return this.runs.list().map(summarize);
  }

  @Get(':id')
  get(@Param('id') id: string): RunSummary {
    return summarize(this.require(id));
  }

  @Get(':id/trades')
  trades(@Param('id') id: string): Record<string, unknown>[] {
    const record = this.require(id);
    return [...record.trades, ...record.openTrades].map(serializeTrade);
  }

  private require(id: string): RunRecord {
    const record = this.runs.get(id);
    if (record === null) {
      throw new NotFoundException(`No backtest run with id ${id}`);
    }
    return record;
  }
}

function toDomainRequest(dto: BacktestRequestDto): BacktestRequest {
  return {
    strategy: dto.strategy,
    strategyParams: dto.strategyParams,
    data: {
      source: dto.data.source,
      symbol: dto.data.symbol,
      timeframes: dto.data.timeframes,
      startMs: Date.parse(dto.data.start),
      endMs: Date.parse(dto.data.end),
      csvPath: dto.data.csvPath,
      sourceTz: dto.data.sourceTz,
    },
    engine: dto.engine,
    account: dto.account,
  };
}

function summarize(record: RunRecord): RunSummary {
  return {
    id: record.id,
    status: record.status,
    strategy: record.request.strategy,
    symbol: record.request.data.symbol,
    createdAt: new Date(record.createdAtMs).toISOString(),
    finishedAt: record.finishedAtMs === null ? null : new Date(record.finishedAtMs).toISOString(),
    report:
      record.report === null
        ? null
        : {
            ...record.report,
            profitFactor: Number.isFinite(record.report.profitFactor)
              ? record.report.profitFactor
              : 'inf',
          },
    finalBalance: record.finalBalance,
    // A failure reason, not the raw exception text: `error.message` can carry
    // filesystem paths and parsed file content, and this field crosses the
    // HTTP boundary. The full message stays in the server log.
    error: record.error === null ? null : summarizeError(record.error),
  };
}

const KNOWN_FAILURES: readonly [RegExp, string][] = [
  [/^Unknown strategy:/, 'unknown strategy'],
  [/^Unknown timeframe:/, 'unknown timeframe'],
  [/needs csvPath/, 'this data source needs csvPath'],
  [/^Unsupported timeframe for Yahoo Finance/, 'timeframe not supported by this data source'],
  [/^No candles loaded/, 'no candles loaded for the base timeframe'],
  [/MT5 export|MT5 timestamp/, 'could not parse the MT5 export'],
  [/^Unknown ccxt exchange:/, 'unknown exchange'],
  [/ENOENT|no such file/, 'input file not found'],
  [/EACCES|permission denied/, 'input file not readable'],
];

function summarizeError(message: string): string {
  for (const [pattern, summary] of KNOWN_FAILURES) {
    if (pattern.test(message)) {
      return summary;
    }
  }
  return 'backtest failed; see server logs';
}

function serializeTrade(trade: Trade): Record<string, unknown> {
  return {
    orderId: trade.orderId,
    entryTime: new Date(trade.entryTime).toISOString(),
    entryPrice: trade.entryPrice,
    positionSize: trade.positionSize,
    exitTime: trade.exitTime === null ? null : new Date(trade.exitTime).toISOString(),
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlPct: trade.pnlPct,
    pnlR: trade.pnlR,
    isWinner: trade.isWinner,
    signal: {
      symbol: trade.signal.symbol,
      direction: trade.signal.direction,
      entry: trade.signal.entry,
      stopLoss: trade.signal.stopLoss,
      takeProfit: trade.signal.takeProfit,
      timeframe: trade.signal.timeframe,
      timestamp: new Date(trade.signal.timestamp).toISOString(),
      strategyName: trade.signal.strategyName,
      strategyVersion: trade.signal.strategyVersion,
      triggeredBy: trade.signal.triggeredBy,
      meta: trade.signal.meta,
      expiryTime:
        trade.signal.expiryTime === null ? null : new Date(trade.signal.expiryTime).toISOString(),
    },
  };
}
