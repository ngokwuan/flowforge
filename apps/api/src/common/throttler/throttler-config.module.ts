import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Env } from '../pipes/env-validation.pipe';
import { ThrottlerRedisStore } from './throttler-redis.store';

/**
 * Cung cấp ThrottlerModule với Redis store và export ThrottlerRedisStore để
 * AuthModule có thể inject vào ThrottlerModule.
 *
 * Cấu hình mặc định: 10 request/60 giây — đủ cho luồng bình thường nhưng
 * ngăn brute-force.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, ThrottlerRedisStore],
      useFactory: (_config: ConfigService<Env, true>, store: ThrottlerRedisStore) => ({
        throttlers: [{ name: 'auth', ttl: 60_000, limit: 10 }],
        storage: store,
      }),
    }),
  ],
  providers: [ThrottlerRedisStore],
  exports: [ThrottlerModule, ThrottlerRedisStore],
})
export class ThrottlerConfigModule {}
