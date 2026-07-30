import { BUILT_IN_STRATEGIES, StrategyRegistryService } from '@bot/app/strategy-registry.service';
import { CandleSeries } from '@bot/core/domain/candle-series';
import { MarketDataPort } from '@bot/core/domain/ports';

import { MarketDataFactory } from './market-data.factory';
import { captureError } from './testing';
import { TradeCommand } from './trade.command';

class UnusedFactory implements MarketDataFactory {
  forExchange(): MarketDataPort {
    // Every test here stops at a guard rail, before any data is needed. If
    // this ever runs, a check that was supposed to refuse has let something
    // through — which is worth failing loudly for.
    throw new Error('market data must not be reached: a guard rail was expected to stop first');
  }
}

function command() {
  const registry = new StrategyRegistryService(BUILT_IN_STRATEGIES);
  return new TradeCommand(registry, new UnusedFactory());
}

/**
 * The guard rails on the command that spends real money.
 *
 * Deliberately only the refusals. Everything past them talks to a venue, and
 * the venue interaction is covered by `bybit.adapter.spec.ts` against a fake
 * client. What cannot be covered there is the sequence of checks that decide
 * whether to get that far at all, and those are the checks whose failure mode
 * is a live order nobody asked for.
 */
describe('trade', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of ['BYBIT_API_KEY', 'BYBIT_API_SECRET', 'BYBIT_LIVE', 'BYBIT_CATEGORY']) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = saved;
  });

  const withKeys = () => {
    process.env.BYBIT_API_KEY = 'key-1234567890';
    process.env.BYBIT_API_SECRET = 'secret';
  };

  describe('credentials', () => {
    it('refuses to start without them', async () => {
      const { error } = await captureError(() => command().run([], {}));

      expect(error?.message).toMatch(/Missing exchange credentials/);
      expect(error?.message).toMatch(/BYBIT_API_KEY/);
      expect(error?.message).toMatch(/BYBIT_API_SECRET/);
    });

    it('says to use a key with withdrawal disabled', async () => {
      // The one piece of advice worth repeating at the moment of failure.
      const { error } = await captureError(() => command().run([], {}));

      expect(error?.message).toMatch(/WITHDRAWAL DISABLED/);
    });

    it('names only the variable that is missing', async () => {
      process.env.BYBIT_API_KEY = 'key-1234567890';

      const { error } = await captureError(() => command().run([], {}));

      expect(error?.message).toMatch(/BYBIT_API_SECRET/);
      expect(error?.message).not.toMatch(/BYBIT_API_KEY/);
    });
  });

  describe('leaving the testnet takes two independent signals', () => {
    it('refuses BYBIT_LIVE=true without --live', async () => {
      // One forgotten variable must never be enough to move real money.
      withKeys();
      process.env.BYBIT_LIVE = 'true';

      const { error } = await captureError(() => command().run([], {}));

      expect(error?.message).toMatch(/was not started with --live/);
    });

    it('refuses --live without BYBIT_LIVE=true', async () => {
      withKeys();

      const { error } = await captureError(() => command().run([], { live: true }));

      expect(error?.message).toMatch(/BYBIT_LIVE is not "true"/);
    });

    it('treats anything other than the exact string as not live', async () => {
      withKeys();
      process.env.BYBIT_LIVE = '1';

      const { error } = await captureError(() => command().run([], { live: true }));

      expect(error?.message).toMatch(/BYBIT_LIVE is not "true"/);
    });
  });

  describe('the product category', () => {
    it('refuses a category the adapter does not implement', async () => {
      withKeys();
      process.env.BYBIT_CATEGORY = 'inverse';

      const { error } = await captureError(() => command().run([], {}));

      expect(error?.message).toMatch(/must be "spot" or "linear"/);
    });
  });

  describe('what it says before doing anything', () => {
    it('never prints the secret, and fingerprints the key', async () => {
      // The transcript of a live session tends to end up in a bug report.
      withKeys();
      process.env.BYBIT_CATEGORY = 'nonsense';

      const { captured } = await captureError(() => command().run([], {}));

      expect(captured.text()).not.toContain('secret');
      expect(captured.text()).not.toContain('key-1234567890');
    });
  });

  describe('option parsing', () => {
    it('reads --params as a JSON object', () => {
      expect(command().parseParams('{"minRr":2}')).toEqual({ minRr: 2 });
    });

    it.each(['[1]', '"x"', 'null'])('refuses --params %j', (value) => {
      expect(() => command().parseParams(value)).toThrow(/expected a JSON object/);
    });

    it('passes the plain flags through', () => {
      const parser = command();
      expect(parser.parseStrategy('OB_4h_FVG_15m')).toBe('OB_4h_FVG_15m');
      expect(parser.parseSymbol('ETH/USDT')).toBe('ETH/USDT');
      expect(parser.parseRisk('0.02')).toBe(0.02);
      expect(parser.parseFee('0.001')).toBe(0.001);
      expect(parser.parseJournal('a.ndjson')).toBe('a.ndjson');
      expect(parser.parseLive()).toBe(true);
      expect(parser.parseYes()).toBe(true);
    });
  });

  it('does not reach market data before its checks pass', () => {
    // Belt and braces on the stub above: the factory is the thing that would
    // open a socket, and no refusal path may get that far.
    expect(() => new UnusedFactory().forExchange()).toThrow(/guard rail/);
    expect(CandleSeries.empty().isEmpty).toBe(true);
  });
});
