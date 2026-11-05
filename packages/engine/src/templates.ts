// Replaces {{ path }} placeholders in a node's config with values from earlier steps.
//
//   {{ trigger.orderId }}              the input the run was started with
//   {{ steps.call.output.body.id }}    the output of the node whose id is "call"
//   {{ steps.call.output.items[0] }}   array elements by index
//
// This is a path lookup, not an expression language: nothing here can execute
// code, call functions or reach prototypes.

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 32;

function lookup(path: string, scope: Record<string, unknown>): unknown {
  const parts = path.match(/[^.[\]]+/g);
  if (!parts) throw new TemplateError(`Biểu thức "${path}" không hợp lệ`);

  let current: unknown = scope;
  for (const part of parts) {
    if (FORBIDDEN.has(part)) {
      throw new TemplateError(
        `Biểu thức "${path}" truy cập vào khóa bị cấm "${part}"`,
      );
    }
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    ) {
      throw new TemplateError(`Không tìm thấy giá trị "${path}"`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));

export function resolveTemplates(
  value: unknown,
  scope: Record<string, unknown>,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) throw new TemplateError('Cấu hình lồng quá sâu');

  if (typeof value === 'string') {
    // A value that is exactly one placeholder keeps its type: 42 stays a number.
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1], scope);
    // Inside a longer string the value is turned into text.
    return value.replace(ANY, (_match, path: string) =>
      stringify(lookup(path, scope)),
    );
  }
  if (Array.isArray(value))
    return value.map((item) => resolveTemplates(item, scope, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveTemplates(item, scope, depth + 1),
      ]),
    );
  }
  return value;
}
