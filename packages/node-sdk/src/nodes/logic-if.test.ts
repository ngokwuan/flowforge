import { describe, expect, it } from 'vitest';
import { NodeExecutionError } from '../types';
import { logicIfNode } from './logic-if';

const run = (config: Record<string, unknown>) =>
  logicIfNode.execute({
    config: logicIfNode.configSchema.parse(config),
    input: undefined,
    signal: new AbortController().signal,
  });

describe('logic.if', () => {
  it('follows the true handle when the condition holds', async () => {
    const result = await run({ left: 5, operator: 'gt', right: 3 });
    expect(result).toEqual({ output: { result: true }, handle: 'true' });
  });

  it('follows the false handle otherwise', async () => {
    const result = await run({ left: 1, operator: 'gt', right: 3 });
    expect(result.handle).toBe('false');
  });

  it('does not coerce types: "42" is not 42', async () => {
    expect(
      (await run({ left: '42', operator: 'equals', right: 42 })).handle,
    ).toBe('false');
    expect(
      (await run({ left: 42, operator: 'equals', right: 42 })).handle,
    ).toBe('true');
  });

  it('compares objects and arrays by value', async () => {
    expect(
      (
        await run({
          left: { a: [1, 2] },
          operator: 'equals',
          right: { a: [1, 2] },
        })
      ).handle,
    ).toBe('true');
    expect(
      (
        await run({
          left: [1, { id: 2 }],
          operator: 'contains',
          right: { id: 2 },
        })
      ).handle,
    ).toBe('true');
    expect(
      (await run({ left: 'hello world', operator: 'contains', right: 'lo wo' }))
        .handle,
    ).toBe('true');
  });

  it('handles empty checks without a right-hand side', async () => {
    expect((await run({ left: '', operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: [], operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: {}, operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: 0, operator: 'isEmpty' })).handle).toBe('false');
    expect((await run({ left: 'x', operator: 'isNotEmpty' })).handle).toBe(
      'true',
    );
  });

  it('refuses to order values of different types', async () => {
    await expect(
      run({ left: '5', operator: 'gt', right: 3 }),
    ).rejects.toBeInstanceOf(NodeExecutionError);
  });

  it('requires a right-hand side except for the empty checks', () => {
    expect(
      logicIfNode.configSchema.safeParse({ left: 1, operator: 'equals' })
        .success,
    ).toBe(false);
    expect(
      logicIfNode.configSchema.safeParse({ left: 1, operator: 'isEmpty' })
        .success,
    ).toBe(true);
    expect(
      logicIfNode.configSchema.safeParse({ operator: 'nope', right: 1 })
        .success,
    ).toBe(false);
  });
});
