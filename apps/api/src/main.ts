import './load-env';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  app.enableCors({ origin: process.env.WEB_ORIGIN, credentials: true });
  configureApp(app);

  await app.listen(process.env.PORT ?? 4000);
}

void bootstrap();
