import { MarketSpec } from './exchange-client';

/**
 * The venue's own rules about what it will accept.
 *
 * Kept apart from the adapter because these are pure arithmetic over numbers
 * the venue published, and the failure they prevent — an order rejected at
 * placement, after the signal has already been consumed — is worth being able
 * to test exhaustively without an exchange in the loop.
 */

/**
 * Throw unless the venue would accept this order.
 *
 * All three checks are "too small" checks, and they are separate because the
 * remedies differ: a size that rounds to zero means the stop is too wide for
 * the balance, a size under the minimum means the venue will not trade that
 * little, and a notional under the minimum means it will not trade that little
 * *value*. Collapsing them into one message would make the operator guess.
 */
export function assertTradeable(
  market: MarketSpec,
  symbol: string,
  amount: number,
  price: number,
): void {
  if (!(amount > 0)) {
    throw new Error(`Position size rounds to ${amount}: balance too small for this stop distance`);
  }
  if (market.minAmount !== null && amount < market.minAmount) {
    throw new Error(
      `Position size ${amount} is below the venue minimum ${market.minAmount} for ${symbol}`,
    );
  }
  if (market.minNotional !== null && amount * price < market.minNotional) {
    throw new Error(
      `Order notional ${(amount * price).toFixed(2)} is below the venue minimum ${market.minNotional}`,
    );
  }
}

/**
 * The currency an order is priced and funded in.
 *
 * `BTC/USDT` -> `USDT`, and `BTC/USDT:USDT` (a linear perpetual) -> `USDT`:
 * the settlement suffix after the colon names the same currency and would
 * otherwise be read as part of it.
 */
export function quoteCurrency(symbol: string): string {
  const parts = symbol.split('/');
  if (parts.length !== 2 || parts[1] === '') {
    throw new Error(`Cannot read the quote currency from ${JSON.stringify(symbol)}`);
  }
  return parts[1].split(':')[0];
}
