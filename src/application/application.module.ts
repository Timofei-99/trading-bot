import { Module } from '@nestjs/common';

import { BacktestRunnerService } from './backtest-runner.service';
import { CandleSourceService } from './candle-source.service';
import { ReportService } from './report.service';
import { RunRegistryService } from './run-registry.service';
import {
  BUILT_IN_STRATEGIES,
  STRATEGY_DESCRIPTORS,
  StrategyRegistryService,
} from './strategy-registry.service';

/**
 * Orchestration shared by both entry points.
 *
 * This is where Nest's DI starts. Everything it wires up — detectors,
 * strategies, the engine, the execution adapter — is plain TypeScript that
 * knows nothing about the container.
 */
@Module({
  providers: [
    { provide: STRATEGY_DESCRIPTORS, useValue: BUILT_IN_STRATEGIES },
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
