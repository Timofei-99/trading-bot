import type { Exchange } from 'ccxt';

/**
 * The slice of an exchange this bot actually uses.
 *
 * Narrow on purpose: `BybitAdapter` depends on this, not on ccxt, so its
 * order lifecycle — idempotency, precision, reconciliation, retries — is
 * testable offline against a fake. The ccxt implementation below is the only
 * place that knows about the library.
 */

export interface MarketSpec {
  /** Smallest price increment; a price must be a multiple of it. */
  readonly priceTick: number;
  /** Smallest quantity increment. */
  readonly amountStep: number;
  readonly minAmount: number | null;
  readonly minNotional: number | null;
}

export type ExchangeOrderStatus = 'open' | 'closed' | 'canceled' | 'rejected' | 'expired';

export interface ExchangeOrder {
  readonly id: string;
  /** Our idempotency key, echoed back by the venue (Bybit orderLinkId). */
  readonly clientOrderId: string | null;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly price: number | null;
  readonly amount: number;
  readonly filled: number;
  /** Volume-weighted fill price when the venue reports one. */
  readonly average: number | null;
  readonly status: ExchangeOrderStatus;
  readonly timestamp: number | null;
  /** Fee actually charged, when reported. */
  readonly feeCost: number | null;
}

export interface PlaceLimitOrderRequest {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly amount: number;
  readonly price: number;
  readonly clientOrderId: string;
  /** Attached exit levels, so they live at the venue rather than in this process. */
  readonly takeProfit?: number;
  readonly stopLoss?: number;
}

export interface ExchangeClient {
  loadMarket(symbol: string): Promise<MarketSpec>;
  /** Round a price DOWN/UP to the venue's tick, per the venue's own rules. */
  priceToPrecision(symbol: string, price: number): number;
  amountToPrecision(symbol: string, amount: number): number;

  placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ExchangeOrder>;
  placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    clientOrderId: string,
  ): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, id: string): Promise<void>;

  fetchOrder(symbol: string, id: string): Promise<ExchangeOrder>;
  fetchOpenOrders(symbol: string): Promise<ExchangeOrder[]>;
  /** Free balance of a currency, e.g. the quote currency of the pair. */
  fetchFreeBalance(currency: string): Promise<number>;
  /** Venue clock, for detecting a skewed local clock before signing requests. */
  fetchServerTime(): Promise<number>;
}

// ---------------------------------------------------------------------------

export interface CcxtExchangeClientOptions {
  readonly exchangeId?: string;
  readonly apiKey: string;
  readonly secret: string;
  /** Testnet / demo endpoints. Anything but an explicit false stays sandboxed. */
  readonly sandbox: boolean;
  /** Bybit product line: `spot` today, `linear` when perpetuals are wired. */
  readonly category?: 'spot' | 'linear';
  readonly recvWindowMs?: number;
}

export class CcxtExchangeClient implements ExchangeClient {
  private exchange: Exchange | null = null;
  private readonly category: 'spot' | 'linear';

  constructor(private readonly options: CcxtExchangeClientOptions) {
    this.category = options.category ?? 'spot';
  }

  async loadMarket(symbol: string): Promise<MarketSpec> {
    const exchange = this.connect();
    await exchange.loadMarkets();
    const market = exchange.market(symbol);

    const limits = market.limits as {
      amount?: { min?: number };
      cost?: { min?: number };
    };
    return {
      priceTick: Number(market.precision.price ?? 0),
      amountStep: Number(market.precision.amount ?? 0),
      minAmount: limits.amount?.min ?? null,
      minNotional: limits.cost?.min ?? null,
    };
  }

  priceToPrecision(symbol: string, price: number): number {
    return Number(this.connect().priceToPrecision(symbol, price));
  }

  amountToPrecision(symbol: string, amount: number): number {
    return Number(this.connect().amountToPrecision(symbol, amount));
  }

  async placeLimitOrder(request: PlaceLimitOrderRequest): Promise<ExchangeOrder> {
    const params: Record<string, unknown> = {
      category: this.category,
      // Bybit's idempotency key: a retry carrying the same value is rejected
      // by the venue instead of opening a second position.
      orderLinkId: request.clientOrderId,
    };
    if (request.takeProfit !== undefined) {
      params.takeProfit = String(request.takeProfit);
    }
    if (request.stopLoss !== undefined) {
      params.stopLoss = String(request.stopLoss);
    }

    const order = await this.connect().createOrder(
      request.symbol,
      'limit',
      request.side,
      request.amount,
      request.price,
      params,
    );
    return normalize(order);
  }

  async placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    clientOrderId: string,
  ): Promise<ExchangeOrder> {
    const order = await this.connect().createOrder(symbol, 'market', side, amount, undefined, {
      category: this.category,
      orderLinkId: clientOrderId,
    });
    return normalize(order);
  }

  async cancelOrder(symbol: string, id: string): Promise<void> {
    await this.connect().cancelOrder(id, symbol, { category: this.category });
  }

  async fetchOrder(symbol: string, id: string): Promise<ExchangeOrder> {
    return normalize(await this.connect().fetchOrder(id, symbol, { category: this.category }));
  }

  async fetchOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    const orders = await this.connect().fetchOpenOrders(symbol, undefined, undefined, {
      category: this.category,
    });
    return orders.map(normalize);
  }

  async fetchFreeBalance(currency: string): Promise<number> {
    const balance = await this.connect().fetchBalance({ category: this.category });
    const free = (balance.free ?? {}) as unknown as Record<string, number | undefined>;
    return Number(free[currency] ?? 0);
  }

  async fetchServerTime(): Promise<number> {
    return Number(await this.connect().fetchTime());
  }

  private connect(): Exchange {
    if (this.exchange === null) {
      // Lazy, like the candle repository: ccxt drags in a large ESM tree and
      // nothing loads it unless live trading is actually configured.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ccxt = require('ccxt') as Record<string, new (config: unknown) => Exchange>;
      const exchangeId = this.options.exchangeId ?? 'bybit';

      const factory = ccxt[exchangeId];
      if (typeof factory !== 'function') {
        throw new Error(`Unknown ccxt exchange: ${exchangeId}`);
      }
      const exchange = new factory({
        apiKey: this.options.apiKey,
        secret: this.options.secret,
        enableRateLimit: true,
        options: {
          defaultType: this.category,
          recvWindow: this.options.recvWindowMs ?? 5_000,
        },
      });
      if (this.options.sandbox) {
        exchange.setSandboxMode(true);
      }
      this.exchange = exchange;
    }
    return this.exchange;
  }
}

/** ccxt's unified order shape, narrowed to what we rely on. */
interface CcxtOrder {
  id?: string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  price?: number;
  amount?: number;
  filled?: number;
  average?: number;
  status?: string;
  timestamp?: number;
  fee?: { cost?: number };
  info?: Record<string, unknown>;
}

function normalize(raw: unknown): ExchangeOrder {
  const order = raw as CcxtOrder;
  const info = order.info ?? {};
  return {
    id: String(order.id ?? ''),
    clientOrderId: order.clientOrderId ?? (info.orderLinkId as string | undefined) ?? null,
    symbol: String(order.symbol ?? ''),
    side: order.side === 'sell' ? 'sell' : 'buy',
    price: order.price ?? null,
    amount: Number(order.amount ?? 0),
    filled: Number(order.filled ?? 0),
    average: order.average ?? null,
    status: normalizeStatus(order.status),
    timestamp: order.timestamp ?? null,
    feeCost: order.fee?.cost ?? null,
  };
}

function normalizeStatus(status: string | undefined): ExchangeOrderStatus {
  switch (status) {
    case 'closed':
      return 'closed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return 'open';
  }
}
