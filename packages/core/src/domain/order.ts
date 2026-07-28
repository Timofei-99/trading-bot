import { Candle } from './candle-series';
import { Signal, SignalInit } from './signal';
import { Trade } from './trade';

/**
 * Order lifecycle for live-style execution (paper and, later, a real venue).
 *
 * The backtest's `ExecutionPort` is a FILL MODEL: an order placed is a trade
 * opened, because history already knows the bar touched the level. A venue
 * cannot promise that — an entry rests until price comes back to it, times
 * out, or is cancelled. These types describe that gap.
 */

export type EntryOrderStatus = 'open' | 'filled' | 'cancelled' | 'expired' | 'rejected';

export interface EntryOrder {
  /** Client-generated id; becomes the venue's idempotency key (Bybit orderLinkId). */
  readonly orderId: string;
  readonly signal: Signal;
  readonly positionSize: number;
  /** Epoch ms of placement — the close of the signal bar. */
  readonly placedAt: number;
  status: EntryOrderStatus;
  fillPrice: number | null;
  fillTime: number | null;
}

/** What the engine hands the adapter on every closed bar. */
export interface MarketSnapshot {
  readonly symbol: string;
  /** The latest CLOSED candle of the base timeframe. */
  readonly candle: Candle;
}

export interface SyncResult {
  /** Trades closed during this sync, in close order. */
  readonly closed: Trade[];
  /** Entry orders that stopped resting (filled / cancelled / expired). */
  readonly settledEntries: EntryOrder[];
}

// ---------------------------------------------------------------------------
// Journal — the durable audit trail live execution appends to
// ---------------------------------------------------------------------------

export type JournalEvent =
  | { type: 'session'; at: number; note: string; balance: number }
  /**
   * Trading stopped. Replayed on startup so a halted bot stays halted —
   * a loss limit that a restart clears is not a loss limit.
   */
  | { type: 'halted'; at: number; reason: string }
  | { type: 'resumed'; at: number; note: string }
  | {
      type: 'entry_placed';
      at: number;
      orderId: string;
      positionSize: number;
      signal: SignalInit;
    }
  | {
      /**
       * The venue accepted the order and named it. Separate from
       * `entry_placed` on purpose: between the two the reply may be lost, and
       * the difference is exactly what tells a restart whether to ask the
       * venue about this order or to forget it.
       */
      type: 'entry_acknowledged';
      at: number;
      orderId: string;
      symbol: string;
      exchangeOrderId: string;
    }
  | {
      type: 'entry_settled';
      at: number;
      orderId: string;
      symbol: string;
      status: 'filled' | 'cancelled' | 'expired';
      fillPrice: number | null;
      fillTime: number | null;
    }
  | {
      type: 'position_closed';
      at: number;
      orderId: string;
      symbol: string;
      exitPrice: number;
      exitTime: number;
      exitReason: string;
      pnlPct: number;
      /** Account balance AFTER this close — the restore anchor. */
      balance: number;
    };

/**
 * Where those events go. The domain only knows the contract; the NDJSON
 * file implementation lives in infrastructure.
 */
export interface TradeJournalPort {
  append(event: JournalEvent): void;
  readAll(): JournalEvent[];
}

// ---------------------------------------------------------------------------
// Signal wire form — journals must survive a process restart
// ---------------------------------------------------------------------------

export function serializeSignal(signal: Signal): SignalInit {
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    timeframe: signal.timeframe,
    timestamp: signal.timestamp,
    strategyName: signal.strategyName,
    strategyVersion: signal.strategyVersion,
    triggeredBy: [...signal.triggeredBy],
    meta: signal.meta,
    expiryTime: signal.expiryTime,
  };
}

export function deserializeSignal(init: SignalInit): Signal {
  return new Signal(init);
}
