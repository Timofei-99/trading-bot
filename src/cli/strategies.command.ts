import { Command, CommandRunner } from 'nest-commander';

import { StrategyRegistryService } from '../application/strategy-registry.service';

@Command({ name: 'strategies', description: 'List the available strategies' })
export class StrategiesCommand extends CommandRunner {
  constructor(private readonly registry: StrategyRegistryService) {
    super();
  }

  async run(): Promise<void> {
    for (const descriptor of this.registry.list()) {
      console.log(`${descriptor.id} v${descriptor.version}`);
      console.log(`  ${descriptor.description}`);
      console.log(`  timeframes: ${descriptor.requiredTimeframes.join(', ')}`);
      console.log(`  params: ${JSON.stringify(descriptor.defaultParams)}`);
    }
  }
}
