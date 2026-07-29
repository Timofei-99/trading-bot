import { loadStrategyConfigs } from '@bot/infra/config/strategy-config';
import { Module } from '@nestjs/common';
import { join } from 'node:path';

import { BacktestRunnerService } from './backtest-runner.service';
import { CandleSourceService } from './candle-source.service';
import { AppConfigService } from './config.service';
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
    // Built by factory, not by class: the constructor takes an optional
    // AppConfig for tests, and an interface is not something the container can
    // resolve.
    { provide: AppConfigService, useFactory: () => new AppConfigService() },
    { provide: STRATEGY_DESCRIPTORS, useFactory: () => resolveStrategyDescriptors() },
    // Both services take constructor options that used to be hardcoded by a
    // `useFactory: () => new X()`, which is a provider that cannot be
    // configured — the container was carrying them without deciding anything.
    // Now the cache directory comes from config/default.yaml (or
    // DATA_CACHE_DIR) like everything else.
    {
      provide: CandleSourceService,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new CandleSourceService({ cacheDir: config.data.cacheDir }),
    },
    {
      provide: ReportService,
      useFactory: () => new ReportService(),
    },
    StrategyRegistryService,
    BacktestRunnerService,
    RunRegistryService,
  ],
  exports: [
    AppConfigService,
    StrategyRegistryService,
    BacktestRunnerService,
    RunRegistryService,
    CandleSourceService,
    ReportService,
  ],
})
export class ApplicationModule {}
