import { StructuredLogger } from '../logging/structured-logger';
import {
  ExchangeClient,
  ExchangeOrder,
  MarketSpec,
  PlaceLimitOrderRequest,
} from './exchange-client';

/**
 * Records every exchange call and its outcome.
 *
 * When something goes wrong with real money, the only question that matters is
 * "what exactly did we send, and what came back?" — and it is unanswerable
 * after the fact unless it was written down as it happened. A decorator keeps
 * that out of `BybitAdapter`, the same way the cache decorator keeps
 * gap-filling out of the ccxt repository.
 *
 * Arguments and results are redacted by the logger before they are written.
 */
export class LoggedExchangeClient implements ExchangeClient {
  constructor(
    private readonly inner: ExchangeClient,
    private readonly log: StructuredLogger,
  ) {}

  async loadMarket(symbol: string): Promise<MarketSpec> {
    return this.record('loadMarket', { symbol }, () => this.inner.loadMarket(symbol));
  }

  priceToPrecision(symbol: string, price: number): number {
    return this.inner.priceToPrecision(symbol, price);
  }

  amountToPrecision(symbol: string, amount: number): number {
    return this.inner.amountToPrecision(symbol, amount);
  }

  async placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ExchangeOrder> {
    return this.record('placeLimitOrder', { request }, () => this.inner.placeLimitOrder(request));
  }

  async placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    clientOrderId: string,
  ): Promise<ExchangeOrder> {
    return this.record('placeMarketOrder', { symbol, side, amount, clientOrderId }, () =>
      this.inner.placeMarketOrder(symbol, side, amount, clientOrderId),
    );
  }

  async cancelOrder(symbol: string, id: string): Promise<void> {
    return this.record('cancelOrder', { symbol, id }, () => this.inner.cancelOrder(symbol, id));
  }

  async fetchOrder(symbol: string, id: string): Promise<ExchangeOrder> {
    return this.record('fetchOrder', { symbol, id }, () => this.inner.fetchOrder(symbol, id));
  }

  async fetchOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    return this.record('fetchOpenOrders', { symbol }, () => this.inner.fetchOpenOrders(symbol));
  }

  async fetchFreeBalance(currency: string): Promise<number> {
    return this.record('fetchFreeBalance', { currency }, () =>
      this.inner.fetchFreeBalance(currency),
    );
  }

  async fetchServerTime(): Promise<number> {
    return this.record('fetchServerTime', {}, () => this.inner.fetchServerTime());
  }

  private async record<T>(
    call: string,
    request: Record<string, unknown>,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await invoke();
      this.log.info('exchange call', {
        call,
        request,
        result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.log.error('exchange call failed', {
        call,
        request,
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
}
