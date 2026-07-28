import { Test } from '@nestjs/testing';

import { APP_NAME, APP_VERSION } from '@bot/core/version';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the running application', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const controller = moduleRef.get(HealthController);

    expect(controller.check()).toEqual({
      status: 'ok',
      name: APP_NAME,
      version: APP_VERSION,
    });
  });
});
