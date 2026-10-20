import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// Reads the optional Idempotency-Key header. Pass a pipe to validate it:
// @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema))
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'] as
      string | undefined,
);
