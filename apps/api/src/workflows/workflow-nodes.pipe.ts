import { BadRequestException, PipeTransform } from '@nestjs/common';
import { normalizeNodeConfigs } from '@flowforge/node-sdk';
import type { WorkflowDefinition } from '@flowforge/shared';

// Runs after ZodValidationPipe. The shared schema checks structure and graph shape;
// this checks every node's type and config against the node registry and replaces
// each config with its parsed form, so defaults are stored explicitly.
export class WorkflowNodesPipe implements PipeTransform {
  transform(value: { definition?: WorkflowDefinition }) {
    if (!value.definition) return value;

    const result = normalizeNodeConfigs(value.definition);
    if (!result.ok) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Dữ liệu không hợp lệ',
        details: result.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return { ...value, definition: result.definition };
  }
}
