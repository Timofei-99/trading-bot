import { describeCredentials, loadExchangeCredentials } from './exchange-config';

const KEYS = { BYBIT_API_KEY: 'abcd1234efgh', BYBIT_API_SECRET: 'super-secret-value' };

describe('loadExchangeCredentials', () => {
  it('defaults to the testnet', () => {
    const credentials = loadExchangeCredentials({ env: { ...KEYS } });

    expect(credentials.sandbox).toBe(true);
    expect(credentials.category).toBe('spot');
    expect(credentials.exchangeId).toBe('bybit');
  });

  it('names every missing variable at once', () => {
    expect(() => loadExchangeCredentials({ env: {} })).toThrow(
      /BYBIT_API_KEY, BYBIT_API_SECRET/,
    );
    expect(() => loadExchangeCredentials({ env: {} })).toThrow(/WITHDRAWAL DISABLED/);
  });

  it('treats a blank variable as missing', () => {
    expect(() =>
      loadExchangeCredentials({ env: { ...KEYS, BYBIT_API_KEY: '   ' } }),
    ).toThrow(/BYBIT_API_KEY/);
  });

  describe('going live takes two independent signals', () => {
    it('refuses the env flag alone', () => {
      expect(() => loadExchangeCredentials({ env: { ...KEYS, BYBIT_LIVE: 'true' } })).toThrow(
        /was not started with --live/,
      );
    });

    it('refuses the CLI flag alone', () => {
      expect(() => loadExchangeCredentials({ env: { ...KEYS }, allowLive: true })).toThrow(
        /BYBIT_LIVE is not "true"/,
      );
    });

    it('allows live only with both', () => {
      const credentials = loadExchangeCredentials({
        env: { ...KEYS, BYBIT_LIVE: 'true' },
        allowLive: true,
      });
      expect(credentials.sandbox).toBe(false);
    });

    it('is not fooled by a near-miss value', () => {
      const credentials = loadExchangeCredentials({ env: { ...KEYS, BYBIT_LIVE: 'yes' } });
      expect(credentials.sandbox).toBe(true);
    });
  });

  it('validates the product category', () => {
    expect(loadExchangeCredentials({ env: { ...KEYS, BYBIT_CATEGORY: 'linear' } }).category).toBe(
      'linear',
    );
    expect(() => loadExchangeCredentials({ env: { ...KEYS, BYBIT_CATEGORY: 'futures' } })).toThrow(
      /must be "spot" or "linear"/,
    );
  });
});

describe('describeCredentials', () => {
  it('never reveals the secret and truncates the key', () => {
    const line = describeCredentials(loadExchangeCredentials({ env: { ...KEYS } }));

    expect(line).toContain('TESTNET');
    expect(line).toContain('abcd');
    expect(line).not.toContain(KEYS.BYBIT_API_SECRET);
    expect(line).not.toContain('efgh'); // the rest of the key is masked too
  });

  it('shouts when the target is real money', () => {
    const line = describeCredentials(
      loadExchangeCredentials({ env: { ...KEYS, BYBIT_LIVE: 'true' }, allowLive: true }),
    );
    expect(line).toContain('LIVE — REAL FUNDS');
  });
});
