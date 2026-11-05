import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '@flowforge/shared';
import {
  defineNode,
  getNodeDefinition,
  NodeExecutionError,
  type NodeDefinition,
} from '@flowforge/node-sdk';
import { runExecution } from './engine';
import { InMemoryExecutionStore } from './memory-store';

// ---------- test nodes ----------

const stats = { active: 0, peak: 0, runs: 0 };
const resetStats = () => Object.assign(stats, { active: 0, peak: 0, runs: 0 });

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

const base = {
  category: 'logic' as const,
  description: '',
  handles: ['default'] as const,
};

const echo = defineNode({
  ...base,
  type: 'test.echo',
  name: 'Echo',
  configSchema: z.object({ value: z.unknown().optional() }),
  async execute({ config, input }) {
    stats.runs += 1;
    return { output: { value: config.value, input } };
  },
});
const failing = defineNode({
  ...base,
  type: 'test.fail',
  name: 'Failing',
  configSchema: z.object({}),
  async execute() {
    throw new NodeExecutionError('boom');
  },
});
const crashing = defineNode({
  ...base,
  type: 'test.crash',
  name: 'Crashing',
  configSchema: z.object({}),
  async execute() {
    throw new Error('connection string postgres://user:hunter2@db');
  },
});
const slow = defineNode({
  ...base,
  type: 'test.slow',
  name: 'Slow',
  configSchema: z.object({ ms: z.number() }),
  async execute({ config, signal }) {
    stats.active += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    try {
      await sleep(config.ms, signal);
      return { output: { done: true } };
    } finally {
      stats.active -= 1;
    }
  },
});
const needsNumber = defineNode({
  ...base,
  type: 'test.number',
  name: 'Needs number',
  configSchema: z.object({ n: z.number() }),
  async execute({ config }) {
    return { output: { n: config.n } };
  },
});
const big = defineNode({
  ...base,
  type: 'test.big',
  name: 'Big',
  configSchema: z.object({}),
  async execute() {
    return { output: 'x'.repeat(2000) };
  },
});
const badHandle = defineNode({
  ...base,
  type: 'test.badhandle',
  name: 'Bad handle',
  configSchema: z.object({}),
  async execute() {
    return { output: 1, handle: 'nope' };
  },
});

const testNodes = new Map<string, NodeDefinition>(
  [echo, failing, crashing, slow, needsNumber, big, badHandle].map((n) => [
    n.type,
    n as NodeDefinition,
  ]),
);
const resolveNode = (type: string) =>
  testNodes.get(type) ?? getNodeDefinition(type);

// ---------- helpers ----------

type NodeSpec = [id: string, type: string, config?: Record<string, unknown>];
type EdgeSpec = [source: string, target: string, handle?: string];

const wf = (nodes: NodeSpec[], edges: EdgeSpec[]): WorkflowDefinition => ({
  nodes: nodes.map(([id, type, config]) => ({
    id,
    type,
    name: `Node ${id}`,
    config: config ?? {},
    position: { x: 0, y: 0 },
  })),
  edges: edges.map(([source, target, handle], i) => ({
    id: `e${i}`,
    source,
    target,
    ...(handle ? { sourceHandle: handle } : {}),
  })),
});

const T: NodeSpec = ['t', 'trigger.manual'];

async function run(
  definition: WorkflowDefinition,
  options: {
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    maxParallelism?: number;
    maxOutputBytes?: number;
  } = {},
) {
  resetStats();
  const store = new InMemoryExecutionStore();
  const logger = { error: vi.fn() };
  store.add({ id: 'x1', definition, input: options.input });
  const outcome = await runExecution('x1', {
    store,
    resolveNode,
    logger,
    ...options,
  });
  return { store, outcome, logger };
}

const statuses = (store: InMemoryExecutionStore) =>
  Object.fromEntries(store.stepsOf('x1').map((s) => [s.nodeId, s.status]));

// ---------- tests ----------

describe('data flow', () => {
  it('runs nodes in order and passes each output to the next node', async () => {
    const { store, outcome } = await run(
      wf(
        [T, ['a', 'test.echo', { value: 1 }], ['b', 'test.echo']],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
      { input: { hello: 'world' } },
    );

    expect(outcome).toBe('SUCCESS');
    expect(store.statusOf('x1')).toBe('SUCCESS');
    expect(statuses(store)).toEqual({
      t: 'SUCCESS',
      a: 'SUCCESS',
      b: 'SUCCESS',
    });
    expect(store.step('x1', 't')?.output).toEqual({ hello: 'world' });
    expect(store.step('x1', 'a')?.input).toEqual({ hello: 'world' });
    expect(store.step('x1', 'b')?.input).toEqual({
      value: 1,
      input: { hello: 'world' },
    });
  });

  it('gives a node with several parents an object keyed by parent id', async () => {
    const { store } = await run(
      wf(
        [
          T,
          ['a', 'test.echo', { value: 'A' }],
          ['b', 'test.echo', { value: 'B' }],
          ['c', 'test.echo'],
        ],
        [
          ['t', 'a'],
          ['t', 'b'],
          ['a', 'c'],
          ['b', 'c'],
        ],
      ),
    );
    expect(store.step('x1', 'c')?.input).toMatchObject({
      a: { value: 'A' },
      b: { value: 'B' },
    });
  });
});

describe('parallelism', () => {
  it('runs independent branches at the same time', async () => {
    const { outcome } = await run(
      wf(
        [T, ['a', 'test.slow', { ms: 60 }], ['b', 'test.slow', { ms: 60 }]],
        [
          ['t', 'a'],
          ['t', 'b'],
        ],
      ),
    );
    expect(outcome).toBe('SUCCESS');
    expect(stats.peak).toBe(2);
  });

  it('never runs more nodes at once than maxParallelism', async () => {
    const nodes: NodeSpec[] = [
      T,
      ...[1, 2, 3, 4, 5].map((i): NodeSpec => [
        `n${i}`,
        'test.slow',
        { ms: 30 },
      ]),
    ];
    const edges: EdgeSpec[] = [1, 2, 3, 4, 5].map((i): EdgeSpec => [
      't',
      `n${i}`,
    ]);
    const { outcome } = await run(wf(nodes, edges), { maxParallelism: 2 });
    expect(outcome).toBe('SUCCESS');
    expect(stats.peak).toBeLessThanOrEqual(2);
  });
});

describe('branching with If / Else', () => {
  const branching = (left: unknown) =>
    wf(
      [
        T,
        ['check', 'logic.if', { left, operator: 'equals', right: 1 }],
        ['yes', 'test.echo', { value: 'took true' }],
        ['no', 'test.echo', { value: 'took false' }],
        ['after', 'test.echo'],
      ],
      [
        ['t', 'check'],
        ['check', 'yes', 'true'],
        ['check', 'no', 'false'],
        ['yes', 'after'],
        ['no', 'after'],
      ],
    );

  it('runs only the true branch and skips the other', async () => {
    const { store, outcome } = await run(branching(1));
    expect(outcome).toBe('SUCCESS');
    expect(statuses(store)).toEqual({
      t: 'SUCCESS',
      check: 'SUCCESS',
      yes: 'SUCCESS',
      no: 'SKIPPED',
      after: 'SUCCESS',
    });
  });

  it('runs only the false branch when the condition fails', async () => {
    const { store } = await run(branching(2));
    expect(statuses(store)).toMatchObject({
      yes: 'SKIPPED',
      no: 'SUCCESS',
      after: 'SUCCESS',
    });
  });

  it('lets the node where branches meet receive only the branch that ran', async () => {
    const { store } = await run(branching(1));
    expect(store.step('x1', 'after')?.input).toMatchObject({
      value: 'took true',
    });
  });

  it('skips everything below a skipped node', async () => {
    const d = wf(
      [
        T,
        ['check', 'logic.if', { left: 2, operator: 'equals', right: 1 }],
        ['yes', 'test.echo'],
        ['deeper', 'test.echo'],
      ],
      [
        ['t', 'check'],
        ['check', 'yes', 'true'],
        ['yes', 'deeper'],
      ],
    );
    const { store, outcome } = await run(d);
    expect(outcome).toBe('SUCCESS');
    expect(statuses(store)).toMatchObject({
      yes: 'SKIPPED',
      deeper: 'SKIPPED',
    });
  });
});

describe('failures', () => {
  it('fails the run, records the error and skips what was not started', async () => {
    const { store, outcome } = await run(
      wf(
        [T, ['a', 'test.fail'], ['b', 'test.echo']],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
    );
    expect(outcome).toBe('FAILED');
    expect(store.statusOf('x1')).toBe('FAILED');
    expect(store.errorOf('x1')).toBe('Node a: boom');
    expect(statuses(store)).toEqual({
      t: 'SUCCESS',
      a: 'FAILED',
      b: 'SKIPPED',
    });
    expect(store.step('x1', 'a')?.error).toBe('boom');
  });

  it('lets a sibling that was already running finish', async () => {
    const { store, outcome } = await run(
      wf(
        [
          T,
          ['bad', 'test.fail'],
          ['ok', 'test.slow', { ms: 30 }],
          ['after', 'test.echo'],
        ],
        [
          ['t', 'bad'],
          ['t', 'ok'],
          ['bad', 'after'],
          ['ok', 'after'],
        ],
      ),
    );
    expect(outcome).toBe('FAILED');
    expect(statuses(store)).toEqual({
      t: 'SUCCESS',
      bad: 'FAILED',
      ok: 'SUCCESS',
      after: 'SKIPPED',
    });
  });

  it('shows users a generic message for unexpected errors and logs the real one', async () => {
    const { store, logger } = await run(
      wf([T, ['a', 'test.crash']], [['t', 'a']]),
    );
    const message = store.step('x1', 'a')?.error;
    expect(message).toBe('Node gặp lỗi không xác định');
    expect(store.errorOf('x1')).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String((logger.error.mock.calls[0][1] as Error).message)).toContain(
      'hunter2',
    );
  });

  it('fails a step whose node type does not exist', async () => {
    const { store, outcome } = await run(
      wf([T, ['a', 'does.not.exist']], [['t', 'a']]),
    );
    expect(outcome).toBe('FAILED');
    expect(store.step('x1', 'a')?.error).toContain('không tồn tại');
  });

  it('rejects a node that returns a handle it does not declare', async () => {
    const { store } = await run(wf([T, ['a', 'test.badhandle']], [['t', 'a']]));
    expect(store.step('x1', 'a')?.error).toContain('nhánh không hợp lệ');
  });

  it('rejects an output above the size limit', async () => {
    const { store, outcome } = await run(
      wf([T, ['a', 'test.big']], [['t', 'a']]),
      { maxOutputBytes: 100 },
    );
    expect(outcome).toBe('FAILED');
    expect(store.step('x1', 'a')?.error).toContain('vượt quá giới hạn');
  });

  it('refuses to run a workflow that contains a cycle', async () => {
    const { store, outcome } = await run(
      wf(
        [T, ['a', 'test.echo'], ['b', 'test.echo']],
        [
          ['t', 'a'],
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    );
    expect(outcome).toBe('FAILED');
    expect(store.errorOf('x1')).toContain('vòng lặp');
    expect(stats.runs).toBe(0);
  });
});

describe('expressions in config', () => {
  it('resolves values from the trigger and from earlier steps, keeping types', async () => {
    const { store, outcome } = await run(
      wf(
        [
          T,
          ['a', 'test.echo', { value: '{{ trigger.n }}' }],
          [
            'b',
            'test.echo',
            {
              value:
                'n is {{ trigger.n }} and a gave {{ steps.a.output.value }}',
            },
          ],
        ],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
      { input: { n: 5 } },
    );
    expect(outcome).toBe('SUCCESS');
    expect((store.step('x1', 'a')?.output as { value: unknown }).value).toBe(5);
    expect((store.step('x1', 'b')?.output as { value: unknown }).value).toBe(
      'n is 5 and a gave 5',
    );
  });

  it('fails the step when a referenced value does not exist', async () => {
    const { store, outcome } = await run(
      wf(
        [T, ['a', 'test.echo', { value: '{{ steps.ghost.output.x }}' }]],
        [['t', 'a']],
      ),
    );
    expect(outcome).toBe('FAILED');
    expect(store.step('x1', 'a')?.error).toContain('steps.ghost.output.x');
    expect(stats.runs).toBe(0);
  });

  it('refuses expressions that reach into prototypes', async () => {
    const { store } = await run(
      wf(
        [T, ['a', 'test.echo', { value: '{{ trigger.constructor }}' }]],
        [['t', 'a']],
      ),
    );
    expect(store.step('x1', 'a')?.status).toBe('FAILED');
  });

  it('validates the config again after resolving it', async () => {
    const { store, outcome } = await run(
      wf([T, ['a', 'test.number', { n: '{{ trigger.name }}' }]], [['t', 'a']]),
      { input: { name: 'not a number' } },
    );
    expect(outcome).toBe('FAILED');
    expect(store.step('x1', 'a')?.error).toContain('Cấu hình không hợp lệ (n)');
  });

  it('applies the SSRF guard to a URL that only exists at run time', async () => {
    const { store, outcome } = await run(
      wf(
        [T, ['call', 'http.request', { url: '{{ trigger.target }}' }]],
        [['t', 'call']],
      ),
      { input: { target: 'http://169.254.169.254/latest/meta-data' } },
    );
    expect(outcome).toBe('FAILED');
    expect(store.step('x1', 'call')?.error).toContain('bị chặn');
  });

  it('works with the real trigger and If / Else nodes', async () => {
    const d = wf(
      [
        T,
        [
          'big',
          'logic.if',
          { left: '{{ trigger.amount }}', operator: 'gt', right: 100 },
        ],
        ['review', 'test.echo', { value: 'manual review' }],
        ['auto', 'test.echo', { value: 'auto approve' }],
      ],
      [
        ['t', 'big'],
        ['big', 'review', 'true'],
        ['big', 'auto', 'false'],
      ],
    );
    const { store } = await run(d, { input: { amount: 150 } });
    expect(statuses(store)).toMatchObject({
      review: 'SUCCESS',
      auto: 'SKIPPED',
    });
  });
});

describe('claiming and cancelling', () => {
  it('runs a workflow once even when the same job arrives twice at the same time', async () => {
    resetStats();
    const store = new InMemoryExecutionStore();
    store.add({
      id: 'x1',
      definition: wf([T, ['a', 'test.echo']], [['t', 'a']]),
    });

    const outcomes = await Promise.all([
      runExecution('x1', { store, resolveNode }),
      runExecution('x1', { store, resolveNode }),
    ]);

    expect(outcomes.sort()).toEqual(['NOT_CLAIMED', 'SUCCESS']);
    expect(stats.runs).toBe(1);
  });

  it('does not run an execution that has already finished', async () => {
    const store = new InMemoryExecutionStore();
    store.add({ id: 'x1', definition: wf([T], []) });
    expect(await runExecution('x1', { store, resolveNode })).toBe('SUCCESS');
    expect(await runExecution('x1', { store, resolveNode })).toBe(
      'NOT_CLAIMED',
    );
  });

  it('does not run an execution that does not exist', async () => {
    const store = new InMemoryExecutionStore();
    expect(await runExecution('ghost', { store, resolveNode })).toBe(
      'NOT_CLAIMED',
    );
  });

  it('cancels a running workflow and skips the rest', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    const started = Date.now();
    const { store, outcome } = await run(
      wf(
        [T, ['a', 'test.slow', { ms: 2000 }], ['b', 'test.echo']],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
      { signal: controller.signal },
    );

    expect(outcome).toBe('CANCELLED');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.statusOf('x1')).toBe('CANCELLED');
    expect(statuses(store)).toEqual({
      t: 'SUCCESS',
      a: 'FAILED',
      b: 'SKIPPED',
    });
    expect(store.step('x1', 'a')?.error).toContain('hủy');
  });
});
