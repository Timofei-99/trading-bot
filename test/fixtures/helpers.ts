import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BarTuple, CandleSeries } from '../../src/domain/candle-series';

export const GOLDEN_ROOT = join(__dirname, 'golden');

export function goldenPath(...parts: string[]): string {
  return join(GOLDEN_ROOT, ...parts);
}

export function loadGolden<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(goldenPath(...parts), 'utf8')) as T;
}

export interface GoldenCandles {
  symbol: string;
  timeframe: string;
  count: number;
  bars: BarTuple[];
}

export function loadGoldenCandles(dataset: string): CandleSeries {
  const payload = loadGolden<GoldenCandles>('candles', `${dataset}.json`);
  return CandleSeries.fromBars(payload.bars);
}

export interface GoldenPattern {
  type: string;
  timeframe: string;
  startTime: number;
  endTime: number | null;
  high: number;
  low: number;
  meta: Record<string, unknown>;
}

export interface GoldenPatternFile {
  detector: string;
  dataset: string;
  params: Record<string, unknown>;
  count: number;
  patterns: GoldenPattern[];
}

export interface GoldenSignal {
  symbol: string;
  direction: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  timeframe: string;
  timestamp: number;
  strategyName: string;
  strategyVersion: string;
  triggeredBy: string[];
  meta: Record<string, unknown>;
  expiryTime: number | null;
}

export interface GoldenTrade {
  signal: GoldenSignal;
  entryTime: number;
  entryPrice: number;
  positionSize: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlPct: number | null;
  pnlR: number | null;
  isWinner: boolean | null;
}

export interface GoldenTradesFile {
  run: string;
  symbol: string;
  strategyName: string;
  strategyVersion: string;
  strategyParams: Record<string, unknown>;
  adapterParams: { initial_balance: number; risk_per_trade: number };
  baseTimeframe: string;
  window: number;
  finalBalance: number;
  closedTrades: GoldenTrade[];
  openTrades: GoldenTrade[];
}

/** `Infinity` has no JSON literal, so the exporter writes it as a string. */
export type GoldenNumber = number | 'inf' | '-inf';

export interface GoldenReport {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  profitFactor: GoldenNumber;
  totalPnlPct: number;
  maxDrawdownPct: number;
}

export function goldenNumber(value: GoldenNumber): number {
  if (value === 'inf') {
    return Number.POSITIVE_INFINITY;
  }
  if (value === '-inf') {
    return Number.NEGATIVE_INFINITY;
  }
  return value;
}

export interface GoldenVisibilityEntry {
  call: number;
  barTime: number;
  visible: Record<string, { count: number; last: number | null; first: number | null }>;
}

export interface GoldenVisibilityFile {
  run: string;
  baseTimeframe: string;
  window: number;
  totalCalls: number;
  every: number;
  trace: GoldenVisibilityEntry[];
}
