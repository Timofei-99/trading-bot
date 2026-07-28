import 'reflect-metadata';

import { loadAppConfig } from '@bot/app/config.service';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Read and validate the configuration BEFORE building the container, so a
  // bad port fails immediately with a named error instead of after the app has
  // already wired itself up.
  //
  // Loopback by default. This API has no authentication (one operator, one
  // machine) and the process holds exchange credentials once live trading is
  // configured — binding every interface would put both on the LAN. Set HOST,
  // or `api.host` in config/default.yaml, to override.
  const { api } = loadAppConfig();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(api.port, api.host);
  console.log(`trading-bot API listening on http://${api.host}:${api.port}/api`);
}

void bootstrap();
