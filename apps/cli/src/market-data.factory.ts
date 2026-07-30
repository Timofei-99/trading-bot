import { MarketDataPort } from '@bot/core/domain/ports';
import { CcxtCandleRepository } from '@bot/infra/market-data/ccxt-candle.repository';
import { Injectable } from '@nestjs/common';

export const MARKET_DATA_FACTORY = Symbol('MARKET_DATA_FACTORY');

/**
 * Where the live commands get their candles from.
 *
 * A seam rather than a `new` inside `run()`, for two reasons. The obvious one
 * is that a command which constructs a network client cannot be tested at all
 * — `paper` and `trade` were both at 0% for exactly this reason. The less
 * obvious one is that the exchange id is configuration, and configuration
 * belongs to the container rather than to a method body.
 */
export interface MarketDataFactory {
  forExchange(exchangeId: string): MarketDataPort;
}

@Injectable()
export class CcxtMarketDataFactory implements MarketDataFactory {
  forExchange(exchangeId: string): MarketDataPort {
    return new CcxtCandleRepository({ exchangeId });
  }
}
