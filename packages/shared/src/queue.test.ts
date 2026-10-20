import { describe, expect, it } from 'vitest';
import { queuePrefix, redisConnectionFromUrl } from './queue';

describe('redisConnectionFromUrl', () => {
  it('uses the default port and no credentials for a plain URL', () => {
    expect(redisConnectionFromUrl('redis://localhost')).toMatchObject({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      db: undefined,
    });
  });

  it('reads port, credentials and database number', () => {
    expect(
      redisConnectionFromUrl('redis://app:p%40ss@cache.internal:6380/2'),
    ).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      username: 'app',
      password: 'p@ss',
      db: 2,
    });
  });

  it('enables TLS for rediss URLs', () => {
    expect(
      redisConnectionFromUrl('rediss://cache.internal:6380'),
    ).toHaveProperty('tls');
    expect(redisConnectionFromUrl('redis://cache.internal')).not.toHaveProperty(
      'tls',
    );
  });
});

describe('queuePrefix', () => {
  it('separates environments', () => {
    expect(queuePrefix('test')).not.toBe(queuePrefix('development'));
  });
});
