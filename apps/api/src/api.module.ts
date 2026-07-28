import { Module } from '@nestjs/common';

import { ApplicationModule } from '@bot/app/application.module';
import { BacktestsController } from './backtests.controller';
import { HealthController } from './health.controller';
import { ReportsController } from './reports.controller';
import { StrategiesController } from './strategies.controller';

/** HTTP surface, mounted under the `/api` global prefix. */
@Module({
  imports: [ApplicationModule],
  controllers: [HealthController, StrategiesController, BacktestsController, ReportsController],
})
export class ApiModule {}
