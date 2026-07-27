import { Direction, Signal } from './signal';

export type ExitReason = 'tp' | 'sl' | 'expiry' | 'manual';

export interface TradeInit {
  readonly signal: Signal;
  readonly orderId: string;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly positionSize: number;
}

/**
 * An order that has been placed, and possibly closed.
 *
 * Unlike `Pattern` and `Signal` this one is mutable: the execution adapter
 * fills in the exit fields when TP, SL or expiry hits, exactly as the Python
 * `BacktestAdapter._close_trade` did.
 */
export class Trade {
  readonly signal: Signal;
  readonly orderId: string;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly positionSize: number;

  exitTime: number | null = null;
  exitPrice: number | null = null;
  exitReason: ExitReason | null = null;

  constructor(init: TradeInit) {
    this.signal = init.signal;
    this.orderId = init.orderId;
    this.entryTime = init.entryTime;
    this.entryPrice = init.entryPrice;
    this.positionSize = init.positionSize;
  }

  get pnlPct(): number | null {
    if (this.exitPrice === null) {
      return null;
    }
    return this.signal.direction === Direction.Long
      ? (this.exitPrice - this.entryPrice) / this.entryPrice
      : (this.entryPrice - this.exitPrice) / this.entryPrice;
  }

  /** Profit in units of the risk taken (R multiple). */
  get pnlR(): number | null {
    if (this.exitPrice === null) {
      return null;
    }
    const risk = this.signal.riskAmount;
    if (risk === 0) {
      return null;
    }
    return this.signal.direction === Direction.Long
      ? (this.exitPrice - this.entryPrice) / risk
      : (this.entryPrice - this.exitPrice) / risk;
  }

  get isWinner(): boolean | null {
    const pnl = this.pnlPct;
    return pnl === null ? null : pnl > 0;
  }
}
