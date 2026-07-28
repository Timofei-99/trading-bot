import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BUILT_IN_STRATEGIES } from '@bot/app/strategy-registry.service';
import { descriptorsFromConfigs } from '@bot/app/yaml-strategies';
import { loadStrategyConfigs } from '@bot/infra/config/strategy-config';

const REPO = join(__dirname, '..', '..');
const EXAMPLES = join(REPO, 'docs', 'examples', 'strategies');

/**
 * The shipped YAML examples, actually loaded.
 *
 * Documentation that has never been run is a guess. These files are the only
 * thing a reader has to copy from, so they go through the real loader and the
 * real registry mapping — including building the strategy each one describes.
 */
describe('example strategy configs', () => {
  const configs = loadStrategyConfigs(EXAMPLES);

  it('ships at least one example', () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  it('loads every YAML file in the directory', () => {
    const files = readdirSync(EXAMPLES).filter((name) => name.endsWith('.yaml'));

    expect(configs).toHaveLength(files.length);
  });

  it.each(loadStrategyConfigs(EXAMPLES))('$id builds a working strategy', (config) => {
    const [descriptor] = descriptorsFromConfigs([config], BUILT_IN_STRATEGIES);
    const strategy = descriptor.create(descriptor.defaultParams);

    expect(strategy.name).toBeTruthy();
    expect(descriptor.requiredTimeframes.length).toBeGreaterThan(0);
  });

  it('keeps config/strategies free of shipped duplicates', () => {
    // The directory is the operator's. Shipping YAML copies of the built-ins
    // there would double the output of `strategies` for every user.
    const shipped = join(REPO, 'config', 'strategies');

    expect(existsSync(shipped)).toBe(true);
    expect(loadStrategyConfigs(shipped)).toEqual([]);
  });
});
