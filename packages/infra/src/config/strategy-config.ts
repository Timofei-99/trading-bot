import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { load } from 'js-yaml';

/**
 * A strategy declared in YAML rather than in TypeScript.
 *
 * This is the counterpart of the Python stack's `strategies/configs/*.yaml`.
 * It does NOT define new behaviour: `implementation` names a strategy class
 * the registry already knows how to build, and the file supplies the id,
 * version, timeframes and parameters it should be registered under. Two
 * parameterisations of the same class are therefore two strategies, without a
 * line of TypeScript.
 */
export interface StrategyConfig {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  /** Id of the built-in implementation this configuration parameterises. */
  readonly implementation: string;
  readonly timeframes: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
  /** Absolute path of the file, so an error can point at it. */
  readonly source: string;
}

export class StrategyConfigError extends Error {
  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = 'StrategyConfigError';
  }
}

const YAML_EXTENSIONS = ['.yaml', '.yml'];

/**
 * Read every strategy configuration in a directory.
 *
 * A missing directory yields nothing rather than throwing — a checkout with no
 * `config/strategies/` is valid, and the built-in strategies stand on their
 * own. Anything present but malformed is fatal: a strategy that silently fails
 * to register is worse than a startup that refuses to continue, because the
 * first symptom is a backtest that quietly does not run.
 */
export function loadStrategyConfigs(dir: string): StrategyConfig[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter((name) => YAML_EXTENSIONS.some((extension) => name.endsWith(extension)))
    // Sorted so registration order is stable across machines rather than
    // whatever order the filesystem happens to return.
    .sort();

  const configs = files.map((name) => parseFile(join(dir, name)));
  assertUniqueIds(configs);
  return configs;
}

/**
 * Layer parameters: built-in defaults, then the YAML file, then whatever the
 * caller passed explicitly (`--params`). Later layers win key by key, so a
 * file may override one default without restating the rest.
 */
export function mergeParams(
  defaults: Readonly<Record<string, unknown>>,
  fromYaml: Readonly<Record<string, unknown>> | undefined,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return { ...defaults, ...(fromYaml ?? {}), ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------

function parseFile(path: string): StrategyConfig {
  const file = basename(path);

  let document: unknown;
  try {
    document = load(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StrategyConfigError(file, `not valid YAML — ${(error as Error).message}`);
  }

  if (document === null || document === undefined) {
    throw new StrategyConfigError(file, 'is empty');
  }
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw new StrategyConfigError(file, 'must be a mapping at the top level');
  }

  const raw = document as Record<string, unknown>;

  return {
    id: requireString(raw, 'id', file),
    version: requireString(raw, 'version', file),
    description: optionalString(raw, 'description', file) ?? '',
    implementation: requireString(raw, 'implementation', file),
    timeframes: requireTimeframes(raw, file),
    params: requireParams(raw, file),
    source: path,
  };
}

function requireString(raw: Record<string, unknown>, key: string, file: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StrategyConfigError(file, `${key} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  file: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new StrategyConfigError(file, `${key} must be a string`);
  }
  return value;
}

function requireTimeframes(raw: Record<string, unknown>, file: string): string[] {
  const value = raw.timeframes;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new StrategyConfigError(
      file,
      'timeframes is required and must be a non-empty list of strings',
    );
  }
  return value as string[];
}

function requireParams(raw: Record<string, unknown>, file: string): Record<string, unknown> {
  const value = raw.params;
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StrategyConfigError(file, 'params must be a mapping');
  }
  return value as Record<string, unknown>;
}

function assertUniqueIds(configs: readonly StrategyConfig[]): void {
  const seen = new Map<string, string>();
  for (const config of configs) {
    const previous = seen.get(config.id);
    if (previous !== undefined) {
      throw new StrategyConfigError(
        basename(config.source),
        `duplicate strategy id ${JSON.stringify(config.id)}, already declared in ${basename(previous)}`,
      );
    }
    seen.set(config.id, config.source);
  }
}
