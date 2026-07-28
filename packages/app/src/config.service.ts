import { AppConfig, loadAppConfig } from '@bot/infra/config/app-config';
import { Injectable } from '@nestjs/common';

/**
 * The application's view of its configuration.
 *
 * This exists because `@bot/api` and `@bot/cli` may not import `@bot/infra`
 * directly — reading a YAML file is infrastructure, and letting the entry
 * points reach past `@bot/app` for it would also let them reach an exchange
 * client. So the loader lives in infra, and this is the single seam the
 * surfaces go through.
 *
 * Loaded once at construction: the config is read at startup and a change on
 * disk should require a restart, not take effect halfway through a run.
 */
@Injectable()
export class AppConfigService {
  readonly config: AppConfig;

  constructor(config?: AppConfig) {
    this.config = config ?? loadAppConfig();
  }

  get api(): AppConfig['api'] {
    return this.config.api;
  }

  get risk(): AppConfig['risk'] {
    return this.config.risk;
  }

  get data(): AppConfig['data'] {
    return this.config.data;
  }
}

/**
 * For bootstrap, before the container exists.
 *
 * `main.ts` needs the port and host to call `listen`, which happens outside
 * DI. Re-exported here rather than imported from infra so the dependency
 * direction stays api -> app -> infra.
 */
export { loadAppConfig };
export type { AppConfig };
