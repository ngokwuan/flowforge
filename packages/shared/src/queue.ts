export const EXECUTIONS_QUEUE_NAME = 'executions';

// Jobs carry ids only. The worker loads the execution from the database, so the
// queue never holds a stale copy of the workflow or any secret.
export interface ExecutionJobData {
  executionId: string;
  workspaceId: string;
}

// Each environment gets its own key prefix in Redis, so tests can never feed a
// development worker (or the other way around).
export const queuePrefix = (nodeEnv: string) => `flowforge-${nodeEnv}`;

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

// Turns "redis://user:pass@host:6379/2" into BullMQ connection options.
export function redisConnectionFromUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  const db =
    parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    ...(parsed.protocol === 'rediss:' && { tls: {} }),
  };
}
