import { MarketSpec } from './exchange-client';
import { assertTradeable, quoteCurrency } from './venue-limits';

const market = (over: Partial<MarketSpec> = {}): MarketSpec => ({
  priceTick: 0.01,
  amountStep: 0.000001,
  minAmount: 0.0001,
  minNotional: 5,
  ...over,
});

describe('assertTradeable', () => {
  it('accepts an order comfortably above every minimum', () => {
    expect(() => assertTradeable(market(), 'BTC/USDT', 0.5, 42_000)).not.toThrow();
  });

  describe('rejects, with a message that names the remedy', () => {
    it('a size that rounded away to nothing', () => {
      // The cause is a stop so wide that the risk budget buys nothing, which
      // is a different problem from being under a venue floor.
      expect(() => assertTradeable(market(), 'BTC/USDT', 0, 42_000)).toThrow(
        /balance too small for this stop distance/,
      );
    });

    it('a negative size', () => {
      expect(() => assertTradeable(market(), 'BTC/USDT', -1, 42_000)).toThrow(
        /balance too small for this stop distance/,
      );
    });

    it('a size below the venue minimum', () => {
      expect(() => assertTradeable(market(), 'BTC/USDT', 0.00001, 42_000)).toThrow(
        /below the venue minimum 0.0001 for BTC\/USDT/,
      );
    });

    it('a notional below the venue minimum', () => {
      // Size clears its floor; the value does not. 0.001 * 4200 = 4.20 < 5.
      expect(() => assertTradeable(market(), 'BTC/USDT', 0.001, 4_200)).toThrow(
        /notional 4.20 is below the venue minimum 5/,
      );
    });
  });

  describe('when the venue publishes no floor', () => {
    it('does not invent a minimum size', () => {
      expect(() =>
        assertTradeable(market({ minAmount: null, minNotional: null }), 'BTC/USDT', 1e-8, 42_000),
      ).not.toThrow();
    });

    it('does not invent a minimum notional', () => {
      expect(() =>
        assertTradeable(market({ minNotional: null }), 'BTC/USDT', 0.0001, 1),
      ).not.toThrow();
    });
  });

  it('accepts an order exactly on the minimums', () => {
    // The floors are inclusive; rejecting the boundary would quietly raise them.
    expect(() =>
      assertTradeable(market({ minNotional: 4.2 }), 'BTC/USDT', 0.0001, 42_000),
    ).not.toThrow();
  });
});

describe('quoteCurrency', () => {
  it('reads the currency an order is funded in', () => {
    expect(quoteCurrency('BTC/USDT')).toBe('USDT');
  });

  it('strips the settlement suffix of a linear perpetual', () => {
    // `BTC/USDT:USDT` settles in the same currency it is quoted in; without
    // this the balance lookup asks for a currency the account does not hold.
    expect(quoteCurrency('BTC/USDT:USDT')).toBe('USDT');
  });

  it.each(['BTCUSDT', 'BTC/', '', 'BTC/USDT/EXTRA'])('refuses %j', (symbol) => {
    expect(() => quoteCurrency(symbol)).toThrow(/Cannot read the quote currency/);
  });
});
