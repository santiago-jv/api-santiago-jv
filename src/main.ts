import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Express } from 'express';
import { AppModule } from './app.module.js';

let cachedExpressApp: Express | null = null;

export async function getServerlessExpressApp(): Promise<Express> {
  if (cachedExpressApp) {
    return cachedExpressApp;
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ||
    'https://ai.santiago-jv.tech,https://www.santiago-jv.tech,http://localhost:4321,http://localhost:3000'
  )
    .split(',')
    .map((o) => o.trim());

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Santiago-Timestamp',
      'X-Santiago-Signature',
      'X-Client-IP',
    ],
  });

  await app.init();
  cachedExpressApp = app.getHttpAdapter().getInstance() as Express;
  return cachedExpressApp;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT || '4000', 10) || 4000;
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(port);
  console.log(`[api-santiago-jv] NestJS + @nestjs/ai listening on http://localhost:${port}`);
}
