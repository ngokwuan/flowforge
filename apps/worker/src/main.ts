import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ENV, type WorkerEnv } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // SIGTERM/SIGINT run the shutdown hooks: stop taking jobs, finish or cancel the
  // running ones, close Redis and the database.
  app.enableShutdownHooks();
  await app.listen(app.get<WorkerEnv>(ENV).WORKER_PORT);
}
await bootstrap();
