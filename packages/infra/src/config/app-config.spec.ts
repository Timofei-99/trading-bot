import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppConfigError, DEFAULT_CONFIG, loadAppConfig } from './app-config';

describe('loadAppConfig', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-config-'));
    path = join(dir, 'default.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (body: string) => writeFileSync(path, body, 'utf8');
  const load = (env: NodeJS.ProcessEnv = {}) => loadAppConfig({ path, env });

  it('falls back to the defaults when there is no file', () => {
    expect(loadAppConfig({ path: join(dir, 'absent.yaml'), env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it('falls back to the defaults for an empty file', () => {
    write('\n');

    expect(load()).toEqual(DEFAULT_CONFIG);
  });

  it('takes the values a file supplies', () => {
    write('symbol: ETH/USDT\nexchange: bybit\n');

    const config = load();

    expect(config.symbol).toBe('ETH/USDT');
    expect(config.exchange).toBe('bybit');
  });

  it('merges a section rather than replacing it wholesale', () => {
    // Setting one key of `risk` must not wipe the other; otherwise every file
    // has to restate defaults it does not care about.
    write('risk:\n  perTrade: 0.02\n');

    expect(load().risk).toEqual({ perTrade: 0.02, maxDailyDrawdown: 0.03 });
  });

  describe('environment overrides', () => {
    it('beat the file', () => {
      write('api:\n  port: 4000\n');

      expect(load({ PORT: '8080' }).api.port).toBe(8080);
    });

    it('keep the type the defaults established', () => {
      // PORT arrives as a string; the field must stay a number, or a downstream
      // `listen()` gets a string and the failure surfaces far from here.
      const config = load({ PORT: '8080' });

      expect(typeof config.api.port).toBe('number');
    });

    it('are ignored when blank', () => {
      write('api:\n  port: 4000\n');

      expect(load({ PORT: '   ' }).api.port).toBe(4000);
    });

    it('cover host, cache dir, symbol and exchange too', () => {
      const config = load({
        HOST: '0.0.0.0',
        DATA_CACHE_DIR: '/tmp/cache',
        SYMBOL: 'SOL/USDT',
        EXCHANGE: 'okx',
      });

      expect(config.api.host).toBe('0.0.0.0');
      expect(config.data.cacheDir).toBe('/tmp/cache');
      expect(config.symbol).toBe('SOL/USDT');
      expect(config.exchange).toBe('okx');
    });
  });

  describe('validation', () => {
    it('rejects YAML that will not parse, naming the file', () => {
      write('risk: [unclosed');

      expect(() => load()).toThrow(AppConfigError);
      expect(() => load()).toThrow(new RegExp(path.replace(/[/\\]/g, '.')));
    });

    it('rejects a document that is not a mapping', () => {
      write('- a\n- b\n');

      expect(() => load()).toThrow(/mapping/);
    });

    it.each([
      ['symbol: ""\n', /symbol/],
      ['timeframes: []\n', /timeframes/],
      ['risk:\n  perTrade: 0\n', /risk\.perTrade/],
      ['risk:\n  perTrade: 1\n', /risk\.perTrade/],
      ['risk:\n  maxDailyDrawdown: "high"\n', /risk\.maxDailyDrawdown/],
      ['data:\n  maxCandles: 0\n', /data\.maxCandles/],
      ['data:\n  maxCandles: 1.5\n', /data\.maxCandles/],
      ['data:\n  cacheDir: ""\n', /data\.cacheDir/],
      ['api:\n  port: 0\n', /api\.port/],
      ['api:\n  port: 70000\n', /api\.port/],
      ['risk: 5\n', /risk/],
    ])('rejects %j', (body, expected) => {
      write(body);

      expect(() => load()).toThrow(expected);
    });

    it('rejects a port that arrives from the environment out of range', () => {
      // The env path bypasses the YAML, so it needs its own check.
      expect(() => load({ PORT: '99999' })).toThrow(/api\.port/);
    });

    it('rejects a non-numeric port from the environment', () => {
      expect(() => load({ PORT: 'abc' })).toThrow(/api\.port/);
    });
  });

  it('reads the repository config without complaint', () => {
    // The file that actually ships must satisfy its own validator.
    expect(() =>
      loadAppConfig({
        path: join(__dirname, '..', '..', '..', '..', 'config', 'default.yaml'),
        env: {},
      }),
    ).not.toThrow();
  });
});
