import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { defineNode, NodeExecutionError } from '../types';

const OPERATORS = [
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'isEmpty',
  'isNotEmpty',
] as const;

const configSchema = z
  .object({
    left: z.unknown().optional(),
    operator: z.enum(OPERATORS),
    right: z.unknown().optional(),
  })
  .refine(
    (config) =>
      ['isEmpty', 'isNotEmpty'].includes(config.operator) ||
      config.right !== undefined,
    { message: 'Toán tử này cần giá trị so sánh "right"', path: ['right'] },
  );

type Operator = (typeof OPERATORS)[number];

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' || Array.isArray(value))
    return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compare(operator: Operator, left: unknown, right: unknown): boolean {
  switch (operator) {
    case 'equals':
      return isDeepStrictEqual(left, right);
    case 'notEquals':
      return !isDeepStrictEqual(left, right);
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string')
        return left.includes(right);
      if (Array.isArray(left))
        return left.some((item) => isDeepStrictEqual(item, right));
      return false;
    default: {
      // Ordering is defined for two numbers or two strings, never across types.
      const comparable =
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'string' && typeof right === 'string');
      if (!comparable) {
        throw new NodeExecutionError(
          `Không thể so sánh "${operator}" giữa ${typeof left} và ${typeof right}`,
        );
      }
      const a = left as number | string;
      const b = right as number | string;
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
  }
}

// No implicit type coercion: "42" does not equal 42. Surprises here would route
// a workflow down the wrong branch without any error.
export const logicIfNode = defineNode({
  type: 'logic.if',
  name: 'If / Else',
  category: 'logic',
  description: 'Sends the run down the "true" or "false" branch.',
  configSchema,
  handles: ['true', 'false'],
  async execute({ config }) {
    const result = compare(config.operator, config.left, config.right);
    return { output: { result }, handle: result ? 'true' : 'false' };
  },
});
