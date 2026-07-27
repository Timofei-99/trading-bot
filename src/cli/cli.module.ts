import { Module } from '@nestjs/common';

import { ApplicationModule } from '../application/application.module';
import { BacktestFrankfurtCommand } from './backtest-frankfurt.command';
import { BacktestH1m3mCommand } from './backtest-h1-3m.command';
import { BacktestOb4hCommand } from './backtest-ob4h.command';
import { PaperCommand } from './paper.command';
import { StrategiesCommand } from './strategies.command';
import { VersionCommand } from './version.command';
import { VisualizeCommand } from './visualize.command';

/** CLI surface — the replacement for the Python `run_*.py` scripts. */
@Module({
  imports: [ApplicationModule],
  providers: [
    VersionCommand,
    StrategiesCommand,
    BacktestOb4hCommand,
    BacktestFrankfurtCommand,
    BacktestH1m3mCommand,
    PaperCommand,
    VisualizeCommand,
  ],
})
export class CliModule {}
