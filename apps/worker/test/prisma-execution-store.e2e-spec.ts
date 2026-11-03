import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runExecution } from '@flowforge/engine';
import { ENV, loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PrismaExecutionStore } from '../src/store/prisma-execution-store.js';
import { approvalFlow, cleanup, seedExecution, TRIGGER, wf } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('PrismaExecutionStore (real database)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let store: PrismaExecutionStore;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [{ provide: ENV, useFactory: loadEnv }, PrismaService, PrismaExecutionStore],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    store = moduleRef.get(PrismaExecutionStore);
  });

  afterAll(async () => {
    await cleanup(prisma);
    await moduleRef.close();
  });

  it('lets exactly one of ten concurrent claims win', async () => {
    const { executionId } = await seedExecution(prisma, wf([TRIGGER], []));

    const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(executionId)));

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const row = await prisma.execution.findUniqueOrThrow({ where: { id: executionId } });
    expect(row.status).toBe('RUNNING');
    expect(row.startedAt).toBeInstanceOf(Date);
  });

  it('returns the snapshot and the input when it claims', async () => {
    const definition = approvalFlow();
    const { executionId, workspaceId } = await seedExecution(prisma, definition, {
      input: { amount: 7 },
    });

    const claimed = await store.claim(executionId);

    expect(claimed).toMatchObject({ id: executionId, workspaceId, input: { amount: 7 } });
    expect(claimed?.definition.nodes.map((n) => n.id)).toEqual(['t', 'big', 'review', 'auto']);
  });

  it('does not claim an unknown or already running execution', async () => {
    expect(await store.claim('does-not-exist')).toBeNull();

    const { executionId } = await seedExecution(prisma, wf([TRIGGER], []));
    expect(await store.claim(executionId)).not.toBeNull();
    expect(await store.claim(executionId)).toBeNull();
  });

  it('creates steps once and records their lifecycle', async () => {
    const { executionId } = await seedExecution(prisma, wf([TRIGGER, ['a', 'logic.if']], [['t', 'a']]));
    const nodes = [{ id: 't', type: 'trigger.manual' }, { id: 'a', type: 'logic.if' }];

    await store.initSteps(executionId, nodes);
    await store.initSteps(executionId, nodes); // safe to repeat
    expect(await prisma.executionStep.count({ where: { executionId } })).toBe(2);

    await store.startStep(executionId, 't', { hello: 'world' });
    await store.finishStep(executionId, 't', { status: 'SUCCESS', output: { hello: 'world' }, attempt: 1 });
    await store.finishStep(executionId, 'a', { status: 'FAILED', error: 'boom', attempt: 1 });

    const t = await prisma.executionStep.findFirstOrThrow({ where: { executionId, nodeId: 't' } });
    expect(t).toMatchObject({ status: 'SUCCESS', attempt: 1, input: { hello: 'world' }, output: { hello: 'world' } });
    expect(t.startedAt).toBeInstanceOf(Date);
    expect(t.finishedAt).toBeInstanceOf(Date);

    const a = await prisma.executionStep.findFirstOrThrow({ where: { executionId, nodeId: 'a' } });
    expect(a).toMatchObject({ status: 'FAILED', error: 'boom' });
  });

  it('keeps the JSON value null apart from "no value"', async () => {
    const { executionId } = await seedExecution(prisma, wf([TRIGGER, ['a', 'logic.if']], [['t', 'a']]));
    await store.initSteps(executionId, [{ id: 't', type: 'trigger.manual' }, { id: 'a', type: 'logic.if' }]);
    await store.finishStep(executionId, 't', { status: 'SUCCESS', output: null, attempt: 1 });

    const rows = await prisma.$queryRaw<Array<{ nodeId: string; isSqlNull: boolean; text: string | null }>>`
      select "nodeId", ("output" is null) as "isSqlNull", "output"::text as "text"
      from "ExecutionStep" where "executionId" = ${executionId} order by "nodeId"`;

    expect(rows.find((r) => r.nodeId === 't')).toMatchObject({ isSqlNull: false, text: 'null' });
    expect(rows.find((r) => r.nodeId === 'a')).toMatchObject({ isSqlNull: true });
  });

  it('only finishes an execution that is running, and never overwrites a final state', async () => {
    const { executionId } = await seedExecution(prisma, wf([TRIGGER], []));

    await store.finish(executionId, 'SUCCESS'); // still QUEUED: ignored
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: executionId } })).status).toBe('QUEUED');

    await store.claim(executionId);
    await store.finish(executionId, 'FAILED', 'first');
    await store.finish(executionId, 'SUCCESS'); // already final: ignored

    const row = await prisma.execution.findUniqueOrThrow({ where: { id: executionId } });
    expect(row).toMatchObject({ status: 'FAILED', error: 'first' });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('drives a whole run of the engine through the database', async () => {
    const { executionId } = await seedExecution(prisma, approvalFlow(), { input: { amount: 250 } });

    const outcome = await runExecution(executionId, { store });

    expect(outcome).toBe('SUCCESS');
    const steps = await prisma.executionStep.findMany({ where: { executionId } });
    const byNode = Object.fromEntries(steps.map((s) => [s.nodeId, s]));
    expect(Object.fromEntries(steps.map((s) => [s.nodeId, s.status]))).toEqual({
      t: 'SUCCESS',
      big: 'SUCCESS',
      review: 'SUCCESS',
      auto: 'SKIPPED',
    });
    expect(byNode.big.output).toEqual({ result: true });
    expect(byNode.t.output).toEqual({ amount: 250 });
    expect(await runExecution(executionId, { store })).toBe('NOT_CLAIMED');
  });
});
