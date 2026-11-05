/**
 * Tạo một NestJS test application với ThrottlerStorage được thay thế bằng
 * in-memory store. Dùng trong tất cả E2E test suites để:
 *   1. Không cần Redis để bootstrap throttler trong test.
 *   2. Mỗi suite bắt đầu với rate-limit counter sạch.
 *   3. Không bị 429 do các test khác làm đầy counter.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { ThrottlerMemoryStore } from '../src/common/throttler/throttler-memory.store';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ThrottlerStorage)
    .useClass(ThrottlerMemoryStore)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
