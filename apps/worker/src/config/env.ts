import { existsSync } from 'node:fs';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Not PORT: the API's .env may already define it.
  WORKER_PORT: z.coerce.number().int().positive().default(4001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // How many executions this process runs at the same time.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  // A QUEUED execution older than this has probably lost its job.
  STALE_AFTER_MS: z.coerce.number().int().min(1000).default(30_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  // On shutdown, running executions get this long to finish before they are cancelled.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(25_000),
});

export type WorkerEnv = z.infer<typeof envSchema>;

// Injection token for the validated environment.
export const ENV = Symbol('WORKER_ENV');

export function loadEnv(): WorkerEnv {
  // Local development reads the repository's .env. loadEnvFile never overrides a
  // variable that is already set, so real environments are unaffected.
  for (const path of ['.env', '../../.env']) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      break;
    }
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
