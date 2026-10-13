import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

// Validates a request part against a Zod schema and returns the parsed value.
// Failures become a 400 in the unified error format (see AllExceptionsFilter).
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Dữ liệu không hợp lệ',
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
}
