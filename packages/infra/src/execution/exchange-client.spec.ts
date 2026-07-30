import { CcxtExchangeClient } from './exchange-client';

/**
 * The wire layer, tested against a fake ccxt.
 *
 * This is the only place that knows what actually leaves the process, and it
 * had no tests at all. What matters most here is not the happy path but the
 * two things a venue reads and we cannot see afterwards: the idempotency key
 * on every mutating call, and the sandbox flag.
 */

interface Recorded {
  method: string;
  args: unknown[];
}

const calls: Recorded[] = [];
let sandboxCalls: boolean[] = [];
let nextOrder: Record<string, unknown> = {};
let nextOpenOrders: Record<string, unknown>[] = [];
let constructed: unknown[] = [];

class FakeExchange {
  constructor(config: unknown) {
    constructed.push(config);
  }
  setSandboxMode(on: boolean) {
    sandboxCalls.push(on);
  }
  async loadMarkets() {
    calls.push({ method: 'loadMarkets', args: [] });
  }
  market(symbol: string) {
    calls.push({ method: 'market', args: [symbol] });
    return {
      precision: { price: 0.01, amount: 0.000001 },
      limits: { amount: { min: 0.0001 }, cost: { min: 5 } },
    };
  }
  priceToPrecision(_symbol: string, price: number) {
    return String(Math.round(price * 100) / 100);
  }
  amountToPrecision(_symbol: string, amount: number) {
    return String(Math.round(amount * 1e6) / 1e6);
  }
  async createOrder(...args: unknown[]) {
    calls.push({ method: 'createOrder', args });
    return nextOrder;
  }
  async cancelOrder(...args: unknown[]) {
    calls.push({ method: 'cancelOrder', args });
  }
  async fetchOrder(...args: unknown[]) {
    calls.push({ method: 'fetchOrder', args });
    return nextOrder;
  }
  async fetchOpenOrders(...args: unknown[]) {
    calls.push({ method: 'fetchOpenOrders', args });
    return nextOpenOrders;
  }
  async fetchBalance(...args: unknown[]) {
    calls.push({ method: 'fetchBalance', args });
    return { free: { USDT: 1234.5 }, total: { USDT: 2000, BTC: 0.5 } };
  }
  async fetchTime() {
    calls.push({ method: 'fetchTime', args: [] });
    return 1_700_000_000_000;
  }
}

jest.mock('ccxt', () => ({ bybit: FakeExchange, binance: FakeExchange }), { virtual: true });

const client = (over: Partial<ConstructorParameters<typeof CcxtExchangeClient>[0]> = {}) =>
  new CcxtExchangeClient({ apiKey: 'k', secret: 's', sandbox: true, ...over });

beforeEach(() => {
  calls.length = 0;
  sandboxCalls = [];
  constructed = [];
  nextOrder = {};
  nextOpenOrders = [];
});

const argsOf = (method: string): unknown[] =>
  (calls.find((call) => call.method === method) as Recorded).args;

describe('connecting', () => {
  it('stays sandboxed when asked', async () => {
    await client({ sandbox: true }).fetchServerTime();

    expect(sandboxCalls).toEqual([true]);
  });

  it('does not touch sandbox mode when it is off', async () => {
    // Explicitly NOT `setSandboxMode(false)`: leaving the call out entirely
    // means a future ccxt that defaults differently cannot be silently
    // switched to live by this code.
    await client({ sandbox: false }).fetchServerTime();

    expect(sandboxCalls).toEqual([]);
  });

  it('builds the exchange once and reuses it', async () => {
    const subject = client();

    await subject.fetchServerTime();
    await subject.fetchServerTime();

    expect(constructed).toHaveLength(1);
  });

  it('passes the product category as the default type', async () => {
    await client({ category: 'linear' }).fetchServerTime();

    expect(constructed[0]).toMatchObject({ options: { defaultType: 'linear' } });
  });

  it('defaults the category to spot', async () => {
    await client().fetchServerTime();

    expect(constructed[0]).toMatchObject({ options: { defaultType: 'spot' } });
  });

  it('sends a recvWindow, so a slow request is rejected rather than replayed late', async () => {
    await client({ recvWindowMs: 9_000 }).fetchServerTime();

    expect(constructed[0]).toMatchObject({ options: { recvWindow: 9_000 } });
  });

  it('refuses an exchange ccxt does not have', async () => {
    await expect(client({ exchangeId: 'nosuch' }).fetchServerTime()).rejects.toThrow(
      /Unknown ccxt exchange: nosuch/,
    );
  });
});

describe('placing orders', () => {
  it('sends the client order id as the venue idempotency key', async () => {
    // The whole restart-safety story rests on this one parameter reaching the
    // venue; nothing downstream can compensate if it does not.
    await client().placeLimitOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      price: 42_000,
      clientOrderId: 'bot-deadbeef',
    });

    const params = argsOf('createOrder')[5] as Record<string, unknown>;
    expect(params.orderLinkId).toBe('bot-deadbeef');
  });

  it('sends it on a market order too', async () => {
    await client().placeMarketOrder('BTC/USDT', 'sell', 0.5, 'bot-deadbeef-x');

    const params = argsOf('createOrder')[5] as Record<string, unknown>;
    expect(params.orderLinkId).toBe('bot-deadbeef-x');
  });

  it('attaches the exits to the order so they live at the venue', async () => {
    // Exits held in this process die with it; exits at the venue do not.
    await client().placeLimitOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      price: 42_000,
      clientOrderId: 'bot-1',
      takeProfit: 44_000,
      stopLoss: 41_000,
    });

    const params = argsOf('createOrder')[5] as Record<string, unknown>;
    expect(params).toMatchObject({ takeProfit: '44000', stopLoss: '41000' });
  });

  it('omits exits that were not asked for', async () => {
    await client().placeLimitOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      price: 42_000,
      clientOrderId: 'bot-1',
    });

    const params = argsOf('createOrder')[5] as Record<string, unknown>;
    expect(params).not.toHaveProperty('takeProfit');
    expect(params).not.toHaveProperty('stopLoss');
  });

  it('threads the category through every call', async () => {
    const subject = client({ category: 'linear' });

    await subject.cancelOrder('BTC/USDT', 'id-1');

    expect(argsOf('cancelOrder')[2]).toEqual({ category: 'linear' });
  });
});

describe('normalizing what comes back', () => {
  it('reads the idempotency key ccxt surfaces', async () => {
    nextOrder = { id: '1', clientOrderId: 'bot-abc', symbol: 'BTC/USDT', status: 'open' };

    const order = await client().fetchOrder('BTC/USDT', '1');

    expect(order.clientOrderId).toBe('bot-abc');
  });

  it('falls back to the raw Bybit field when ccxt does not map it', async () => {
    // Without this, an order we placed comes back unrecognisable and
    // reconciliation treats our own order as a stranger's.
    nextOrder = { id: '1', symbol: 'BTC/USDT', info: { orderLinkId: 'bot-abc' } };

    expect((await client().fetchOrder('BTC/USDT', '1')).clientOrderId).toBe('bot-abc');
  });

  it('reports no key rather than inventing one', async () => {
    nextOrder = { id: '1', symbol: 'BTC/USDT' };

    expect((await client().fetchOrder('BTC/USDT', '1')).clientOrderId).toBeNull();
  });

  it.each([
    ['closed', 'closed'],
    ['canceled', 'canceled'],
    // ccxt has shipped both spellings; both mean the order is gone.
    ['cancelled', 'canceled'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
  ])('maps status %s to %s', async (raw, expected) => {
    nextOrder = { id: '1', status: raw };

    expect((await client().fetchOrder('BTC/USDT', '1')).status).toBe(expected);
  });

  it('treats an unknown or absent status as still open', async () => {
    // The safe direction: believing a live order is gone would let a second
    // one be placed alongside it.
    nextOrder = { id: '1', status: 'something-new' };

    expect((await client().fetchOrder('BTC/USDT', '1')).status).toBe('open');
  });

  it('defaults a missing side to buy but keeps an explicit sell', async () => {
    nextOrder = { id: '1', side: 'sell' };
    expect((await client().fetchOrder('BTC/USDT', '1')).side).toBe('sell');

    nextOrder = { id: '1' };
    expect((await client().fetchOrder('BTC/USDT', '1')).side).toBe('buy');
  });

  it('keeps absent numbers null rather than zero', async () => {
    // A null price means "the venue did not say"; a zero price is a claim.
    nextOrder = { id: '1' };

    const order = await client().fetchOrder('BTC/USDT', '1');

    expect(order.price).toBeNull();
    expect(order.average).toBeNull();
    expect(order.timestamp).toBeNull();
    expect(order.feeCost).toBeNull();
    expect(order.filled).toBe(0);
  });

  it('carries the fee the venue actually charged', async () => {
    nextOrder = { id: '1', fee: { cost: 0.42 } };

    expect((await client().fetchOrder('BTC/USDT', '1')).feeCost).toBe(0.42);
  });

  it('normalizes every open order', async () => {
    nextOpenOrders = [
      { id: '1', status: 'open' },
      { id: '2', status: 'cancelled' },
    ];

    const orders = await client().fetchOpenOrders('BTC/USDT');

    expect(orders.map((order) => order.status)).toEqual(['open', 'canceled']);
  });
});

describe('market data', () => {
  it('reads tick, step and minimums from the market', async () => {
    const spec = await client().loadMarket('BTC/USDT');

    expect(spec).toEqual({
      priceTick: 0.01,
      amountStep: 0.000001,
      minAmount: 0.0001,
      minNotional: 5,
    });
  });

  it('rounds through the venue rather than by hand', async () => {
    const subject = client();

    expect(subject.priceToPrecision('BTC/USDT', 42_000.567)).toBe(42_000.57);
    expect(subject.amountToPrecision('BTC/USDT', 0.1234567891)).toBe(0.123457);
  });

  it('reads the free balance of one currency', async () => {
    expect(await client().fetchFreeBalance('USDT')).toBe(1234.5);
  });

  it('reports zero for a currency the account does not hold', async () => {
    expect(await client().fetchFreeBalance('DOGE')).toBe(0);
  });

  it('reads the total balance, free plus locked', async () => {
    // The position-side reconcile counts coins locked under exit legs; `free`
    // would read an intact position as missing.
    expect(await client().fetchTotalBalance('BTC')).toBe(0.5);
  });

  it('reports zero total for a currency the account does not hold', async () => {
    expect(await client().fetchTotalBalance('DOGE')).toBe(0);
  });

  it('reads the venue clock', async () => {
    expect(await client().fetchServerTime()).toBe(1_700_000_000_000);
  });
});
