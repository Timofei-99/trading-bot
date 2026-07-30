import { ExecutionPort, Position } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import { fundingCharge, fundingEventsBetween } from './funding';
import { ExitReason, Trade } from '../domain/trade';

export interface BacktestReport {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  profitFactor: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
}

export interface BacktestAdapterOptions {
  readonly initialBalance?: number;
  readonly riskPerTrade?: number;
  /**
   * Taker fee per side as a fraction of notional (Bybit spot: 0.001).
   * Charged on both the entry and the exit notional when a trade closes.
   * Default 0 keeps every number bit-identical to the fee-less code.
   */
  readonly feeRate?: number;
  /**
   * Perpetuals only: funding rate per 8h interval (e.g. 0.0001 = 0.01%).
   * Longs pay it, shorts receive it. Default 0 keeps spot semantics AND the
   * bit-exact parity path.
   */
  readonly fundingRatePer8h?: number;
  /**
   * Adverse fill on MARKET-like exits (stop loss, expiry), as a fraction of
   * price. Limit-like fills — the entry and the take profit — are not
   * slipped: a limit order fills at its price or better. Default 0.
   */
  readonly slippage?: number;
  /**
   * Resolve a bar that spans both TP and SL against the trade (SL first)
   * instead of the default optimistic TP-first. Use for stress runs; the
   * default preserves the recorded historical behaviour.
   */
  readonly worstCase?: boolean;
}

/**
 * Fill simulation for backtests.
 *
 * `placeOrder` opens a trade immediately at `signal.entry`; each `update()`
 * checks one bar's high/low against the signal's levels. The order of those
 * checks — take profit, then stop loss, then expiry — is deliberate and
 * load-bearing: when a single bar spans both TP and SL there is no way to know
 * which came first intraday, and the Python implementation resolved that in
 * favour of the target. Reordering the checks would silently change the
 * outcome of every such bar in the historical record.
 *
 * Note this sizes positions itself rather than going through `RiskManager`,
 * which is what the Python `BacktestAdapter` did.
 */
export class BacktestAdapter implements ExecutionPort {
  balance: number;
  readonly riskPerTrade: number;
  readonly feeRate: number;
  readonly fundingRatePer8h: number;
  readonly slippage: number;
  readonly worstCase: boolean;

  private readonly lastBarTime = new Map<string, number>();
  private readonly openPositions = new Map<string, Trade>();
  private readonly closedTrades: Trade[] = [];

  constructor(options: BacktestAdapterOptions = {}) {
    this.balance = options.initialBalance ?? 10_000;
    this.riskPerTrade = options.riskPerTrade ?? 0.01;
    this.feeRate = options.feeRate ?? 0;
    this.fundingRatePer8h = options.fundingRatePer8h ?? 0;
    this.slippage = options.slippage ?? 0;
    this.worstCase = options.worstCase ?? false;
  }

  placeOrder(signal: Signal): string {
    // The Web Crypto global rather than `node:crypto`, so this layer stays
    // free of platform imports.
    const orderId = globalThis.crypto.randomUUID();
    const size = (this.balance * this.riskPerTrade) / signal.riskAmount;

    this.openPositions.set(
      signal.symbol,
      new Trade({
        signal,
        orderId,
        entryTime: signal.timestamp,
        entryPrice: signal.entry,
        positionSize: size,
        feeRate: this.feeRate,
      }),
    );
    return orderId;
  }

  getPosition(symbol: string): Position | null {
    const trade = this.openPositions.get(symbol);
    if (trade === undefined) {
      return null;
    }
    return {
      symbol,
      orderId: trade.orderId,
      entryPrice: trade.entryPrice,
      positionSize: trade.positionSize,
      direction: trade.signal.direction,
    };
  }

  /**
   * Discretionary close at the stop level.
   *
   * The backtest loop never calls this — it is here so the port is fully
   * implemented. It stamps the wall clock, the one non-deterministic thing in
   * this class, exactly as the Python version's `datetime.utcnow()` did.
   */
  closePosition(symbol: string): void {
    const trade = this.openPositions.get(symbol);
    if (trade === undefined) {
      return;
    }
    this.closeTrade(symbol, trade.signal.stopLoss, Date.now(), 'manual');
  }

  /** Settle the open position for `symbol` against one bar. */
  update(
    symbol: string,
    candleHigh: number,
    candleLow: number,
    candleTime: number,
    candleClose: number | null = null,
  ): void {
    const trade = this.openPositions.get(symbol);
    if (trade === undefined) {
      this.lastBarTime.set(symbol, candleTime);
      return;
    }

    this.accrueFunding(trade, symbol, candleHigh, candleLow, candleTime, candleClose);

    const { stopLoss, takeProfit, direction, expiryTime } = trade.signal;

    const hitTakeProfit =
      direction === Direction.Long ? candleHigh >= takeProfit : candleLow <= takeProfit;
    const hitStopLoss =
      direction === Direction.Long ? candleLow <= stopLoss : candleHigh >= stopLoss;

    if (this.worstCase) {
      // Stress mode: when a bar spans both levels, assume the stop was hit
      // first. On a bar that reaches only one level this is identical to the
      // default ordering.
      if (hitStopLoss) {
        this.closeTrade(symbol, this.slipped(stopLoss, direction), candleTime, 'sl');
        return;
      }
      if (hitTakeProfit) {
        this.closeTrade(symbol, takeProfit, candleTime, 'tp');
        return;
      }
    } else {
      if (hitTakeProfit) {
        this.closeTrade(symbol, takeProfit, candleTime, 'tp');
        return;
      }
      if (hitStopLoss) {
        this.closeTrade(symbol, this.slipped(stopLoss, direction), candleTime, 'sl');
        return;
      }
    }

    if (expiryTime !== null && candleTime >= expiryTime) {
      const price = candleClose !== null ? candleClose : (candleHigh + candleLow) / 2;
      this.closeTrade(symbol, this.slipped(price, direction), candleTime, 'expiry');
    }
  }

  /**
   * Charge funding for the boundaries this bar crossed while the position was
   * held. Accrued before the exit checks: whether a boundary fell before or
   * after an intra-bar exit is unknowable from OHLC, and charging the held
   * bar is the conservative reading. A no-op at the default rate of zero.
   */
  private accrueFunding(
    trade: Trade,
    symbol: string,
    candleHigh: number,
    candleLow: number,
    candleTime: number,
    candleClose: number | null,
  ): void {
    if (this.fundingRatePer8h !== 0) {
      const since = this.lastBarTime.get(symbol) ?? trade.entryTime;
      const events = fundingEventsBetween(Math.max(since, trade.entryTime), candleTime);
      if (events > 0) {
        const mark = candleClose !== null ? candleClose : (candleHigh + candleLow) / 2;
        trade.fundingCost += fundingCharge(
          trade.signal.direction,
          trade.positionSize,
          mark,
          this.fundingRatePer8h,
          events,
        );
      }
    }
    this.lastBarTime.set(symbol, candleTime);
  }

  /** Adverse fill on a market-like exit; a no-op while slippage is 0. */
  private slipped(price: number, direction: Direction): number {
    if (this.slippage === 0) {
      return price;
    }
    return direction === Direction.Long ? price * (1 - this.slippage) : price * (1 + this.slippage);
  }

  get trades(): Trade[] {
    return [...this.closedTrades];
  }

  get openTrades(): Trade[] {
    return [...this.openPositions.values()];
  }

  report(): BacktestReport {
    const closed = this.closedTrades;
    if (closed.length === 0) {
      return {
        totalTrades: 0,
        winners: 0,
        losers: 0,
        winRate: 0,
        profitFactor: 0,
        totalPnlPct: 0,
        maxDrawdownPct: 0,
      };
    }

    const winners = closed.filter((trade) => trade.isWinner);
    const losers = closed.filter((trade) => !trade.isWinner);

    // Summation order matches the Python original bar for bar. Python 3.11's
    // sum() accumulates naively, like this reduce; 3.12 switched to
    // compensated summation, which is why the golden fixtures pin 3.11.
    let grossProfit = 0;
    for (const trade of winners) {
      const pnl = trade.pnlPct;
      if (pnl !== null) {
        grossProfit += pnl;
      }
    }
    let grossLossSigned = 0;
    for (const trade of losers) {
      const pnl = trade.pnlPct;
      if (pnl !== null) {
        grossLossSigned += pnl;
      }
    }
    const grossLoss = Math.abs(grossLossSigned);

    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let totalPnlPct = 0;
    for (const trade of closed) {
      const pnl = trade.pnlPct ?? 0;
      cumulative += pnl;
      if (cumulative > peak) {
        peak = cumulative;
      }
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    for (const trade of closed) {
      const pnl = trade.pnlPct;
      if (pnl !== null) {
        totalPnlPct += pnl;
      }
    }

    return {
      totalTrades: closed.length,
      winners: winners.length,
      losers: losers.length,
      winRate: winners.length / closed.length,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Number.POSITIVE_INFINITY,
      totalPnlPct,
      maxDrawdownPct: maxDrawdown,
    };
  }

  private closeTrade(symbol: string, price: number, time: number, reason: ExitReason): void {
    const trade = this.openPositions.get(symbol);
    if (trade === undefined) {
      return;
    }
    this.openPositions.delete(symbol);

    trade.exitPrice = price;
    trade.exitTime = time;
    trade.exitReason = reason;

    const dollarPnl =
      trade.signal.direction === Direction.Long
        ? trade.positionSize * (price - trade.entryPrice)
        : trade.positionSize * (trade.entryPrice - price);

    this.balance += dollarPnl;
    if (trade.fundingCost !== 0) {
      this.balance -= trade.fundingCost;
    }
    if (this.feeRate !== 0) {
      // Both sides of the round trip are charged at close. (An entry fee is
      // really paid at fill; charging it here only misstates trades still
      // open when a replay ends, which carry no fee at all.)
      this.balance -= trade.positionSize * (trade.entryPrice + price) * this.feeRate;
    }
    this.closedTrades.push(trade);
  }
}
