import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * Application defaults — the counterpart of the Python stack's `config.yaml`.
 *
 * Deliberately does NOT hold credentials. Those come from the environment
 * only, through `loadExchangeCredentials`, so that a config file can be
 * committed without anyone having to think about it first.
 */
export interface AppConfig {
  readonly exchange: string;
  readonly symbol: string;
  readonly timeframes: readonly string[];
  readonly risk: { readonly perTrade: number; readonly maxDailyDrawdown: number };
  readonly data: { readonly maxCandles: number; readonly cacheDir: string };
  readonly api: { readonly host: string; readonly port: number };
}

export class AppConfigError extends Error {
  constructor(problem: string) {
    super(`config: ${problem}`);
    this.name = 'AppConfigError';
  }
}

export const DEFAULT_CONFIG: AppConfig = {
  exchange: 'binance',
  symbol: 'BTC/USDT',
  timeframes: ['1m', '15m', '1h', '4h', '1d'],
  risk: { perTrade: 0.01, maxDailyDrawdown: 0.03 },
  data: { maxCandles: 500, cacheDir: 'data/cache' },
  api: { host: '127.0.0.1', port: 3000 },
};

/** Environment variable -> path in the config, for the keys worth overriding. */
const ENV_OVERRIDES = {
  HOST: 'api.host',
  PORT: 'api.port',
  DATA_CACHE_DIR: 'data.cacheDir',
  SYMBOL: 'symbol',
  EXCHANGE: 'exchange',
} as const;

export interface LoadAppConfigOptions {
  /** Path to the YAML file. A missing file falls back to the defaults. */
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Defaults, then the YAML file, then the environment.
 *
 * Every layer is optional and every result is validated, so a typo produces a
 * named error at startup rather than an `undefined` that surfaces three calls
 * deeper as a NaN position size.
 */
export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const path = options.path ?? join(process.cwd(), 'config', 'default.yaml');
  const env = options.env ?? process.env;

  const merged = applyEnv(mergeYaml(DEFAULT_CONFIG, readYaml(path)), env);
  return validate(merged);
}

// ---------------------------------------------------------------------------

function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  let document: unknown;
  try {
    document = load(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AppConfigError(`${path} is not valid YAML — ${(error as Error).message}`);
  }
  if (document === null || document === undefined) {
    return {};
  }
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw new AppConfigError(`${path} must be a mapping at the top level`);
  }
  return document as Record<string, unknown>;
}

/** One level of nesting is all the shape has, so a full deep merge is overkill. */
function mergeYaml(base: AppConfig, yaml: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(yaml)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = { ...current, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function applyEnv(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const result = structuredClone(config);
  for (const [variable, path] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    setPath(result, path.split('.'), raw.trim());
  }
  return result;
}

function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    // Keep the type the defaults established: an override for a numeric key
    // arrives as a string and must not silently turn the field into one.
    const existing = target[head];
    target[head] = typeof existing === 'number' ? Number(value) : value;
    return;
  }
  const next = target[head];
  if (isPlainObject(next)) {
    setPath(next, rest, value);
  }
}

function validate(raw: Record<string, unknown>): AppConfig {
  const exchange = requireNonEmptyString(raw, 'exchange');
  const symbol = requireNonEmptyString(raw, 'symbol');

  const timeframes = raw.timeframes;
  if (
    !Array.isArray(timeframes) ||
    timeframes.length === 0 ||
    timeframes.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new AppConfigError('timeframes must be a non-empty list of strings');
  }

  const risk = section(raw, 'risk');
  const data = section(raw, 'data');
  const api = section(raw, 'api');

  return {
    exchange,
    symbol,
    timeframes: timeframes as string[],
    risk: {
      perTrade: fraction(risk, 'risk.perTrade', risk.perTrade),
      maxDailyDrawdown: fraction(risk, 'risk.maxDailyDrawdown', risk.maxDailyDrawdown),
    },
    data: {
      maxCandles: positiveInteger(data.maxCandles, 'data.maxCandles'),
      cacheDir: requireNonEmptyString(data, 'cacheDir', 'data.cacheDir'),
    },
    api: {
      host: requireNonEmptyString(api, 'host', 'api.host'),
      port: port(api.port),
    },
  };
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (!isPlainObject(value)) {
    throw new AppConfigError(`${key} must be a mapping`);
  }
  return value;
}

function requireNonEmptyString(raw: Record<string, unknown>, key: string, label = key): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function fraction(_section: Record<string, unknown>, label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new AppConfigError(`${label} must be a number in (0, 1), got ${JSON.stringify(value)}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppConfigError(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function port(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new AppConfigError(
      `api.port must be an integer in [1, 65535], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
