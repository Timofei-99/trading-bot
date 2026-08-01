import { Direction, Signal } from './signal';

export type ExitReason = 'tp' | 'sl' | 'expiry' | 'manual' | 'strategy';

export interface TradeInit {
  readonly signal: Signal;
  readonly orderId: string;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly positionSize: number;
  /**
   * Taker fee per side, as a fraction of notional (Bybit spot taker: 0.001).
   * Zero — the default — keeps PnL gross, bit-identical to the pre-fee code.
   */
  readonly feeRate?: number;
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
  readonly feeRate: number;

  exitTime: number | null = null;
  exitPrice: number | null = null;
  exitReason: ExitReason | null = null;
  /**
   * Accumulated funding paid while the position was open, in quote currency.
   * Positive = paid, negative = received (a short under a positive rate).
   * Perpetuals only; stays 0 everywhere else.
   */
  fundingCost = 0;

  constructor(init: TradeInit) {
    this.signal = init.signal;
    this.orderId = init.orderId;
    this.entryTime = init.entryTime;
    this.entryPrice = init.entryPrice;
    this.positionSize = init.positionSize;
    this.feeRate = init.feeRate ?? 0;
  }

  /**
   * Net of fees when `feeRate` is set; gross otherwise.
   *
   * The fee is paid on both notionals (entry and exit), expressed here
   * relative to the entry notional so the percentage stays comparable to the
   * gross figure: `feeRate * (1 + exit/entry)`. Direction does not matter —
   * both sides of a round trip are charged either way.
   */
  get pnlPct(): number | null {
    if (this.exitPrice === null) {
      return null;
    }
    const gross =
      this.signal.direction === Direction.Long
        ? (this.exitPrice - this.entryPrice) / this.entryPrice
        : (this.entryPrice - this.exitPrice) / this.entryPrice;
    let net = gross;
    if (this.feeRate !== 0) {
      net = gross - this.feeRate * (1 + this.exitPrice / this.entryPrice);
    }
    if (this.fundingCost !== 0) {
      // Quote currency, expressed against the entry notional like the fee is.
      // Guarded so the funding-free path — every parity-pinned run — executes
      // the exact float operations it always did.
      net -= this.fundingCost / (this.entryPrice * this.positionSize);
    }
    return net;
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
