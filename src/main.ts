import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Express } from 'express';
import { AppModule } from './app.module.js';

let cachedExpressApp: Express | null = null;

function configureHttpApp(app: INestApplication): void {
  const expressInstance = app.getHttpAdapter().getInstance() as Express;
  expressInstance.disable('x-powered-by');

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ||
    'https://ai.santiago-jv.tech,https://www.santiago-jv.tech,http://localhost:4321,http://localhost:3000'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Santiago-Timestamp',
      'X-Santiago-Signature',
      'X-Santiago-Sig-Version',
      'X-Client-IP',
    ],
  });
}

export async function getServerlessExpressApp(): Promise<Express> {
  if (cachedExpressApp) {
    return cachedExpressApp;
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });

  configureHttpApp(app);

  await app.init();
  cachedExpressApp = app.getHttpAdapter().getInstance() as Express;
  return cachedExpressApp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT || '4000', 10) || 4000;
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureHttpApp(app);
  await app.listen(port);
  console.log(`[api-santiago-jv] NestJS + @nestjs/ai listening on http://localhost:${port}`);
}
