import { Controller, Get } from '@nestjs/common';

import { APP_NAME, APP_VERSION } from '../version';

export interface HealthResponse {
  status: 'ok';
  name: string;
  version: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', name: APP_NAME, version: APP_VERSION };
  }
}
