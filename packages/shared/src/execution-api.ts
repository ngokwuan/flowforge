import { z } from 'zod';

// Body may be empty. `input` is handed to the trigger node when the run starts.
export const createExecutionSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .default({});
export type CreateExecutionInput = z.infer<typeof createExecutionSchema>;

// Optional `Idempotency-Key` header: repeating a request with the same key
// returns the same execution instead of creating another run.
export const idempotencyKeySchema = z.string().min(1).max(200).optional();
