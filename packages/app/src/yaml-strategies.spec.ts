import { StrategyConfig } from '@bot/infra/config/strategy-config';

import { BUILT_IN_STRATEGIES, StrategyDescriptor } from './strategy-registry.service';
import { combineStrategies, descriptorsFromConfigs } from './yaml-strategies';

const config = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  id: 'aggressive_ob',
  version: '1.0',
  description: 'OB with a tighter RR floor',
  implementation: 'OB_4h_FVG_15m',
  timeframes: ['4h', '15m'],
  params: { minRr: 1.2 },
  source: '/config/strategies/aggressive_ob.yaml',
  ...over,
});

describe('descriptorsFromConfigs', () => {
  it('registers a YAML config under its own id', () => {
    const [descriptor] = descriptorsFromConfigs([config()], BUILT_IN_STRATEGIES);

    expect(descriptor.id).toBe('aggressive_ob');
    expect(descriptor.version).toBe('1.0');
    expect(descriptor.requiredTimeframes).toEqual(['4h', '15m']);
  });

  it('layers the YAML params over the implementation defaults', () => {
    // The file states only what it changes; everything else still comes from
    // the built-in, so a new parameter added to the class reaches YAML
    // strategies without every file being edited.
    const [descriptor] = descriptorsFromConfigs([config()], BUILT_IN_STRATEGIES);

    expect(descriptor.defaultParams).toMatchObject({
      htf: '4h',
      ltf: '15m',
      obLookback: 5,
      minRr: 1.2,
    });
  });

  it('builds a strategy that honours the YAML params', () => {
    const [descriptor] = descriptorsFromConfigs([config()], BUILT_IN_STRATEGIES);

    const strategy = descriptor.create(descriptor.defaultParams) as unknown as { minRr: number };

    expect(strategy.minRr).toBe(1.2);
  });

  it('lets an explicit override beat the YAML', () => {
    const [descriptor] = descriptorsFromConfigs([config()], BUILT_IN_STRATEGIES);

    const strategy = descriptor.create({ minRr: 3 }) as unknown as { minRr: number };

    expect(strategy.minRr).toBe(3);
  });

  it('falls back to the implementation description when the file omits one', () => {
    const [descriptor] = descriptorsFromConfigs([config({ description: '' })], BUILT_IN_STRATEGIES);

    const base = BUILT_IN_STRATEGIES.find((d) => d.id === 'OB_4h_FVG_15m') as StrategyDescriptor;
    expect(descriptor.description).toBe(base.description);
  });

  it('refuses a config naming an implementation that does not exist', () => {
    // Skipping it would leave a strategy that never registers, whose first
    // symptom is a backtest that quietly does not run.
    expect(() =>
      descriptorsFromConfigs([config({ implementation: 'nope' })], BUILT_IN_STRATEGIES),
    ).toThrow(/unknown implementation "nope"/);
  });

  it('names the source file when it refuses', () => {
    expect(() =>
      descriptorsFromConfigs([config({ implementation: 'nope' })], BUILT_IN_STRATEGIES),
    ).toThrow(/aggressive_ob\.yaml/);
  });
});

describe('combineStrategies', () => {
  it('keeps the built-ins when there is no YAML', () => {
    const { descriptors, overridden } = combineStrategies(BUILT_IN_STRATEGIES, []);

    expect(descriptors).toHaveLength(BUILT_IN_STRATEGIES.length);
    expect(overridden).toEqual([]);
  });

  it('adds a YAML strategy alongside the built-ins', () => {
    const fromYaml = descriptorsFromConfigs([config()], BUILT_IN_STRATEGIES);

    const { descriptors, overridden } = combineStrategies(BUILT_IN_STRATEGIES, fromYaml);

    expect(descriptors.map((d) => d.id)).toContain('aggressive_ob');
    expect(descriptors).toHaveLength(BUILT_IN_STRATEGIES.length + 1);
    expect(overridden).toEqual([]);
  });

  it('lets YAML override a built-in by id, and says so', () => {
    // Retuning a bundled strategy without touching the source is the point;
    // doing it invisibly is not.
    const fromYaml = descriptorsFromConfigs([config({ id: 'OB_4h_FVG_15m' })], BUILT_IN_STRATEGIES);

    const { descriptors, overridden } = combineStrategies(BUILT_IN_STRATEGIES, fromYaml);

    expect(overridden).toEqual(['OB_4h_FVG_15m']);
    expect(descriptors).toHaveLength(BUILT_IN_STRATEGIES.length);
    expect(descriptors.find((d) => d.id === 'OB_4h_FVG_15m')?.defaultParams).toMatchObject({
      minRr: 1.2,
    });
  });
});
