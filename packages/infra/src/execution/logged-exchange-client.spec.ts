import { StructuredLogger } from '../logging/structured-logger';
import { ExchangeClient, ExchangeOrder } from './exchange-client';
import { LoggedExchangeClient } from './logged-exchange-client';

/**
 * The audit trail for everything that leaves the process.
 *
 * When something goes wrong with real money the only question is "what did we
 * send, and what came back?" — so the decorator has to record BOTH outcomes,
 * and must not change either one on the way through.
 */

const ORDER: ExchangeOrder = {
  id: 'venue-1',
  clientOrderId: 'bot-deadbeef',
  symbol: 'BTC/USDT',
  side: 'buy',
  price: 42_000,
  amount: 0.5,
  filled: 0,
  average: null,
  status: 'open',
  timestamp: 1_700_000_000_000,
  feeCost: null,
};

function stub(over: Partial<ExchangeClient> = {}): ExchangeClient {
  return {
    loadMarket: async () => ({
      priceTick: 0.01,
      amountStep: 0.001,
      minAmount: null,
      minNotional: null,
    }),
    priceToPrecision: (_symbol, price) => price,
    amountToPrecision: (_symbol, amount) => amount,
    placeLimitOrder: async () => ORDER,
    placeMarketOrder: async () => ORDER,
    cancelOrder: async () => undefined,
    fetchOrder: async () => ORDER,
    fetchOpenOrders: async () => [ORDER],
    fetchFreeBalance: async () => 1000,
    fetchTotalBalance: async () => 1500,
    fetchPosition: async () => null,
    fetchServerTime: async () => 1_700_000_000_000,
    ...over,
  };
}

interface Entry {
  level: 'info' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

function recorder(): { logger: StructuredLogger; entries: Entry[] } {
  const entries: Entry[] = [];
  const logger = {
    info: (message: string, fields: Record<string, unknown>) =>
      entries.push({ level: 'info', message, fields }),
    error: (message: string, fields: Record<string, unknown>) =>
      entries.push({ level: 'error', message, fields }),
  } as unknown as StructuredLogger;
  return { logger, entries };
}

describe('LoggedExchangeClient', () => {
  describe('on success', () => {
    it('records the call, its request and its result', async () => {
      const { logger, entries } = recorder();

      await new LoggedExchangeClient(stub(), logger).fetchOrder('BTC/USDT', 'venue-1');

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'info',
        message: 'exchange call',
        fields: { call: 'fetchOrder', request: { symbol: 'BTC/USDT', id: 'venue-1' } },
      });
      expect(entries[0].fields.result).toEqual(ORDER);
    });

    it('times the call', async () => {
      const { logger, entries } = recorder();

      await new LoggedExchangeClient(stub(), logger).fetchServerTime();

      expect(typeof entries[0].fields.durationMs).toBe('number');
      expect(entries[0].fields.durationMs as number).toBeGreaterThanOrEqual(0);
    });

    it('returns exactly what the inner client returned', async () => {
      // A decorator that alters the value would make the log a record of
      // something that never happened.
      const { logger } = recorder();

      const result = await new LoggedExchangeClient(stub(), logger).fetchOpenOrders('BTC/USDT');

      expect(result).toEqual([ORDER]);
    });

    it('records the idempotency key that was sent', async () => {
      // The single field worth being able to look up afterwards: it is what
      // says whether a duplicate was our fault or the venue's.
      const { logger, entries } = recorder();

      await new LoggedExchangeClient(stub(), logger).placeLimitOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        amount: 0.5,
        price: 42_000,
        clientOrderId: 'bot-deadbeef',
      });

      expect(entries[0].fields.request).toMatchObject({
        request: { clientOrderId: 'bot-deadbeef' },
      });
    });
  });

  describe('on failure', () => {
    it('records the failure and rethrows', async () => {
      const { logger, entries } = recorder();
      const client = new LoggedExchangeClient(
        stub({
          placeLimitOrder: async () => {
            throw new Error('insufficient balance');
          },
        }),
        logger,
      );

      await expect(
        client.placeLimitOrder({
          symbol: 'BTC/USDT',
          side: 'buy',
          amount: 0.5,
          price: 42_000,
          clientOrderId: 'bot-1',
        }),
      ).rejects.toThrow('insufficient balance');

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'error',
        message: 'exchange call failed',
        fields: { call: 'placeLimitOrder', error: 'insufficient balance' },
      });
    });

    it('still records the request that failed', async () => {
      // A failed placement is the case where knowing what was sent matters
      // most — the order may have reached the venue anyway.
      const { logger, entries } = recorder();
      const client = new LoggedExchangeClient(
        stub({
          placeMarketOrder: async () => {
            throw new Error('timeout');
          },
        }),
        logger,
      );

      await expect(client.placeMarketOrder('BTC/USDT', 'sell', 0.5, 'bot-1-x')).rejects.toThrow();

      expect(entries[0].fields.request).toEqual({
        symbol: 'BTC/USDT',
        side: 'sell',
        amount: 0.5,
        clientOrderId: 'bot-1-x',
      });
    });
  });

  describe('pass-through', () => {
    it('logs every asynchronous call', async () => {
      const { logger, entries } = recorder();
      const client = new LoggedExchangeClient(stub(), logger);

      await client.loadMarket('BTC/USDT');
      await client.cancelOrder('BTC/USDT', 'venue-1');
      await client.fetchFreeBalance('USDT');
      await client.fetchTotalBalance('BTC');
      await client.fetchServerTime();

      expect(entries.map((entry) => entry.fields.call)).toEqual([
        'loadMarket',
        'cancelOrder',
        'fetchFreeBalance',
        'fetchTotalBalance',
        'fetchServerTime',
      ]);
    });

    it('does not log the synchronous rounding helpers', async () => {
      // They are pure arithmetic against an already-loaded market: no request
      // leaves the process, so logging them would only bury the calls that do.
      const { logger, entries } = recorder();
      const client = new LoggedExchangeClient(stub(), logger);

      expect(client.priceToPrecision('BTC/USDT', 42_000.5)).toBe(42_000.5);
      expect(client.amountToPrecision('BTC/USDT', 0.5)).toBe(0.5);
      expect(entries).toHaveLength(0);
    });
  });
});
