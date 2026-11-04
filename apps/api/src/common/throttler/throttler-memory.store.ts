import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/**
 * In-memory ThrottlerStorage dùng trong E2E tests để tránh cần Redis
 * và để mỗi test suite bắt đầu với counter sạch.
 */
@Injectable()
export class ThrottlerMemoryStore implements ThrottlerStorage {
  private readonly store = new Map<
    string,
    { hits: number; expiresAt: number }
  >();

  async increment(
    key: string,
    ttl: number,
    _limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || entry.expiresAt <= now) {
      this.store.set(key, { hits: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    entry.hits += 1;
    const timeToExpire = Math.ceil((entry.expiresAt - now) / 1000);
    return {
      totalHits: entry.hits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
