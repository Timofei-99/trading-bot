import {
  EntryOrder,
  JournalEvent,
  MarketSnapshot,
  serializeSignal,
  SyncResult,
  TradeJournalPort,
} from '@bot/core/domain/order';
import { entryOrderId, exitOrderId } from '@bot/core/domain/order-id';
import { LiveExecutionPort } from '@bot/core/domain/ports';
import { Direction, Signal } from '@bot/core/domain/signal';
import { ExitReason, Trade } from '@bot/core/domain/trade';
import { ExchangeClient, MarketSpec } from './exchange-client';
import { OpenState, replayJournal } from './journal-replay';
import { withRetry } from './retry';
import { assertTradeable, quoteCurrency } from './venue-limits';

export interface BybitAdapterOptions {
  readonly symbol: string;
  readonly riskPerTrade?: number;
  /** Taker fee per side, for sizing headroom and PnL bookkeeping. */
  readonly feeRate?: number;
  /** Cancel a resting entry not filled within this long. */
  readonly entryTimeoutMs?: number;
  /** Quote currency of the pair, used for the balance check (BTC/USDT -> USDT). */
  readonly quoteCurrency?: string;
  readonly journal?: TradeJournalPort;
  readonly log?: (line: string) => void;
  /** Retries for transient network failures on idempotent calls. */
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Refuse to start when the local clock is further than this from the venue. */
  readonly maxClockSkewMs?: number;
}

/**
 * Live execution against Bybit through the narrow `ExchangeClient` port.
 *
 * Three things make this different from `PaperAdapter`, and each exists
 * because a venue can disagree with us:
 *
 *  - **The venue owns the exits.** Take profit and stop loss are attached to
 *    the entry order, so they are enforced by Bybit's matching engine even if
 *    this process is asleep or offline. `sync()` therefore does not decide
 *    exits; it *observes* them.
 *  - **Every order carries an idempotency key.** `orderLinkId` is our own
 *    order id, so a retry after a network timeout is rejected by the venue
 *    rather than opening a second position.
 *  - **State is reconciled, not assumed.** `start()` compares the journal
 *    against the venue's open orders and balance, because the process may
 *    have been down while an order filled.
 */
export class BybitAdapter implements LiveExecutionPort {
  readonly symbol: string;
  readonly riskPerTrade: number;
  readonly feeRate: number;
  readonly entryTimeoutMs: number;
  readonly quoteCurrency: string;

  private readonly journal: TradeJournalPort | undefined;
  private readonly log: (line: string) => void;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxClockSkewMs: number;

  private market: MarketSpec | null = null;
  private resting: OpenState | null = null;
  private position: Trade | null = null;
  private readonly closed: Trade[] = [];
  private cachedBalance = 0;

  constructor(
    private readonly client: ExchangeClient,
    private readonly options: BybitAdapterOptions,
  ) {
    this.symbol = options.symbol;
    this.riskPerTrade = options.riskPerTrade ?? 0.01;
    this.feeRate = options.feeRate ?? 0.001;
    this.entryTimeoutMs = options.entryTimeoutMs ?? 60 * 60_000;
    this.quoteCurrency = options.quoteCurrency ?? quoteCurrency(options.symbol);
    this.journal = options.journal;
    this.log = options.log ?? (() => undefined);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxClockSkewMs = options.maxClockSkewMs ?? 3_000;
  }

  // -------------------------------------------------------------------------
  // Startup: clock, market rules, and agreeing with the venue about reality
  // -------------------------------------------------------------------------

  /** Must run before trading. Replays the journal, then reconciles with the venue. */
  async start(nowMs: number): Promise<void> {
    const serverTime = await this.retry('fetchServerTime', () => this.client.fetchServerTime());
    const skew = Math.abs(serverTime - nowMs);
    if (skew > this.maxClockSkewMs) {
      // Bybit rejects a signed request whose timestamp falls outside recv_window;
      // failing here names the cause instead of leaving cryptic 401s later.
      throw new Error(
        `Local clock is ${skew} ms from Bybit (limit ${this.maxClockSkewMs} ms). Sync system time before trading.`,
      );
    }

    this.market = await this.retry('loadMarket', () => this.client.loadMarket(this.symbol));

    if (this.journal !== undefined) {
      const restored = replayJournal(this.journal.readAll(), this.feeRate);
      this.resting = restored.resting;
      this.position = restored.position;
      this.closed.push(...restored.closed);
      this.cachedBalance = restored.balance;
    }

    await this.reconcile();
    this.cachedBalance = await this.retry('fetchFreeBalance', () =>
      this.client.fetchFreeBalance(this.quoteCurrency),
    );
    this.log(`ready: balance ${this.cachedBalance} ${this.quoteCurrency}`);
  }

  /**
   * Make local state match the venue's.
   *
   * The dangerous case is a resting entry the journal still calls open: while
   * the process was down it may have filled, been cancelled, or expired. We
   * ask the venue rather than guess.
   */
  private async reconcile(): Promise<void> {
    if (this.resting === null) {
      return;
    }
    const state = this.resting;

    const open = await this.retry('fetchOpenOrders', () =>
      this.client.fetchOpenOrders(this.symbol),
    );
    const stillResting = open.find(
      (order) =>
        order.clientOrderId === state.order.orderId ||
        (state.exchangeOrderId !== null && order.id === state.exchangeOrderId),
    );
    if (stillResting !== undefined) {
      state.exchangeOrderId = stillResting.id;
      this.log(`reconciled: entry ${state.order.orderId} still resting at the venue`);
      return;
    }

    if (state.exchangeOrderId === null) {
      // Placed but never confirmed — the venue never saw it, or we never saw
      // the reply. Nothing rests, so drop it and let the strategy re-signal.
      this.resting = null;
      this.record({
        type: 'entry_settled',
        at: Date.now(),
        orderId: state.order.orderId,
        symbol: this.symbol,
        status: 'cancelled',
        fillPrice: null,
        fillTime: null,
      });
      this.log(`reconciled: entry ${state.order.orderId} unknown to the venue, dropped`);
      return;
    }

    const order = await this.retry('fetchOrder', () =>
      this.client.fetchOrder(this.symbol, state.exchangeOrderId as string),
    );
    this.resting = null;

    if (order.status === 'closed' && order.filled > 0) {
      const fillPrice = order.average ?? order.price ?? state.order.signal.entry;
      const fillTime = order.timestamp ?? Date.now();
      this.openPosition(state.order, fillPrice, fillTime, order.filled);
      this.log(`reconciled: entry ${state.order.orderId} filled while we were away @ ${fillPrice}`);
      return;
    }

    this.record({
      type: 'entry_settled',
      at: Date.now(),
      orderId: state.order.orderId,
      symbol: this.symbol,
      status: order.status === 'expired' ? 'expired' : 'cancelled',
      fillPrice: null,
      fillTime: null,
    });
    this.log(`reconciled: entry ${state.order.orderId} ended as ${order.status}`);
  }

  // -------------------------------------------------------------------------
  // LiveExecutionPort
  // -------------------------------------------------------------------------

  async placeEntry(signal: Signal): Promise<EntryOrder> {
    if (signal.symbol !== this.symbol) {
      throw new Error(`This adapter trades ${this.symbol}, got a signal for ${signal.symbol}`);
    }
    if (this.resting !== null || this.position !== null) {
      throw new Error(`Already engaged on ${this.symbol}: one position per symbol`);
    }
    if (signal.direction !== Direction.Long) {
      // Spot cannot short; a short signal must not be silently turned into a sell.
      throw new Error(
        'Spot trading supports long entries only; configure a linear market to short',
      );
    }

    const market = this.requireMarket();
    const entry = this.client.priceToPrecision(this.symbol, signal.entry);
    const takeProfit = this.client.priceToPrecision(this.symbol, signal.takeProfit);
    const stopLoss = this.client.priceToPrecision(this.symbol, signal.stopLoss);

    const free = await this.retry('fetchFreeBalance', () =>
      this.client.fetchFreeBalance(this.quoteCurrency),
    );
    this.cachedBalance = free;

    const risked = (free * this.riskPerTrade) / Math.abs(entry - stopLoss);
    const affordable = free / (entry * (1 + this.feeRate));
    const amount = this.client.amountToPrecision(this.symbol, Math.min(risked, affordable));

    assertTradeable(market, this.symbol, amount, entry);

    const orderId = entryOrderId(signal);
    const order: EntryOrder = {
      orderId,
      signal,
      positionSize: amount,
      placedAt: signal.timestamp,
      status: 'open',
      fillPrice: null,
      fillTime: null,
    };

    // Journalled BEFORE the call: if the reply is lost, reconciliation must
    // know this id existed so it can ask the venue what became of it.
    this.resting = { order, exchangeOrderId: null };
    this.record({
      type: 'entry_placed',
      at: order.placedAt,
      orderId,
      positionSize: amount,
      signal: serializeSignal(signal),
    });

    const placed = await this.retry('placeLimitOrder', () =>
      this.client.placeLimitOrder({
        symbol: this.symbol,
        side: 'buy',
        amount,
        price: entry,
        clientOrderId: orderId,
        takeProfit,
        stopLoss,
      }),
    );
    (this.resting as OpenState).exchangeOrderId = placed.id;
    this.record({
      type: 'entry_acknowledged',
      at: Date.now(),
      orderId,
      symbol: this.symbol,
      exchangeOrderId: placed.id,
    });
    this.log(
      `entry placed: ${amount} @ ${entry} (tp ${takeProfit}, sl ${stopLoss}) id ${placed.id}`,
    );
    return order;
  }

  async cancelEntry(symbol: string): Promise<EntryOrder | null> {
    if (symbol !== this.symbol || this.resting === null) {
      return null;
    }
    const state = this.resting;
    if (state.exchangeOrderId !== null) {
      await this.retry('cancelOrder', () =>
        this.client.cancelOrder(this.symbol, state.exchangeOrderId as string),
      );
    }
    this.resting = null;
    state.order.status = 'cancelled';
    this.record({
      type: 'entry_settled',
      at: Date.now(),
      orderId: state.order.orderId,
      symbol,
      status: 'cancelled',
      fillPrice: null,
      fillTime: null,
    });
    return state.order;
  }

  /**
   * Observe the venue: did the resting entry fill, and is the position still open?
   *
   * Unlike the paper adapter this does not evaluate TP/SL against the bar —
   * Bybit does that. We poll order state and record what already happened.
   */
  async sync(snapshot: MarketSnapshot): Promise<SyncResult> {
    const settledEntries: EntryOrder[] = [];
    const closedTrades: Trade[] = [];
    const nowMs = snapshot.candle.time;

    if (this.resting !== null) {
      const state = this.resting;
      if (state.exchangeOrderId === null) {
        await this.reconcile();
      } else {
        const order = await this.retry('fetchOrder', () =>
          this.client.fetchOrder(this.symbol, state.exchangeOrderId as string),
        );

        if (order.status === 'closed' && order.filled > 0) {
          const fillPrice = order.average ?? order.price ?? state.order.signal.entry;
          const fillTime = order.timestamp ?? nowMs;
          this.resting = null;
          state.order.status = 'filled';
          state.order.fillPrice = fillPrice;
          state.order.fillTime = fillTime;
          settledEntries.push(state.order);
          this.openPosition(state.order, fillPrice, fillTime, order.filled);
        } else if (
          order.status === 'canceled' ||
          order.status === 'rejected' ||
          order.status === 'expired'
        ) {
          this.resting = null;
          state.order.status = order.status === 'expired' ? 'expired' : 'cancelled';
          settledEntries.push(state.order);
          this.record({
            type: 'entry_settled',
            at: nowMs,
            orderId: state.order.orderId,
            symbol: this.symbol,
            status: state.order.status === 'expired' ? 'expired' : 'cancelled',
            fillPrice: null,
            fillTime: null,
          });
        } else if (nowMs >= state.order.placedAt + this.entryTimeoutMs) {
          await this.cancelEntry(this.symbol);
          state.order.status = 'expired';
          settledEntries.push(state.order);
          this.log(`entry ${state.order.orderId} timed out, cancelled at the venue`);
        }
      }
    }

    if (this.position !== null) {
      const closedByVenue = await this.detectVenueExit(snapshot);
      if (closedByVenue !== null) {
        closedTrades.push(closedByVenue);
      }
    }

    return { closed: closedTrades, settledEntries };
  }

  /**
   * Did Bybit's attached TP/SL close the position?
   *
   * On spot the position is simply the base asset: when the exit order fires
   * the balance returns to quote and no entry order remains open. We infer
   * the exit from the price that traded, which is what the attached order
   * would have executed at.
   */
  private async detectVenueExit(snapshot: MarketSnapshot): Promise<Trade | null> {
    const trade = this.position as Trade;
    const { candle } = snapshot;
    const { takeProfit, stopLoss } = trade.signal;

    const hitTakeProfit = candle.high >= takeProfit;
    const hitStopLoss = candle.low <= stopLoss;
    if (!hitTakeProfit && !hitStopLoss) {
      const expiry = trade.signal.expiryTime;
      if (expiry !== null && candle.time >= expiry) {
        return this.closePosition(this.symbol, 'expiry');
      }
      return null;
    }

    const open = await this.retry('fetchOpenOrders', () =>
      this.client.fetchOpenOrders(this.symbol),
    );
    if (open.length > 0) {
      // The venue still has working orders on this symbol: the exit has not
      // completed, so do not book a close yet.
      return null;
    }

    // Both levels inside one bar: attribute to the stop, the conservative
    // reading when the venue does not tell us which fired first.
    const reason: ExitReason = hitStopLoss ? 'sl' : 'tp';
    const price = reason === 'sl' ? stopLoss : takeProfit;
    return this.book(trade, price, candle.time, reason);
  }

  async getRestingEntry(symbol: string): Promise<EntryOrder | null> {
    return symbol === this.symbol && this.resting !== null ? this.resting.order : null;
  }

  async getPosition(symbol: string): Promise<Trade | null> {
    return symbol === this.symbol ? this.position : null;
  }

  async getBalance(): Promise<number> {
    return this.cachedBalance;
  }

  async getClosedTrades(): Promise<Trade[]> {
    return [...this.closed];
  }

  async closePosition(symbol: string, reason: ExitReason): Promise<Trade | null> {
    if (symbol !== this.symbol || this.position === null) {
      return null;
    }
    const trade = this.position;

    // Clear any working exit first, or the venue may reject the market sell
    // for lack of free balance.
    const open = await this.retry('fetchOpenOrders', () =>
      this.client.fetchOpenOrders(this.symbol),
    );
    for (const order of open) {
      await this.retry('cancelOrder', () => this.client.cancelOrder(this.symbol, order.id));
    }

    const sold = await this.retry('placeMarketOrder', () =>
      this.client.placeMarketOrder(
        this.symbol,
        'sell',
        trade.positionSize,
        exitOrderId(trade.orderId),
      ),
    );
    const price = sold.average ?? sold.price ?? trade.entryPrice;
    return this.book(trade, price, sold.timestamp ?? Date.now(), reason);
  }

  // -------------------------------------------------------------------------

  private requireMarket(): MarketSpec {
    if (this.market === null) {
      throw new Error('BybitAdapter.start() must run before placing orders');
    }
    return this.market;
  }

  private openPosition(
    order: EntryOrder,
    fillPrice: number,
    fillTime: number,
    filled: number,
  ): void {
    this.position = new Trade({
      signal: order.signal,
      orderId: order.orderId,
      entryTime: fillTime,
      entryPrice: fillPrice,
      positionSize: filled,
      feeRate: this.feeRate,
    });
    this.record({
      type: 'entry_settled',
      at: fillTime,
      orderId: order.orderId,
      symbol: this.symbol,
      status: 'filled',
      fillPrice,
      fillTime,
    });
  }

  private book(trade: Trade, price: number, timeMs: number, reason: ExitReason): Trade {
    this.position = null;
    trade.exitPrice = price;
    trade.exitTime = timeMs;
    trade.exitReason = reason;
    this.closed.push(trade);

    const dollarPnl = trade.positionSize * (price - trade.entryPrice);
    this.cachedBalance +=
      dollarPnl - trade.positionSize * (trade.entryPrice + price) * this.feeRate;

    this.record({
      type: 'position_closed',
      at: timeMs,
      orderId: trade.orderId,
      symbol: this.symbol,
      exitPrice: price,
      exitTime: timeMs,
      exitReason: reason,
      pnlPct: trade.pnlPct as number,
      balance: this.cachedBalance,
    });
    this.log(`position closed ${reason} @ ${price}`);
    return trade;
  }

  /** Delegates to `withRetry`; see its contract for what "safe to repeat" means. */
  private retry<T>(label: string, call: () => Promise<T>): Promise<T> {
    return withRetry(label, call, {
      maxRetries: this.maxRetries,
      baseMs: this.retryBaseMs,
      sleep: this.sleep,
      log: this.log,
    });
  }

  /**
   * Append to the audit trail. No replay guard is needed: restore is a pure
   * fold in `replayJournal`, so it never reaches this method at all.
   */
  private record(event: JournalEvent): void {
    this.journal?.append(event);
  }
}
