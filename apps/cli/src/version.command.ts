import { Command, CommandRunner } from 'nest-commander';

import { APP_NAME, APP_VERSION } from '@bot/core/version';

@Command({ name: 'version', description: 'Print the trading-bot version' })
export class VersionCommand extends CommandRunner {
  async run(): Promise<void> {
    console.log(`${APP_NAME} ${APP_VERSION}`);
  }
}
