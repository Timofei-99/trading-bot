import {
  StrategyConfig,
  StrategyConfigError,
  mergeParams,
} from '@bot/infra/config/strategy-config';

import { StrategyDescriptor } from './strategy-registry.service';

/**
 * Turn YAML strategy configurations into registry descriptors.
 *
 * Each config names a built-in `implementation` and supplies the parameters it
 * should be registered under, so two parameterisations of the same class
 * become two addressable strategies without any TypeScript. The built-in's
 * `defaultParams` still apply underneath, so a file only has to state what it
 * changes.
 *
 * A config naming an unknown implementation is fatal rather than skipped: the
 * alternative is a strategy that silently never appears, whose first symptom
 * is a backtest that does not run.
 */
export function descriptorsFromConfigs(
  configs: readonly StrategyConfig[],
  builtIns: readonly StrategyDescriptor[],
): StrategyDescriptor[] {
  const byImplementation = new Map(builtIns.map((descriptor) => [descriptor.id, descriptor]));

  return configs.map((config) => {
    const base = byImplementation.get(config.implementation);
    if (base === undefined) {
      throw new StrategyConfigError(
        config.source,
        `unknown implementation ${JSON.stringify(config.implementation)}. ` +
          `Known: ${[...byImplementation.keys()].join(', ')}`,
      );
    }

    return {
      id: config.id,
      version: config.version,
      description: config.description === '' ? base.description : config.description,
      requiredTimeframes: config.timeframes,
      defaultParams: mergeParams(base.defaultParams, config.params, undefined),
      create: (params) => base.create(mergeParams(base.defaultParams, config.params, params)),
    };
  });
}

/**
 * Built-ins plus YAML, with YAML winning on a collision.
 *
 * Overriding a built-in by id is the point — it is how an operator retunes a
 * bundled strategy without touching the source — but it is worth being able to
 * see that it happened, hence `overridden`.
 */
export function combineStrategies(
  builtIns: readonly StrategyDescriptor[],
  fromYaml: readonly StrategyDescriptor[],
): { descriptors: StrategyDescriptor[]; overridden: string[] } {
  const byId = new Map(builtIns.map((descriptor) => [descriptor.id, descriptor]));
  const overridden: string[] = [];

  for (const descriptor of fromYaml) {
    if (byId.has(descriptor.id)) {
      overridden.push(descriptor.id);
    }
    byId.set(descriptor.id, descriptor);
  }

  return { descriptors: [...byId.values()], overridden };
}
