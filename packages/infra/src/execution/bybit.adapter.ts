import {
  EntryOrder,
  JournalEvent,
  MarketSnapshot,
  serializeSignal,
  SyncResult,
  TradeJournalPort,
} from '@bot/core/domain/order';
import { entryOrderId, exitOrderId, isBotOrderId } from '@bot/core/domain/order-id';
import { LiveExecutionPort } from '@bot/core/domain/ports';
import { Direction, Signal } from '@bot/core/domain/signal';
import { ExitReason, Trade } from '@bot/core/domain/trade';
import { ExchangeClient, ExchangeOrder, MarketSpec } from './exchange-client';
import { OpenState, replayJournal } from './journal-replay';
import { withRetry } from './retry';
import { assertTradeable, baseCurrency, quoteCurrency } from './venue-limits';

export interface BybitAdapterOptions {
  readonly symbol: string;
  /**
   * Product line. Spot holds coins and cannot short; linear holds a position
   * object, can short, and closes with reduce-only orders. The adapter needs
   * to know which one it is talking to because position accounting — not just
   * order routing — differs between them.
   */
  readonly category?: 'spot' | 'linear';
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
  readonly category: 'spot' | 'linear';

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
    this.category = options.category ?? 'spot';
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
    // Always ask, even when the journal claims nothing rests. That case used
    // to return early, and it is the dangerous one: if the process died
    // between placing an order and recording it, the venue holds an order this
    // process knows nothing about, will never cancel, and will happily place a
    // second one alongside.
    const open = await this.retry('fetchOpenOrders', () =>
      this.client.fetchOpenOrders(this.symbol),
    );

    this.assertNoOrphans(open);
    await this.reconcilePosition(open);

    if (this.resting === null) {
      return;
    }
    const state = this.resting;

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
    if (this.category === 'spot' && signal.direction !== Direction.Long) {
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
    // Spot: cannot buy more than the wallet holds, fees included. Linear: the
    // same formula is the leverage-1 margin bound — deliberately conservative,
    // since this adapter never requests leverage.
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
        side: signal.direction === Direction.Long ? 'buy' : 'sell',
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

    // A long's target is above and stop below; a short's are mirrored.
    const long = trade.signal.direction === Direction.Long;
    const hitTakeProfit = long ? candle.high >= takeProfit : candle.low <= takeProfit;
    const hitStopLoss = long ? candle.low <= stopLoss : candle.high >= stopLoss;
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

    // Closing a long sells; closing a short buys back. On linear the close is
    // reduce-only, so a stale size can never overshoot into an opposite
    // position — the venue caps it at flat.
    const closing = await this.retry('placeMarketOrder', () =>
      this.client.placeMarketOrder(
        this.symbol,
        trade.signal.direction === Direction.Long ? 'sell' : 'buy',
        trade.positionSize,
        exitOrderId(trade.orderId),
        this.category === 'linear' ? true : undefined,
      ),
    );
    const price = closing.average ?? closing.price ?? trade.entryPrice;
    return this.book(trade, price, closing.timestamp ?? Date.now(), reason);
  }

  // -------------------------------------------------------------------------

  /**
   * Refuse to start when the venue holds an order of ours that the journal
   * cannot account for.
   *
   * The three cases the venue reports identically, and their opposite
   * treatments:
   *
   *  - **Ours, and the journal knows it.** The normal path; reconciliation
   *    below decides what became of it.
   *  - **Not ours** — a hand-placed order, another tool, a different bot. Left
   *    strictly alone. Cancelling somebody else's order because it was in the
   *    way would be a far worse bug than the one this guard exists for.
   *  - **Ours, and the journal does not know it.** Refuse to start.
   *
   * Refusing rather than cancelling is deliberate. The id encodes strategy,
   * symbol, direction and bar, but not *which run* placed it, so an order
   * carrying our shape could belong to a second bot on the same account and
   * the same symbol. Cancelling on that guess spends someone else's money.
   * Refusing cannot make anything worse, and it puts a human in front of a
   * genuinely ambiguous situation — which is the right place for one.
   *
   * Not covered here: whether the venue agrees about an open POSITION. On spot
   * a position is a balance rather than an order, so `fetchOpenOrders` cannot
   * see it, and checking it properly needs base-currency accounting that
   * differs per product line. Stated rather than silently implied.
   */
  private assertNoOrphans(open: readonly ExchangeOrder[]): void {
    const known = new Set<string>();
    if (this.resting !== null) {
      known.add(this.resting.order.orderId);
      known.add(exitOrderId(this.resting.order.orderId));
    }
    if (this.position !== null) {
      known.add(this.position.orderId);
      known.add(exitOrderId(this.position.orderId));
    }

    const orphans = open.filter(
      (order) => isBotOrderId(order.clientOrderId) && !known.has(order.clientOrderId as string),
    );

    if (orphans.length === 0) {
      const theirs = open.filter((order) => !isBotOrderId(order.clientOrderId));
      if (theirs.length > 0) {
        this.log(
          `reconciled: ${theirs.length} order(s) at the venue are not this bot's and were left alone`,
        );
      }
      return;
    }

    const described = orphans
      .map(
        (order) => `${order.clientOrderId} (venue id ${order.id}, ${order.side} ${order.amount})`,
      )
      .join(', ');

    throw new Error(
      `Refusing to start: the venue holds ${orphans.length} order(s) carrying this bot's id that ` +
        `the journal does not account for — ${described}. ` +
        'This means a previous run placed an order and died before recording it. ' +
        'Cancel the order at the venue (or move it into the journal) and start again. ' +
        'Nothing was cancelled automatically: the id does not say which run placed it, ' +
        'so it may belong to another bot on this account.',
    );
  }

  /**
   * Verify the venue still holds the coins the journal's open position says
   * we bought.
   *
   * On spot there is no position object — the position IS the base-currency
   * balance — so this counts the TOTAL balance, not the free one: a healthy
   * position's coins are LOCKED under its resting exit legs, and its free
   * balance is near zero precisely when everything is fine.
   *
   * Three outcomes:
   *
   *  - **Covered** — proceed.
   *  - **Short, and nothing rests on the symbol** — the exit legs are gone
   *    and so are the coins: the position was closed at the venue while we
   *    were away. NOT an error. The engine's catch-up settlement books that
   *    exit from the bars it replays, so this is logged loudly and left for
   *    it. Refusing here would break exactly the crash recovery the catch-up
   *    exists for.
   *  - **Short although exit orders still rest** — the order structure is
   *    intact but the coins are not: withdrawn or sold around the bot.
   *    Nothing can settle that from bars, so refuse to start.
   *
   * Tolerance: Bybit charges the buy-side fee in base currency on spot, so an
   * intact position legitimately holds size*(1-fee); one amountStep on top
   * covers dust rounding. The reverse direction — no position in the journal
   * but coins at the venue — is deliberately not judged: the operator's own
   * holdings are none of this bot's business.
   */
  private async reconcilePosition(open: readonly ExchangeOrder[]): Promise<void> {
    if (this.position === null) {
      return;
    }
    if (this.category === 'linear') {
      await this.reconcileLinearPosition(open);
      return;
    }

    const base = baseCurrency(this.symbol);
    const total = await this.retry('fetchTotalBalance', () => this.client.fetchTotalBalance(base));
    const needed =
      this.position.positionSize * (1 - this.feeRate) - this.requireMarket().amountStep;

    if (total >= needed) {
      this.log(`reconciled: position backed by ${total} ${base} at the venue`);
      return;
    }

    if (open.length === 0) {
      this.log(
        `reconciled: position ${this.position.orderId} appears CLOSED at the venue ` +
          `(${total} ${base} on hand, ~${this.position.positionSize} expected); ` +
          'catch-up settlement will book the exit from the missed bars',
      );
      return;
    }

    throw new Error(
      `Refusing to start: the journal holds an open position of ` +
        `${this.position.positionSize} ${base} on ${this.symbol}, exit orders still rest at ` +
        `the venue, yet the account's total is only ${total} ${base}. Coins were withdrawn ` +
        'or sold around the bot — nothing here can account for that. Reconcile the account ' +
        'by hand and start again.',
    );
  }

  /**
   * The linear counterpart: the venue HAS a position object, so ask for it
   * instead of counting coins.
   *
   * Same three-way split as spot, with one difference in what counts as a
   * mismatch: side and size are compared directly, because a linear position
   * that exists but points the other way — or has been partially closed
   * around the bot — is exactly as unaccountable as missing coins under
   * resting legs.
   */
  private async reconcileLinearPosition(open: readonly ExchangeOrder[]): Promise<void> {
    const trade = this.position as Trade;
    const wantSide = trade.signal.direction === Direction.Long ? 'long' : 'short';
    const venuePosition = await this.retry('fetchPosition', () =>
      this.client.fetchPosition(this.symbol),
    );

    if (venuePosition === null) {
      if (open.length === 0) {
        this.log(
          `reconciled: position ${trade.orderId} appears CLOSED at the venue; ` +
            'catch-up settlement will book the exit from the missed bars',
        );
        return;
      }
      throw new Error(
        `Refusing to start: the journal holds an open ${wantSide} on ${this.symbol} but the ` +
          'venue reports no position while orders still rest on the symbol. The position was ' +
          'closed around the bot; reconcile the account by hand and start again.',
      );
    }

    const shortBy = trade.positionSize - this.requireMarket().amountStep;
    if (venuePosition.side !== wantSide || venuePosition.size < shortBy) {
      throw new Error(
        `Refusing to start: the journal holds a ${wantSide} of ${trade.positionSize} on ` +
          `${this.symbol} but the venue reports a ${venuePosition.side} of ${venuePosition.size}. ` +
          'The position was traded around the bot; reconcile the account by hand and start again.',
      );
    }

    this.log(`reconciled: ${venuePosition.side} ${venuePosition.size} confirmed by the venue`);
  }

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

    const long = trade.signal.direction === Direction.Long;
    const dollarPnl =
      trade.positionSize * (long ? price - trade.entryPrice : trade.entryPrice - price);
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
