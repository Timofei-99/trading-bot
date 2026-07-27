import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.PORT ?? 3000);
  // Loopback by default. This API has no authentication (one operator, one
  // machine) and the process holds exchange credentials once live trading is
  // configured — binding every interface would put both on the LAN. Set
  // HOST explicitly to override.
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`trading-bot API listening on http://${host}:${port}/api`);
}

void bootstrap();
