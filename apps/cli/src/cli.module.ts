import { Module } from '@nestjs/common';

import { ApplicationModule } from '@bot/app/application.module';
import { BacktestCommand } from './backtest.command';
import { BacktestFrankfurtCommand } from './backtest-frankfurt.command';
import { BacktestH1m3mCommand } from './backtest-h1-3m.command';
import { BacktestOb4hCommand } from './backtest-ob4h.command';
import { HaltCommand, ResumeCommand } from './halt.command';
import { PaperCommand } from './paper.command';
import { StrategiesCommand } from './strategies.command';
import { TradeCommand } from './trade.command';
import { VersionCommand } from './version.command';
import { VisualizeCommand } from './visualize.command';

/** CLI surface — the replacement for the Python `run_*.py` scripts. */
@Module({
  imports: [ApplicationModule],
  providers: [
    VersionCommand,
    StrategiesCommand,
    BacktestCommand,
    BacktestOb4hCommand,
    BacktestFrankfurtCommand,
    BacktestH1m3mCommand,
    PaperCommand,
    TradeCommand,
    HaltCommand,
    ResumeCommand,
    VisualizeCommand,
  ],
})
export class CliModule {}
