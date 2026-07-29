import { BacktestOutcome, BacktestRunnerService } from '@bot/app/backtest-runner.service';

import { formatBacktestReport } from './report-format';

/**
 * The reporting half of every `backtest*` command.
 *
 * All four commands loaded different data in different ways and then printed
 * the same three things — bar counts per timeframe, the summary table, and
 * optionally the trade list. Each had its own copy, and they had already
 * drifted: one printed the cost line only when a cost was set, another always;
 * one bounded the date range by the request, another by the bars actually
 * loaded.
 */

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface CostOptions {
  readonly fee?: number;
  readonly slippage?: number;
  readonly worstCase?: boolean;
}

/**
 * The cost banner, including the warning when no fee was set.
 *
 * A gross backtest is not a tradeable result, and the number that comes out
 * looks exactly as authoritative as a net one — so saying nothing is the one
 * option that is not acceptable.
 */
export function printCosts(options: CostOptions, log: (line: string) => void): void {
  log(
    `costs    : fee ${options.fee ?? 0} per side, slippage ${options.slippage ?? 0}` +
      `${options.worstCase === true ? ', worst-case bars' : ''}`,
  );
  if (options.fee === undefined) {
    log('           ⚠ no fee set — this result is GROSS, not tradeable');
  }
}

/** One line per timeframe: how many bars were loaded, and over what span. */
export function printBarCounts(outcome: BacktestOutcome, log: (line: string) => void): void {
  for (const [timeframe, count] of Object.entries(outcome.barsByTimeframe)) {
    const span = BacktestRunnerService.span(outcome.context.candles(timeframe));
    log(
      `  ${timeframe}: ${count} bars` +
        (span === null ? '' : `  (${day(span.fromMs)} – ${day(span.toMs)})`),
    );
  }
}

export interface ReportHeader {
  readonly symbol: string;
  readonly initialBalance: number;
  readonly baseTimeframe: string;
}

/**
 * The summary table.
 *
 * The reported period comes from the bars actually loaded, not from the range
 * that was requested: a request for a year that the venue only partly serves
 * would otherwise print a year it did not test.
 */
export function printReport(
  outcome: BacktestOutcome,
  header: ReportHeader,
  log: (line: string) => void,
): void {
  const span = BacktestRunnerService.span(outcome.context.candles(header.baseTimeframe));
  log(
    formatBacktestReport(
      {
        symbol: header.symbol,
        strategyName: outcome.strategy.name,
        strategyVersion: outcome.strategy.version,
        initialBalance: header.initialBalance,
        fromMs: span?.fromMs ?? null,
        toMs: span?.toMs ?? null,
      },
      outcome.report,
    ),
  );
}

/** The per-trade listing behind `--trades`. */
export function printTrades(outcome: BacktestOutcome, log: (line: string) => void): void {
  log('\n=== Trades ===');
  for (const [i, trade] of outcome.trades.entries()) {
    const pnl = ((trade.pnlPct ?? 0) * 100).toFixed(2);
    log(
      `  ${String(i + 1).padStart(3)}  ${new Date(trade.entryTime).toISOString()}  ` +
        `${trade.signal.direction.padEnd(5)} @ ${trade.entryPrice}  → ` +
        `${(trade.exitReason ?? 'open').padEnd(6)} @ ${trade.exitPrice ?? '—'}  ${pnl.padStart(7)}%`,
    );
  }
  if (outcome.openTrades.length > 0) {
    log(`  (+${outcome.openTrades.length} still open at the end of the range)`);
  }
}
