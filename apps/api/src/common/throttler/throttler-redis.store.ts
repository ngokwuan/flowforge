import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import type { Env } from '../pipes/env-validation.pipe';

const KEY_PREFIX = 'throttler:';

/**
 * Redis-backed storage for @nestjs/throttler.
 *
 * Each hit increments a counter stored in Redis; the first hit sets a TTL equal
 * to the window so the key expires automatically when the window rolls over.
 */
@Injectable()
export class ThrottlerRedisStore implements ThrottlerStorage, OnModuleDestroy {
  private readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  async increment(
    key: string,
    ttl: number,
    _limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `${KEY_PREFIX}${key}`;

    // MULTI keeps the increment + conditional EXPIRE atomic.
    const pipeline = this.client.multi();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);
    const [[, totalHits], [, remainingTtlMs]] = (await pipeline.exec()) as [
      [null, number],
      [null, number],
    ];

    // Only set TTL on first increment (key is new or has no TTL).
    if (remainingTtlMs < 0) {
      await this.client.pexpire(redisKey, ttl);
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(
        (remainingTtlMs > 0 ? remainingTtlMs : ttl) / 1000,
      ),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
