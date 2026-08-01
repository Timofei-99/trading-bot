import { Candle } from '@bot/core/domain/candle-series';
import { JournalEvent, TradeJournalPort } from '@bot/core/domain/order';
import { Direction, Signal } from '@bot/core/domain/signal';
import { BybitAdapter } from './bybit.adapter';
import {
  ExchangeClient,
  ExchangeOrder,
  MarketSpec,
  PlaceLimitOrderRequest,
} from './exchange-client';

const SYMBOL = 'BTC/USDT';
const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i: number): number => T0 + i * M15;

function candle(i: number, high: number, low: number, close?: number): Candle {
  const mid = close ?? (high + low) / 2;
  return { time: bar(i), open: mid, high, low, close: mid, volume: 1 };
}

function makeSignal(
  entry = 100,
  stopLoss = 95,
  takeProfit = 110,
  expiryTime: number | null = null,
): Signal {
  return new Signal({
    symbol: SYMBOL,
    direction: Direction.Long,
    entry,
    stopLoss,
    takeProfit,
    timeframe: '15m',
    timestamp: bar(0),
    strategyName: 'test',
    strategyVersion: '1',
    expiryTime,
  });
}

class MemoryJournal implements TradeJournalPort {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  readAll(): JournalEvent[] {
    return [...this.events];
  }
}

/** A scriptable stand-in for Bybit. */
class FakeExchange implements ExchangeClient {
  readonly placed: PlaceLimitOrderRequest[] = [];
  readonly cancelled: string[] = [];
  readonly marketOrders: { side: string; amount: number; reduceOnly?: boolean }[] = [];
  readonly calls: string[] = [];

  orders = new Map<string, ExchangeOrder>();
  openOrders: ExchangeOrder[] = [];
  balance = 10_000;
  serverTime = T0;
  market: MarketSpec = { priceTick: 0.1, amountStep: 0.001, minAmount: 0.001, minNotional: 5 };
  /** How many times a given call should fail before succeeding. */
  failNext: Record<string, number> = {};

  private nextId = 1;

  private maybeFail(label: string): void {
    this.calls.push(label);
    const remaining = this.failNext[label] ?? 0;
    if (remaining > 0) {
      this.failNext[label] = remaining - 1;
      throw new Error('socket hang up');
    }
  }

  async loadMarket(): Promise<MarketSpec> {
    this.maybeFail('loadMarket');
    return this.market;
  }

  priceToPrecision(_symbol: string, price: number): number {
    return Math.round(price / this.market.priceTick) * this.market.priceTick;
  }

  amountToPrecision(_symbol: string, amount: number): number {
    return Math.floor(amount / this.market.amountStep) * this.market.amountStep;
  }

  async placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ExchangeOrder> {
    this.maybeFail('placeLimitOrder');
    // Idempotency, the way the venue enforces it.
    const existing = [...this.orders.values()].find(
      (order) => order.clientOrderId === request.clientOrderId,
    );
    if (existing !== undefined) {
      throw new Error('duplicate orderLinkId');
    }
    this.placed.push(request);
    const order: ExchangeOrder = {
      id: `ex-${this.nextId++}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      price: request.price,
      amount: request.amount,
      filled: 0,
      average: null,
      status: 'open',
      timestamp: T0,
      feeCost: null,
    };
    this.orders.set(order.id, order);
    this.openOrders = [order];
    return order;
  }

  async placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    _clientOrderId?: string,
    reduceOnly?: boolean,
  ): Promise<ExchangeOrder> {
    this.maybeFail('placeMarketOrder');
    this.marketOrders.push({ side, amount, reduceOnly });
    return {
      id: `ex-${this.nextId++}`,
      clientOrderId: null,
      symbol,
      side,
      price: 99,
      amount,
      filled: amount,
      average: 99,
      status: 'closed',
      timestamp: bar(9),
      feeCost: null,
    };
  }

  async cancelOrder(_symbol: string, id: string): Promise<void> {
    this.maybeFail('cancelOrder');
    this.cancelled.push(id);
    this.openOrders = this.openOrders.filter((order) => order.id !== id);
    const order = this.orders.get(id);
    if (order !== undefined) {
      this.orders.set(id, { ...order, status: 'canceled' });
    }
  }

  async fetchOrder(_symbol: string, id: string): Promise<ExchangeOrder> {
    this.maybeFail('fetchOrder');
    const order = this.orders.get(id);
    if (order === undefined) {
      throw new Error(`no order ${id}`);
    }
    return order;
  }

  async fetchOpenOrders(): Promise<ExchangeOrder[]> {
    this.maybeFail('fetchOpenOrders');
    return [...this.openOrders];
  }

  venuePosition: { side: 'long' | 'short'; size: number } | null = null;

  async fetchPosition(): Promise<{ side: 'long' | 'short'; size: number } | null> {
    this.maybeFail('fetchPosition');
    return this.venuePosition;
  }

  async fetchFreeBalance(): Promise<number> {
    this.maybeFail('fetchFreeBalance');
    return this.balance;
  }

  /** Per-currency totals; unset currencies fall back to `balance` so the
   *  existing quote-side tests keep working unchanged. */
  totals: Record<string, number> = {};

  async fetchTotalBalance(currency: string): Promise<number> {
    this.maybeFail('fetchTotalBalance');
    return this.totals[currency] ?? this.balance;
  }

  async fetchServerTime(): Promise<number> {
    this.maybeFail('fetchServerTime');
    return this.serverTime;
  }

  /** Test helper: mark the resting order as PARTIALLY filled, still open. */
  partiallyFill(id: string, filled: number, price: number, timeMs: number): void {
    const order = this.orders.get(id) as ExchangeOrder;
    this.orders.set(id, { ...order, filled, average: price, timestamp: timeMs });
  }

  /** Test helper: mark the resting order as fully filled. */
  fill(id: string, price: number, timeMs: number): void {
    const order = this.orders.get(id) as ExchangeOrder;
    this.orders.set(id, {
      ...order,
      status: 'closed',
      filled: order.amount,
      average: price,
      timestamp: timeMs,
    });
    this.openOrders = [];
  }
}

function adapterFor(
  exchange: FakeExchange,
  options: Partial<ConstructorParameters<typeof BybitAdapter>[1]> = {},
): BybitAdapter {
  return new BybitAdapter(exchange, {
    symbol: SYMBOL,
    riskPerTrade: 0.01,
    feeRate: 0.001,
    sleep: async () => undefined,
    retryBaseMs: 0,
    ...options,
  });
}

describe('BybitAdapter', () => {
  describe('startup', () => {
    it('refuses to trade with a skewed clock', async () => {
      const exchange = new FakeExchange();
      exchange.serverTime = T0 + 30_000;

      await expect(adapterFor(exchange).start(T0)).rejects.toThrow(/clock is 30000 ms from Bybit/);
    });

    it('loads market rules and the balance', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      expect(await adapter.getBalance()).toBe(10_000);
      expect(exchange.calls).toContain('loadMarket');
    });

    it('will not place an order before start()', async () => {
      await expect(adapterFor(new FakeExchange()).placeEntry(makeSignal())).rejects.toThrow(
        /start\(\) must run/,
      );
    });
  });

  describe('placing an entry', () => {
    it('sends a limit buy with attached TP/SL and our id as orderLinkId', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      const order = await adapter.placeEntry(makeSignal(100, 95, 110));

      expect(exchange.placed).toHaveLength(1);
      expect(exchange.placed[0]).toMatchObject({
        side: 'buy',
        price: 100,
        takeProfit: 110,
        stopLoss: 95,
        clientOrderId: order.orderId,
      });
    });

    it('rounds price and amount to the venue precision', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      await adapter.placeEntry(makeSignal(100.04, 95.06, 110.07));

      // priceTick 0.1, amountStep 0.001.
      expect(exchange.placed[0].price).toBeCloseTo(100, 9);
      expect(exchange.placed[0].takeProfit).toBeCloseTo(110.1, 9);
      const amount = exchange.placed[0].amount;
      expect(Math.round(amount / 0.001) * 0.001).toBeCloseTo(amount, 9);
    });

    it('never orders more than the balance can buy', async () => {
      const exchange = new FakeExchange();
      exchange.balance = 1_000;
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      // A 0.1-wide stop would ask risk-sizing for 100 units of a 100-priced asset.
      await adapter.placeEntry(makeSignal(100, 99.9, 110));

      const { amount, price } = exchange.placed[0];
      expect(amount * price).toBeLessThanOrEqual(1_000);
    });

    it('rejects an order below the venue minimum notional', async () => {
      const exchange = new FakeExchange();
      exchange.balance = 10; // 1% risk of 10 over a 5-wide stop => tiny
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      await expect(adapter.placeEntry(makeSignal(100, 95, 110))).rejects.toThrow(
        /below the venue minimum/,
      );
    });

    it('refuses a short on spot rather than selling', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);

      const short = new Signal({
        symbol: SYMBOL,
        direction: Direction.Short,
        entry: 100,
        stopLoss: 105,
        takeProfit: 90,
        timeframe: '15m',
        timestamp: bar(0),
        strategyName: 'test',
        strategyVersion: '1',
      });
      await expect(adapter.placeEntry(short)).rejects.toThrow(/long entries only/);
      expect(exchange.placed).toHaveLength(0);
    });

    it('refuses a second engagement', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      await adapter.placeEntry(makeSignal());

      await expect(adapter.placeEntry(makeSignal())).rejects.toThrow(/Already engaged/);
    });
  });

  describe('sync observes the venue', () => {
    async function withRestingEntry(): Promise<{ exchange: FakeExchange; adapter: BybitAdapter }> {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      await adapter.placeEntry(makeSignal(100, 95, 110));
      return { exchange, adapter };
    }

    it('opens a position when the venue reports a fill', async () => {
      const { exchange, adapter } = await withRestingEntry();
      exchange.fill('ex-1', 100, bar(2));

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });

      expect(result.settledEntries[0]?.status).toBe('filled');
      const position = await adapter.getPosition(SYMBOL);
      expect(position?.entryPrice).toBe(100);
      expect(position?.entryTime).toBe(bar(2));
    });

    it('books the take profit the venue executed', async () => {
      const { exchange, adapter } = await withRestingEntry();
      exchange.fill('ex-1', 100, bar(2));
      await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 111, 105) });

      expect(result.closed[0]?.exitReason).toBe('tp');
      expect(result.closed[0]?.exitPrice).toBe(110);
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });

    it('attributes a bar spanning both levels to the stop', async () => {
      const { exchange, adapter } = await withRestingEntry();
      exchange.fill('ex-1', 100, bar(2));
      await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 111, 94) });

      expect(result.closed[0]?.exitReason).toBe('sl');
      expect(result.closed[0]?.exitPrice).toBe(95);
    });

    it('does not book a close while the venue still shows working orders', async () => {
      const { exchange, adapter } = await withRestingEntry();
      exchange.fill('ex-1', 100, bar(2));
      await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });
      // The attached exit is still working — the exit has not completed.
      exchange.openOrders = [exchange.orders.get('ex-1') as ExchangeOrder];

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 111, 105) });

      expect(result.closed).toHaveLength(0);
      expect(await adapter.getPosition(SYMBOL)).not.toBeNull();
    });

    it('cancels a resting entry that outlived its timeout', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange, { entryTimeoutMs: 2 * M15 });
      await adapter.start(T0);
      await adapter.placeEntry(makeSignal());

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 101, 99) });

      expect(result.settledEntries[0]?.status).toBe('expired');
      expect(exchange.cancelled).toEqual(['ex-1']);
      expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
    });

    it('settles an entry the venue cancelled behind our back', async () => {
      const { exchange, adapter } = await withRestingEntry();
      exchange.orders.set('ex-1', {
        ...(exchange.orders.get('ex-1') as ExchangeOrder),
        status: 'canceled',
      });

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });

      expect(result.settledEntries[0]?.status).toBe('cancelled');
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });
  });

  describe('closePosition', () => {
    it('clears working exits, then market-sells', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      await adapter.placeEntry(makeSignal(100, 95, 110));
      exchange.fill('ex-1', 100, bar(2));
      await adapter.sync({ symbol: SYMBOL, candle: candle(2, 101, 99) });
      exchange.openOrders = [exchange.orders.get('ex-1') as ExchangeOrder];

      const trade = await adapter.closePosition(SYMBOL, 'strategy');

      expect(exchange.cancelled).toContain('ex-1');
      expect(exchange.marketOrders[0]).toMatchObject({ side: 'sell' });
      expect(trade?.exitReason).toBe('strategy');
      expect(trade?.exitPrice).toBe(99);
    });
  });

  describe('linear perpetuals', () => {
    const linearFor = (exchange: FakeExchange) => adapterFor(exchange, { category: 'linear' });

    const shortSignal = (entry = 100, stopLoss = 105, takeProfit = 90): Signal =>
      new Signal({
        symbol: SYMBOL,
        direction: Direction.Short,
        entry,
        stopLoss,
        takeProfit,
        timeframe: '15m',
        timestamp: bar(0),
        strategyName: 'test',
        strategyVersion: '1',
      });

    /** Place a short and fill it, returning the adapter mid-position. */
    async function openShort(exchange: FakeExchange): Promise<BybitAdapter> {
      const adapter = linearFor(exchange);
      await adapter.start(T0);
      const order = await adapter.placeEntry(shortSignal());
      exchange.fill(
        [...exchange.orders.values()].find((o) => o.clientOrderId === order.orderId)!.id,
        100,
        bar(1),
      );
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 99) });
      return adapter;
    }

    it('accepts a short and routes it as a limit SELL with mirrored exits', async () => {
      const exchange = new FakeExchange();
      const adapter = linearFor(exchange);
      await adapter.start(T0);

      await adapter.placeEntry(shortSignal(100, 105, 90));

      expect(exchange.placed[0]).toMatchObject({
        side: 'sell',
        price: 100,
        stopLoss: 105,
        takeProfit: 90,
      });
    });

    it('still refuses a short on spot', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange); // default: spot
      await adapter.start(T0);

      await expect(adapter.placeEntry(shortSignal())).rejects.toThrow(/long entries only/);
    });

    describe('a short position at the venue', () => {
      it('books the take-profit when price falls to it', async () => {
        // Mirrored geometry: the short's target is BELOW entry.
        const exchange = new FakeExchange();
        const adapter = await openShort(exchange);

        const [closed] = (await adapter.sync({ symbol: SYMBOL, candle: candle(2, 95, 89) })).closed;

        expect(closed.exitReason).toBe('tp');
        expect(closed.exitPrice).toBe(90);
      });

      it('books the stop when price rises to it', async () => {
        const exchange = new FakeExchange();
        const adapter = await openShort(exchange);

        const [closed] = (await adapter.sync({ symbol: SYMBOL, candle: candle(2, 106, 101) }))
          .closed;

        expect(closed.exitReason).toBe('sl');
        expect(closed.exitPrice).toBe(105);
      });

      it('still attributes a both-sides bar to the stop', async () => {
        // The conservative reading is direction-independent.
        const exchange = new FakeExchange();
        const adapter = await openShort(exchange);

        const [closed] = (await adapter.sync({ symbol: SYMBOL, candle: candle(2, 106, 89) }))
          .closed;

        expect(closed.exitReason).toBe('sl');
      });

      it('gains balance when the short closes below entry', async () => {
        // The long-only formula would book this winning short as a loss.
        const exchange = new FakeExchange();
        const adapter = await openShort(exchange);
        const before = await adapter.getBalance();

        await adapter.sync({ symbol: SYMBOL, candle: candle(2, 95, 89) });

        expect(await adapter.getBalance()).toBeGreaterThan(before);
      });

      it('closes a short by BUYING it back, reduce-only', async () => {
        const exchange = new FakeExchange();
        const adapter = await openShort(exchange);

        await adapter.closePosition(SYMBOL, 'strategy');

        expect(exchange.marketOrders[0]).toMatchObject({ side: 'buy', reduceOnly: true });
      });
    });

    it('closes a linear long with a reduce-only SELL', async () => {
      const exchange = new FakeExchange();
      const adapter = linearFor(exchange);
      await adapter.start(T0);
      const order = await adapter.placeEntry(makeSignal(100, 95, 110));
      exchange.fill(
        [...exchange.orders.values()].find((o) => o.clientOrderId === order.orderId)!.id,
        100,
        bar(1),
      );
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 99) });

      await adapter.closePosition(SYMBOL, 'strategy');

      expect(exchange.marketOrders[0]).toMatchObject({ side: 'sell', reduceOnly: true });
    });

    it('keeps the spot close free of reduce-only', async () => {
      // Bybit spot rejects the flag; sending it would turn every strategy
      // exit into an API error.
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      const order = await adapter.placeEntry(makeSignal(100, 95, 110));
      exchange.fill(
        [...exchange.orders.values()].find((o) => o.clientOrderId === order.orderId)!.id,
        100,
        bar(1),
      );
      await adapter.sync({ symbol: SYMBOL, candle: candle(1, 101, 99) });

      await adapter.closePosition(SYMBOL, 'strategy');

      expect(exchange.marketOrders[0].side).toBe('sell');
      expect(exchange.marketOrders[0].reduceOnly).toBeUndefined();
    });
  });

  describe('cancelling an entry that already (partly) filled', () => {
    async function placeResting(exchange: FakeExchange, adapter: BybitAdapter) {
      const order = await adapter.placeEntry(makeSignal(100, 95, 110));
      const venueId = [...exchange.orders.values()].find(
        (candidate) => candidate.clientOrderId === order.orderId,
      )!.id;
      return { order, venueId };
    }

    it('closes a partial fill at market instead of stranding it', async () => {
      // Cancelling kills the attached TP/SL along with the order, so the
      // filled part would sit at the venue protected by nothing and known to
      // nobody. It is adopted and immediately closed.
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      const { venueId } = await placeResting(exchange, adapter);
      exchange.partiallyFill(venueId, 0.4, 100, bar(1));

      const settled = await adapter.cancelEntry(SYMBOL);

      expect(settled?.status).toBe('filled');
      expect(exchange.marketOrders).toHaveLength(1);
      expect(exchange.marketOrders[0]).toMatchObject({ side: 'sell', amount: 0.4 });
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
      expect((await adapter.getClosedTrades()).at(-1)?.exitReason).toBe('manual');
    });

    it('keeps a position whose fill won the race with the cancel', async () => {
      // The cancel failing IS the signal: the order finished filling first,
      // and its attached exits went live at the venue. Nothing to unwind.
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      const { venueId } = await placeResting(exchange, adapter);
      exchange.fill(venueId, 100, bar(1));
      exchange.failNext.cancelOrder = 10;

      const settled = await adapter.cancelEntry(SYMBOL);

      expect(settled?.status).toBe('filled');
      expect(await adapter.getPosition(SYMBOL)).not.toBeNull();
      expect(exchange.marketOrders).toHaveLength(0);
    });

    it('still cancels cleanly when nothing filled', async () => {
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange);
      await adapter.start(T0);
      await placeResting(exchange, adapter);

      const settled = await adapter.cancelEntry(SYMBOL);

      expect(settled?.status).toBe('cancelled');
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
      expect(exchange.marketOrders).toHaveLength(0);
    });

    it('reports a timed-out partial as filled, not expired', async () => {
      // The timeout path funnels through the same cancel; the outcome that
      // reaches the engine must say what actually happened to the money.
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange, { entryTimeoutMs: M15 });
      await adapter.start(T0);
      const { venueId } = await placeResting(exchange, adapter);
      exchange.partiallyFill(venueId, 0.4, 100, bar(1));

      const result = await adapter.sync({ symbol: SYMBOL, candle: candle(3, 101, 99) });

      expect(result.settledEntries).toHaveLength(1);
      expect(result.settledEntries[0].status).toBe('filled');
      expect((await adapter.getClosedTrades()).at(-1)?.exitReason).toBe('manual');
    });
  });

  describe('resilience', () => {
    it('retries a transient failure with backoff', async () => {
      const exchange = new FakeExchange();
      exchange.failNext = { fetchServerTime: 1 };
      const adapter = adapterFor(exchange);

      await adapter.start(T0);

      expect(exchange.calls.filter((c) => c === 'fetchServerTime')).toHaveLength(2);
    });

    it('gives up after the retry budget and names the call', async () => {
      const exchange = new FakeExchange();
      exchange.failNext = { fetchServerTime: 99 };
      const adapter = adapterFor(exchange, { maxRetries: 3 });

      await expect(adapter.start(T0)).rejects.toThrow(
        /fetchServerTime failed after 4 attempts: socket hang up/,
      );
    });

    it('journals the entry before calling the venue, so a lost reply is recoverable', async () => {
      const journal = new MemoryJournal();
      const exchange = new FakeExchange();
      const adapter = adapterFor(exchange, { journal, maxRetries: 3 });
      await adapter.start(T0);

      // Only the order placement fails, and it fails every attempt.
      exchange.failNext = { placeLimitOrder: 99 };
      await expect(adapter.placeEntry(makeSignal())).rejects.toThrow(/placeLimitOrder failed/);

      // The id exists in the journal even though the call never succeeded —
      // reconciliation can now ask the venue what happened to it.
      expect(journal.events.some((event) => event.type === 'entry_placed')).toBe(true);
    });
  });

  describe('reconciliation on restart', () => {
    it('adopts a position that filled while the process was down', async () => {
      const journal = new MemoryJournal();
      const exchange = new FakeExchange();
      const first = adapterFor(exchange, { journal });
      await first.start(T0);
      await first.placeEntry(makeSignal(100, 95, 110));

      // Crash here. The venue fills the order in the meantime.
      exchange.fill('ex-1', 100, bar(4));

      const second = adapterFor(exchange, { journal });
      await second.start(T0);

      // The journal only knew of a placed order; reconciliation found the fill.
      const position = await second.getPosition(SYMBOL);
      expect(position?.entryPrice).toBe(100);
      expect(position?.entryTime).toBe(bar(4));
      expect(await second.getRestingEntry(SYMBOL)).toBeNull();
    });

    it('drops an entry the venue never acknowledged', async () => {
      const journal = new MemoryJournal();
      const exchange = new FakeExchange();
      // Journal an entry_placed with no matching venue order.
      journal.append({
        type: 'entry_placed',
        at: bar(0),
        orderId: 'orphan',
        positionSize: 0.1,
        signal: {
          symbol: SYMBOL,
          direction: Direction.Long,
          entry: 100,
          stopLoss: 95,
          takeProfit: 110,
          timeframe: '15m',
          timestamp: bar(0),
          strategyName: 'test',
          strategyVersion: '1',
        },
      });

      const adapter = adapterFor(exchange, { journal });
      await adapter.start(T0);

      expect(await adapter.getRestingEntry(SYMBOL)).toBeNull();
      expect(await adapter.getPosition(SYMBOL)).toBeNull();
    });

    it('keeps a still-resting entry', async () => {
      const journal = new MemoryJournal();
      const exchange = new FakeExchange();
      const first = adapterFor(exchange, { journal });
      await first.start(T0);
      const placed = await first.placeEntry(makeSignal());

      const second = adapterFor(exchange, { journal });
      await second.start(T0);

      expect((await second.getRestingEntry(SYMBOL))?.orderId).toBe(placed.orderId);
    });
  });
});
