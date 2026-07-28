import { loadStrategyConfigs } from '@bot/infra/config/strategy-config';
import { Module } from '@nestjs/common';
import { join } from 'node:path';

import { BacktestRunnerService } from './backtest-runner.service';
import { CandleSourceService } from './candle-source.service';
import { ReportService } from './report.service';
import { RunRegistryService } from './run-registry.service';
import {
  BUILT_IN_STRATEGIES,
  STRATEGY_DESCRIPTORS,
  StrategyRegistryService,
} from './strategy-registry.service';
import { combineStrategies, descriptorsFromConfigs } from './yaml-strategies';

/**
 * Orchestration shared by both entry points.
 *
 * This is where Nest's DI starts. Everything it wires up — detectors,
 * strategies, the engine, the execution adapter — is plain TypeScript that
 * knows nothing about the container.
 */
export function resolveStrategyDescriptors(dir = join(process.cwd(), 'config', 'strategies')) {
  const configs = loadStrategyConfigs(dir);
  const { descriptors, overridden } = combineStrategies(
    BUILT_IN_STRATEGIES,
    descriptorsFromConfigs(configs, BUILT_IN_STRATEGIES),
  );
  if (overridden.length > 0) {
    console.warn(`config/strategies overrides built-in: ${overridden.join(', ')}`);
  }
  return descriptors;
}

@Module({
  providers: [
    { provide: STRATEGY_DESCRIPTORS, useFactory: () => resolveStrategyDescriptors() },
    { provide: CandleSourceService, useFactory: () => new CandleSourceService() },
    { provide: ReportService, useFactory: () => new ReportService() },
    StrategyRegistryService,
    BacktestRunnerService,
    RunRegistryService,
  ],
  exports: [
    StrategyRegistryService,
    BacktestRunnerService,
    RunRegistryService,
    CandleSourceService,
    ReportService,
  ],
})
export class ApplicationModule {}
