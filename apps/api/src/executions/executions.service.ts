import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { CreateExecutionInput, ExecutionJobData } from '@flowforge/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EXECUTIONS_QUEUE } from '../queue/queue.constants';

const EXECUTION_SELECT = {
  id: true,
  workflowId: true,
  workflowVersion: true,
  status: true,
  trigger: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

// Without a timeout, a Redis outage would hang the request until Redis returns.
const ENQUEUE_TIMEOUT_MS = 3000;

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

// The database row is the source of truth. An execution is created as QUEUED
// first, then a job is published. If publishing fails (Redis down, process
// crash), the row stays QUEUED and republishStaleQueued() publishes it later.
// Publishing uses the execution id as the job id, so doing it twice is harmless.
@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EXECUTIONS_QUEUE) private readonly queue: Queue<ExecutionJobData>,
  ) {}

  async create(
    workspaceId: string,
    workflowId: string,
    input: CreateExecutionInput,
    idempotencyKey?: string,
  ) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
      select: { version: true, definition: true },
    });
    if (!workflow) {
      throw new NotFoundException({
        code: 'WORKFLOW_NOT_FOUND',
        message: 'Không tìm thấy workflow',
      });
    }

    let execution;
    try {
      execution = await this.prisma.execution.create({
        data: {
          workspaceId,
          workflowId,
          workflowVersion: workflow.version,
          // Snapshot: later edits to the workflow must not change this run.
          definition: asJson(workflow.definition),
          trigger: 'MANUAL',
          input: input.input === undefined ? undefined : asJson(input.input),
          idempotencyKey,
        },
        select: EXECUTION_SELECT,
      });
    } catch (error) {
      // The unique (workflowId, idempotencyKey) constraint decides who wins when
      // the same key arrives twice, even concurrently. The loser returns the winner.
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        execution = await this.prisma.execution.findFirst({
          where: { workflowId, idempotencyKey },
          select: EXECUTION_SELECT,
        });
      }
      if (!execution) throw error;
    }

    // Also runs for a replayed key: it heals a publish that was lost the first time.
    if (execution.status === 'QUEUED') {
      await this.enqueue({ id: execution.id, workspaceId });
    }
    return execution;
  }

  async get(workspaceId: string, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, workspaceId },
      select: {
        ...EXECUTION_SELECT,
        input: true,
        error: true,
        steps: {
          orderBy: { nodeId: 'asc' },
          select: {
            nodeId: true,
            nodeType: true,
            status: true,
            attempt: true,
            error: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    });
    if (!execution) {
      throw new NotFoundException({
        code: 'EXECUTION_NOT_FOUND',
        message: 'Không tìm thấy lần chạy',
      });
    }
    return execution;
  }

  /**
   * Publishes executions that are still QUEUED after `olderThanMs`, meaning their
   * job was lost. Meant to run periodically from the worker. Returns how many
   * were published.
   */
  async republishStaleQueued(olderThanMs = 30_000, limit = 100) {
    const stale = await this.prisma.execution.findMany({
      where: {
        status: 'QUEUED',
        queuedAt: { lt: new Date(Date.now() - olderThanMs) },
      },
      orderBy: { queuedAt: 'asc' },
      take: limit,
      select: { id: true, workspaceId: true },
    });

    let published = 0;
    for (const execution of stale) {
      if (await this.enqueue(execution)) published += 1;
    }
    return published;
  }

  private async enqueue(execution: { id: string; workspaceId: string }) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'run',
          { executionId: execution.id, workspaceId: execution.workspaceId },
          { jobId: execution.id },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('enqueue timed out')),
            ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch (error) {
      // Not fatal: the row stays QUEUED and will be republished.
      this.logger.error(
        `Could not enqueue execution ${execution.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
