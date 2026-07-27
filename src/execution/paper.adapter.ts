import { Candle } from '../domain/candle-series';
import {
  deserializeSignal,
  EntryOrder,
  JournalEvent,
  MarketSnapshot,
  serializeSignal,
  SyncResult,
  TradeJournalPort,
} from '../domain/order';
import { LiveExecutionPort } from '../domain/ports';
import { Direction, Signal } from '../domain/signal';
import { ExitReason, Trade } from '../domain/trade';

export interface PaperAdapterOptions {
  readonly initialBalance?: number;
  readonly riskPerTrade?: number;
  /** Taker fee per side, charged on close like the backtest adapter. */
  readonly feeRate?: number;
  /** Adverse fill on market-like exits (SL, expiry, forced close). */
  readonly slippage?: number;
  /** Resolve a bar spanning both TP and SL against the trade. */
  readonly worstCase?: boolean;
  /** Cancel a resting entry not filled within this long (freqtrade's unfilledtimeout). */
  readonly entryTimeoutMs?: number;
  /** Durable audit trail; every state change is appended, restarts replay it. */
  readonly journal?: TradeJournalPort;
}

/**
 * Dry-run execution: real market data, simulated fills, no venue.
 *
 * The simulation deliberately mirrors the backtest's settlement — same
 * TP-first ordering (or `worstCase`), same fee and slippage treatment — so a
 * paper result is comparable to a backtest result. The one honest difference
 * is the entry: the backtest fills on the signal bar because history already
 * shows the touch, while here the order is placed AFTER that bar closes and
 * only fills if price returns to the level on a LATER closed bar. That gap is
 * the point of paper trading — it measures whether backtest fills are
 * achievable at all.
 *
 * Every state change goes through the journal, and `PaperAdapter.restore`
 * replays it, so a restart (or a crash) resumes with the same balance, the
 * same resting order and the same open position.
 */
export class PaperAdapter implements LiveExecutionPort {
  balance: number;
  readonly riskPerTrade: number;
  readonly feeRate: number;
  readonly slippage: number;
  readonly worstCase: boolean;
  readonly entryTimeoutMs: number;

  private readonly journal: TradeJournalPort | undefined;
  private readonly restingEntries = new Map<string, EntryOrder>();
  private readonly openPositions = new Map<string, Trade>();
  private readonly closedTrades: Trade[] = [];
  private readonly lastSeen = new Map<string, { close: number; time: number }>();
  private replaying = false;

  constructor(options: PaperAdapterOptions = {}) {
    this.balance = options.initialBalance ?? 10_000;
    this.riskPerTrade = options.riskPerTrade ?? 0.01;
    this.feeRate = options.feeRate ?? 0;
    this.slippage = options.slippage ?? 0;
    this.worstCase = options.worstCase ?? false;
    this.entryTimeoutMs = options.entryTimeoutMs ?? 60 * 60_000;
    this.journal = options.journal;
  }

  /** Rebuild state from the journal, then continue appending to it. */
  static restore(options: PaperAdapterOptions): PaperAdapter {
    const adapter = new PaperAdapter(options);
    if (options.journal !== undefined) {
      adapter.replaying = true;
      for (const event of options.journal.readAll()) {
        adapter.apply(event);
      }
      adapter.replaying = false;
    }
    return adapter;
  }

  // -------------------------------------------------------------------------
  // LiveExecutionPort
  // -------------------------------------------------------------------------

  async placeEntry(signal: Signal): Promise<EntryOrder> {
    if (this.restingEntries.has(signal.symbol) || this.openPositions.has(signal.symbol)) {
      throw new Error(`Already engaged on ${signal.symbol}: one position per symbol`);
    }

    const risked = (this.balance * this.riskPerTrade) / signal.riskAmount;
    // Spot reality: you cannot buy more than the wallet holds, fees included.
    const affordable = this.balance / (signal.entry * (1 + this.feeRate));
    const positionSize = Math.min(risked, affordable);
    if (!(positionSize > 0)) {
      throw new Error(`Position size must be positive, got ${positionSize}`);
    }

    const order: EntryOrder = {
      orderId: globalThis.crypto.randomUUID(),
      signal,
      positionSize,
      placedAt: signal.timestamp,
      status: 'open',
      fillPrice: null,
      fillTime: null,
    };
    this.restingEntries.set(signal.symbol, order);
    this.record({
      type: 'entry_placed',
      at: order.placedAt,
      orderId: order.orderId,
      positionSize,
      signal: serializeSignal(signal),
    });
    return order;
  }

  async cancelEntry(symbol: string): Promise<EntryOrder | null> {
    const order = this.restingEntries.get(symbol);
    if (order === undefined) {
      return null;
    }
    this.restingEntries.delete(symbol);
    order.status = 'cancelled';
    this.record({
      type: 'entry_settled',
      at: order.placedAt,
      orderId: order.orderId,
      symbol,
      status: 'cancelled',
      fillPrice: null,
      fillTime: null,
    });
    return order;
  }

  async sync(snapshot: MarketSnapshot): Promise<SyncResult> {
    const { symbol, candle } = snapshot;
    this.lastSeen.set(symbol, { close: candle.close, time: candle.time });

    const settledEntries: EntryOrder[] = [];
    const closed: Trade[] = [];

    // 1. The resting entry. Only bars strictly after placement count — the
    //    signal bar's own touch happened before the order existed.
    const order = this.restingEntries.get(symbol);
    if (order !== undefined && candle.time > order.placedAt) {
      const long = order.signal.direction === Direction.Long;
      const touched = long ? candle.low <= order.signal.entry : candle.high >= order.signal.entry;

      if (touched) {
        this.restingEntries.delete(symbol);
        order.status = 'filled';
        order.fillPrice = order.signal.entry; // a limit fills at its price
        order.fillTime = candle.time;
        settledEntries.push(order);
        this.openPositions.set(
          symbol,
          new Trade({
            signal: order.signal,
            orderId: order.orderId,
            entryTime: candle.time,
            entryPrice: order.signal.entry,
            positionSize: order.positionSize,
            feeRate: this.feeRate,
          }),
        );
        this.record({
          type: 'entry_settled',
          at: candle.time,
          orderId: order.orderId,
          symbol,
          status: 'filled',
          fillPrice: order.fillPrice,
          fillTime: candle.time,
        });
      } else if (candle.time >= order.placedAt + this.entryTimeoutMs) {
        this.restingEntries.delete(symbol);
        order.status = 'expired';
        settledEntries.push(order);
        this.record({
          type: 'entry_settled',
          at: candle.time,
          orderId: order.orderId,
          symbol,
          status: 'expired',
          fillPrice: null,
          fillTime: null,
        });
      }
    }

    // 2. The open position — including one opened by this very bar, matching
    //    the backtest's same-bar settlement model.
    const trade = this.openPositions.get(symbol);
    if (trade !== undefined) {
      const result = this.settle(symbol, trade, candle);
      if (result !== null) {
        closed.push(result);
      }
    }

    return { closed, settledEntries };
  }

  async getRestingEntry(symbol: string): Promise<EntryOrder | null> {
    return this.restingEntries.get(symbol) ?? null;
  }

  async getPosition(symbol: string): Promise<Trade | null> {
    return this.openPositions.get(symbol) ?? null;
  }

  async getBalance(): Promise<number> {
    return this.balance;
  }

  async getClosedTrades(): Promise<Trade[]> {
    return [...this.closedTrades];
  }

  async closePosition(symbol: string, reason: ExitReason): Promise<Trade | null> {
    const trade = this.openPositions.get(symbol);
    if (trade === undefined) {
      return null;
    }
    const seen = this.lastSeen.get(symbol);
    if (seen === undefined) {
      throw new Error(`No market data seen for ${symbol} yet — sync() must run before closePosition`);
    }
    return this.close(symbol, trade, this.slipped(seen.close, trade.signal.direction), seen.time, reason);
  }

  // -------------------------------------------------------------------------
  // Settlement — the backtest adapter's rules, bar for bar
  // -------------------------------------------------------------------------

  private settle(symbol: string, trade: Trade, candle: Candle): Trade | null {
    const { stopLoss, takeProfit, direction, expiryTime } = trade.signal;

    const hitTakeProfit =
      direction === Direction.Long ? candle.high >= takeProfit : candle.low <= takeProfit;
    const hitStopLoss =
      direction === Direction.Long ? candle.low <= stopLoss : candle.high >= stopLoss;

    if (this.worstCase) {
      if (hitStopLoss) {
        return this.close(symbol, trade, this.slipped(stopLoss, direction), candle.time, 'sl');
      }
      if (hitTakeProfit) {
        return this.close(symbol, trade, takeProfit, candle.time, 'tp');
      }
    } else {
      if (hitTakeProfit) {
        return this.close(symbol, trade, takeProfit, candle.time, 'tp');
      }
      if (hitStopLoss) {
        return this.close(symbol, trade, this.slipped(stopLoss, direction), candle.time, 'sl');
      }
    }

    if (expiryTime !== null && candle.time >= expiryTime) {
      return this.close(symbol, trade, this.slipped(candle.close, direction), candle.time, 'expiry');
    }
    return null;
  }

  private close(
    symbol: string,
    trade: Trade,
    price: number,
    timeMs: number,
    reason: ExitReason,
  ): Trade {
    this.openPositions.delete(symbol);
    trade.exitPrice = price;
    trade.exitTime = timeMs;
    trade.exitReason = reason;

    const dollarPnl =
      trade.signal.direction === Direction.Long
        ? trade.positionSize * (price - trade.entryPrice)
        : trade.positionSize * (trade.entryPrice - price);
    this.balance += dollarPnl;
    if (this.feeRate !== 0) {
      this.balance -= trade.positionSize * (trade.entryPrice + price) * this.feeRate;
    }

    this.closedTrades.push(trade);
    this.record({
      type: 'position_closed',
      at: timeMs,
      orderId: trade.orderId,
      symbol,
      exitPrice: price,
      exitTime: timeMs,
      exitReason: reason,
      pnlPct: trade.pnlPct as number,
      balance: this.balance,
    });
    return trade;
  }

  private slipped(price: number, direction: Direction): number {
    if (this.slippage === 0) {
      return price;
    }
    return direction === Direction.Long ? price * (1 - this.slippage) : price * (1 + this.slippage);
  }

  // -------------------------------------------------------------------------
  // Journal
  // -------------------------------------------------------------------------

  private record(event: JournalEvent): void {
    if (!this.replaying && this.journal !== undefined) {
      this.journal.append(event);
    }
  }

  /** Rebuild one event's worth of state; used only while restoring. */
  private apply(event: JournalEvent): void {
    switch (event.type) {
      case 'session':
        this.balance = event.balance;
        return;

      case 'entry_placed':
        this.restingEntries.set(event.signal.symbol, {
          orderId: event.orderId,
          signal: deserializeSignal(event.signal),
          positionSize: event.positionSize,
          placedAt: event.at,
          status: 'open',
          fillPrice: null,
          fillTime: null,
        });
        return;

      case 'entry_acknowledged':
        return; // venue bookkeeping; paper has no venue

      case 'entry_settled': {
        const order = this.restingEntries.get(event.symbol);
        if (order === undefined) {
          return;
        }
        this.restingEntries.delete(event.symbol);
        order.status = event.status;
        if (event.status === 'filled') {
          order.fillPrice = event.fillPrice;
          order.fillTime = event.fillTime;
          this.openPositions.set(
            event.symbol,
            new Trade({
              signal: order.signal,
              orderId: order.orderId,
              entryTime: event.fillTime as number,
              entryPrice: event.fillPrice as number,
              positionSize: order.positionSize,
              feeRate: this.feeRate,
            }),
          );
        }
        return;
      }

      case 'position_closed': {
        const trade = this.openPositions.get(event.symbol);
        if (trade === undefined) {
          return;
        }
        this.openPositions.delete(event.symbol);
        trade.exitPrice = event.exitPrice;
        trade.exitTime = event.exitTime;
        trade.exitReason = event.exitReason as ExitReason;
        this.closedTrades.push(trade);
        this.balance = event.balance;
        return;
      }
    }
  }
}
