import { Controller, Get } from '@nestjs/common';

import { StrategyRegistryService } from '../application/strategy-registry.service';

interface StrategySummary {
  id: string;
  version: string;
  description: string;
  requiredTimeframes: string[];
  defaultParams: Record<string, unknown>;
}

@Controller('strategies')
export class StrategiesController {
  constructor(private readonly registry: StrategyRegistryService) {}

  @Get()
  list(): StrategySummary[] {
    return this.registry.list().map((descriptor) => ({
      id: descriptor.id,
      version: descriptor.version,
      description: descriptor.description,
      requiredTimeframes: [...descriptor.requiredTimeframes],
      defaultParams: { ...descriptor.defaultParams },
    }));
  }
}
