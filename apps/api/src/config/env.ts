import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    OBSERVE_APP_KEY: z.string().min(1).optional(),
    OBSERVE_APP_SECRET: z.string().min(1).optional(),
  })
  .refine(
    (env) => Boolean(env.OBSERVE_APP_KEY) === Boolean(env.OBSERVE_APP_SECRET),
    {
      message: 'OBSERVE_APP_KEY and OBSERVE_APP_SECRET must be set together',
      path: ['OBSERVE_APP_KEY'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
