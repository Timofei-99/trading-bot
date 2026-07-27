import { ExecutionPort, Position } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
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

  private readonly openPositions = new Map<string, Trade>();
  private readonly closedTrades: Trade[] = [];

  constructor(options: BacktestAdapterOptions = {}) {
    this.balance = options.initialBalance ?? 10_000;
    this.riskPerTrade = options.riskPerTrade ?? 0.01;
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
      return;
    }

    const { stopLoss, takeProfit, direction, expiryTime } = trade.signal;

    const hitTakeProfit =
      direction === Direction.Long ? candleHigh >= takeProfit : candleLow <= takeProfit;
    const hitStopLoss =
      direction === Direction.Long ? candleLow <= stopLoss : candleHigh >= stopLoss;

    if (hitTakeProfit) {
      this.closeTrade(symbol, takeProfit, candleTime, 'tp');
      return;
    }
    if (hitStopLoss) {
      this.closeTrade(symbol, stopLoss, candleTime, 'sl');
      return;
    }

    if (expiryTime !== null && candleTime >= expiryTime) {
      const price = candleClose !== null ? candleClose : (candleHigh + candleLow) / 2;
      this.closeTrade(symbol, price, candleTime, 'expiry');
    }
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

  private closeTrade(
    symbol: string,
    price: number,
    time: number,
    reason: ExitReason,
  ): void {
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
    this.closedTrades.push(trade);
  }
}
