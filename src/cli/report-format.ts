import { BacktestReport } from '../execution/backtest.adapter';

export interface ReportHeader {
  readonly symbol: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly initialBalance: number;
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

const isoDate = (ms: number | null): string =>
  ms === null ? '—' : new Date(ms).toISOString().slice(0, 10);

export const percent1 = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;
export const percent2 = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

export const signedPercent2 = (fraction: number): string => {
  const value = fraction * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

export const money0 = (value: number): string =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export const profitFactor = (value: number): string =>
  Number.isFinite(value) ? value.toFixed(2) : 'inf';

/**
 * The console report, in the shape `run_backtest.py` printed.
 *
 * Kept identical on purpose: this output is what anyone comparing a run
 * against an older one reads, and gratuitously reformatting it would make
 * those comparisons manual.
 */
export function formatBacktestReport(header: ReportHeader, report: BacktestReport): string {
  const lines = [
    '',
    '=== Backtest Report ===',
    `  Period          : ${isoDate(header.fromMs)} – ${isoDate(header.toMs)}`,
    `  Symbol          : ${header.symbol}`,
    `  Strategy        : ${header.strategyName} v${header.strategyVersion}`,
    `  Initial balance : ${money0(header.initialBalance)}`,
    `  Total trades    : ${report.totalTrades}`,
  ];

  if (report.totalTrades > 0) {
    lines.push(
      `  Winners / Losers: ${report.winners} / ${report.losers}`,
      `  Win rate        : ${percent1(report.winRate)}`,
      `  Profit factor   : ${profitFactor(report.profitFactor)}`,
      `  Total PnL       : ${signedPercent2(report.totalPnlPct)}`,
      `  Max drawdown    : ${percent2(report.maxDrawdownPct)}`,
    );
  }

  return lines.join('\n');
}

/** Key-per-line dump, as `run_frankfurt_ib_50.py` wrote to its summary file. */
export function formatReportLines(report: BacktestReport): string {
  return Object.entries(report)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');
}
