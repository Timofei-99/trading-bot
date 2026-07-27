import { CandleSeries } from './candle-series';
import { MarketContext } from './market-context';
import { EntryOrder, MarketSnapshot, SyncResult } from './order';
import { Pattern } from './pattern';
import { Direction, Signal } from './signal';
import { ExitReason, Trade } from './trade';

/**
 * The contracts that keep the domain independent of the outside world.
 *
 * Detectors and strategies are plain classes: construct with parameters, call
 * a method. Everything that touches an exchange, a file or a chart sits behind
 * a port implemented in `infrastructure/`, which is what lets the same
 * strategy run under backtest, paper and live execution unchanged.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * One ICT concept per detector. Stateless: all configuration goes through the
 * constructor, `detect` is a pure function of the bars it is handed. That
 * single uniform signature is what makes detectors freely combinable across
 * timeframes by any strategy.
 */
export interface Detector {
  detect(candles: CandleSeries): Pattern[];
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export abstract class Strategy {
  abstract readonly name: string;
  abstract readonly version: string;

  /**
   * Called once per bar of the base timeframe with a context that contains
   * only bars at or before the current one.
   */
  abstract checkEntry(context: MarketContext): Signal | null;

  /** Optional early exit; the default keeps the position until TP/SL/expiry. */
  checkExit(_context: MarketContext, _trade: Trade): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface Position {
  readonly symbol: string;
  readonly orderId: string;
  readonly entryPrice: number;
  readonly positionSize: number;
  readonly direction: Direction;
}

/**
 * The seam between a strategy and where its orders actually go.
 * `BacktestAdapter` implements it today; `PaperAdapter` and an exchange
 * adapter slot in behind the same three methods without the domain changing.
 */
export interface ExecutionPort {
  placeOrder(signal: Signal): string;
  getPosition(symbol: string): Position | null;
  closePosition(symbol: string): void;
}

/**
 * The seam live-style execution plugs into — paper today, a real venue next.
 *
 * This is deliberately a SEPARATE port from the backtest's `ExecutionPort`,
 * not an async version of it. The backtest port is a fill model driven by
 * history and is parity-pinned; this one is an order-routing contract where a
 * placed entry may rest, fill later, time out or be rejected. Strategies see
 * neither — they emit Signals, and that is what makes the same strategy run
 * unchanged under backtest, paper and live.
 */
export interface LiveExecutionPort {
  /** Place the entry limit order for a signal. Rejects when already engaged on the symbol. */
  placeEntry(signal: Signal): Promise<EntryOrder>;
  /** Cancel a resting entry. Resolves to the cancelled order, or null if none rested. */
  cancelEntry(symbol: string): Promise<EntryOrder | null>;
  /**
   * Settle state against the latest closed bar: fill or expire a resting
   * entry, then run TP / SL / expiry on an open position.
   */
  sync(snapshot: MarketSnapshot): Promise<SyncResult>;
  getRestingEntry(symbol: string): Promise<EntryOrder | null>;
  /** The open position as the trade that opened it, or null. */
  getPosition(symbol: string): Promise<Trade | null>;
  getBalance(): Promise<number>;
  getClosedTrades(): Promise<Trade[]>;
  /** Market-close an open position (strategy exit, kill switch). */
  closePosition(symbol: string, reason: ExitReason): Promise<Trade | null>;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface CandleRequest {
  readonly symbol: string;
  readonly timeframe: string;
  /** Inclusive bounds, epoch milliseconds. */
  readonly startMs: number;
  readonly endMs: number;
}

export interface MarketDataPort {
  getCandles(request: CandleRequest): Promise<CandleSeries>;
}
