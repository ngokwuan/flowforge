import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Env } from '../pipes/env-validation.pipe';
import { ThrottlerRedisStore } from './throttler-redis.store';

/** Module nhỏ chỉ để cung cấp + export store, ThrottlerModule và AuthModule cùng import. */
@Module({
  imports: [ConfigModule], // chỉ cần nếu ThrottlerRedisStore inject ConfigService
  providers: [ThrottlerRedisStore],
  exports: [ThrottlerRedisStore],
})
export class ThrottlerStoreModule {}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, ThrottlerStoreModule],
      inject: [ConfigService, ThrottlerRedisStore],
      useFactory: (
        _config: ConfigService<Env, true>,
        store: ThrottlerRedisStore,
      ) => ({
        throttlers: [{ name: 'auth', ttl: 60_000, limit: 10 }],
        storage: store,
      }),
    }),
    ThrottlerStoreModule,
  ],
  exports: [ThrottlerModule, ThrottlerStoreModule],
})
export class ThrottlerConfigModule {}
