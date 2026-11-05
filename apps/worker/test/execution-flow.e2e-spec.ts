import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EXECUTIONS_QUEUE_NAME,
  queuePrefix,
  redisConnectionFromUrl,
  type ExecutionJobData,
} from '@flowforge/shared';
import { AppModule } from '../src/app.module.js';
import { ENV, type WorkerEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StaleSweeper } from '../src/queue/stale-sweeper.service.js';
import {
  approvalFlow,
  cleanup,
  FINAL,
  seedExecution,
  TRIGGER,
  wf,
  waitFor,
} from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('Worker end to end (real PostgreSQL and Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sweeper: StaleSweeper;
  let queue: Queue<ExecutionJobData>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // starts the BullMQ worker and the sweeper
    prisma = app.get(PrismaService);
    sweeper = app.get(StaleSweeper);

    const env = app.get<WorkerEnv>(ENV);
    // The same queue the worker reads, so the test can play the part of the API.
    queue = new Queue<ExecutionJobData>(EXECUTIONS_QUEUE_NAME, {
      connection: redisConnectionFromUrl(env.REDIS_URL),
      prefix: queuePrefix(env.NODE_ENV),
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }); // test keys have their own prefix
    await queue.close();
    await cleanup(prisma);
    await app.close();
  });

  const enqueue = (
    executionId: string,
    workspaceId: string,
    jobId = executionId,
  ) => queue.add('run', { executionId, workspaceId }, { jobId });

  const read = (executionId: string) =>
    prisma.execution.findUniqueOrThrow({ where: { id: executionId } });
  const finished = (executionId: string) =>
    waitFor(
      () => read(executionId),
      (e) => FINAL.includes(e.status),
    );
  const stateOf = async (jobId: string) =>
    (await queue.getJob(jobId))?.getState();
  const stepStatuses = async (executionId: string) =>
    Object.fromEntries(
      (await prisma.executionStep.findMany({ where: { executionId } })).map(
        (s) => [s.nodeId, s.status],
      ),
    );

  it('runs a queued execution to completion', async () => {
    const { executionId, workspaceId } = await seedExecution(
      prisma,
      approvalFlow(),
      {
        input: { amount: 250 },
      },
    );
    await enqueue(executionId, workspaceId);

    const execution = await finished(executionId);

    expect(execution.status).toBe('SUCCESS');
    expect(execution.error).toBeNull();
    expect(execution.startedAt).toBeInstanceOf(Date);
    expect(execution.finishedAt!.getTime()).toBeGreaterThanOrEqual(
      execution.startedAt!.getTime(),
    );
    expect(await stepStatuses(executionId)).toEqual({
      t: 'SUCCESS',
      big: 'SUCCESS',
      review: 'SUCCESS',
      auto: 'SKIPPED',
    });
  });

  it('fails an execution whose node is not allowed to run, and says why', async () => {
    const definition = wf(
      [TRIGGER, ['call', 'http.request', { url: '{{ trigger.target }}' }]],
      [['t', 'call']],
    );
    const { executionId, workspaceId } = await seedExecution(
      prisma,
      definition,
      {
        input: { target: 'http://127.0.0.1:9/internal' },
      },
    );
    await enqueue(executionId, workspaceId);

    const execution = await finished(executionId);

    expect(execution.status).toBe('FAILED');
    expect(execution.error).toContain('Node call');
    expect(execution.error).toContain('bị chặn');
    expect(await stepStatuses(executionId)).toEqual({
      t: 'SUCCESS',
      call: 'FAILED',
    });
  });

  it('processes many executions at the same time', async () => {
    const seeded = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        seedExecution(prisma, approvalFlow(), {
          input: { amount: i % 2 === 0 ? 500 : 5 },
        }),
      ),
    );
    await Promise.all(seeded.map((s) => enqueue(s.executionId, s.workspaceId)));

    const results = await Promise.all(
      seeded.map((s) => finished(s.executionId)),
    );

    expect(results.every((e) => e.status === 'SUCCESS')).toBe(true);
    const branches = await Promise.all(
      seeded.map((s) => stepStatuses(s.executionId)),
    );
    expect(branches.filter((b) => b.review === 'SUCCESS')).toHaveLength(4);
    expect(branches.filter((b) => b.auto === 'SUCCESS')).toHaveLength(4);
  });

  it('runs an execution once even when two jobs name it', async () => {
    const { executionId, workspaceId } = await seedExecution(
      prisma,
      approvalFlow(),
      {
        input: { amount: 1 },
      },
    );
    // Two different job ids simulate a duplicate delivery.
    const ids = [`${executionId}-a`, `${executionId}-b`];
    await Promise.all(
      ids.map((jobId) => enqueue(executionId, workspaceId, jobId)),
    );

    await finished(executionId);
    for (const id of ids) {
      await waitFor(
        () => stateOf(id),
        (state) => state === 'completed',
      );
    }
    const outcomes = await Promise.all(
      ids.map(async (id) => (await queue.getJob(id))!.returnvalue),
    );

    expect([...outcomes].sort()).toEqual(['NOT_CLAIMED', 'SUCCESS']);
    expect(await prisma.executionStep.count({ where: { executionId } })).toBe(
      4,
    );
  });

  it('survives a malformed job and keeps working', async () => {
    const badId = `bad-${randomUUID()}`;
    await queue.add('run', {} as unknown as ExecutionJobData, { jobId: badId });
    await waitFor(
      () => stateOf(badId),
      (state) => state === 'failed',
    );

    const { executionId, workspaceId } = await seedExecution(
      prisma,
      wf([TRIGGER], []),
    );
    await enqueue(executionId, workspaceId);
    expect((await finished(executionId)).status).toBe('SUCCESS');
  });

  describe('recovering executions whose job was lost', () => {
    const tenMinutesAgo = () => new Date(Date.now() - 10 * 60 * 1000);

    it('publishes a stale QUEUED execution that has no job', async () => {
      const { executionId } = await seedExecution(prisma, wf([TRIGGER], []), {
        queuedAt: tenMinutesAgo(),
      });
      expect(await queue.getJob(executionId)).toBeUndefined();

      const published = await sweeper.sweepOnce();

      expect(published).toBeGreaterThanOrEqual(1);
      expect((await finished(executionId)).status).toBe('SUCCESS');
    });

    it('replaces a failed job that still holds the execution id', async () => {
      const { executionId } = await seedExecution(prisma, wf([TRIGGER], []), {
        queuedAt: tenMinutesAgo(),
      });
      // A job with the same id and unusable data fails, and stays around for days.
      await queue.add('run', {} as unknown as ExecutionJobData, {
        jobId: executionId,
      });
      await waitFor(
        () => stateOf(executionId),
        (state) => state === 'failed',
      );
      expect((await read(executionId)).status).toBe('QUEUED');

      await sweeper.sweepOnce();

      expect((await finished(executionId)).status).toBe('SUCCESS');
    });

    it('leaves a recent QUEUED execution alone', async () => {
      const { executionId } = await seedExecution(prisma, wf([TRIGGER], []));

      await sweeper.sweepOnce();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect((await read(executionId)).status).toBe('QUEUED');
    });
  });
});
