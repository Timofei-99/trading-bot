import 'reflect-metadata';

import { CommandFactory } from 'nest-commander';

import { CliModule } from './cli.module';

async function bootstrap(): Promise<void> {
  await CommandFactory.run(CliModule, ['warn', 'error']);
}

void bootstrap();
