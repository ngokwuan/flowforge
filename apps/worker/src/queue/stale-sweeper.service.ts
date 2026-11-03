import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  EXECUTIONS_QUEUE_NAME,
  queuePrefix,
  redisConnectionFromUrl,
  type ExecutionJobData,
} from '@flowforge/shared';
import { ENV, type WorkerEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Publishes the executions whose job got lost: the API saved the row but the
// publish failed or the process died. The database row is the source of truth.
@Injectable()
export class StaleSweeper implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StaleSweeper.name);
  private queue?: Queue<ExecutionJobData>;
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(ENV) private readonly env: WorkerEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.queue = new Queue<ExecutionJobData>(EXECUTIONS_QUEUE_NAME, {
      connection: redisConnectionFromUrl(this.env.REDIS_URL),
      prefix: queuePrefix(this.env.NODE_ENV),
      // Keep in sync with the API's queue module.
      defaultJobOptions: {
        removeOnComplete: { age: 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });
    this.queue.on('error', (error) => this.logger.error(`Queue error: ${error.message}`));

    this.timer = setInterval(() => {
      this.sweepOnce().catch((error: Error) =>
        this.logger.error(`Sweep failed: ${error.message}`),
      );
    }, this.env.SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /** Returns how many stale executions it published. Safe to run on several workers. */
  async sweepOnce(): Promise<number> {
    const queue = this.queue;
    if (!queue || this.sweeping) return 0;
    this.sweeping = true;
    try {
      const stale = await this.prisma.execution.findMany({
        where: {
          status: 'QUEUED',
          queuedAt: { lt: new Date(Date.now() - this.env.STALE_AFTER_MS) },
        },
        orderBy: { queuedAt: 'asc' },
        take: 100,
        select: { id: true, workspaceId: true },
      });

      for (const execution of stale) {
        // The job id is the execution id, so add() is ignored while any job with
        // that id still exists. A failed job is kept for days; remove it first,
        // otherwise this execution would stay QUEUED until the job expires.
        const existing = await queue.getJob(execution.id);
        if (existing && (await existing.isFailed())) await existing.remove();

        await queue.add(
          'run',
          { executionId: execution.id, workspaceId: execution.workspaceId },
          { jobId: execution.id },
        );
      }
      if (stale.length > 0) this.logger.warn(`Republished ${stale.length} stale execution(s)`);
      return stale.length;
    } finally {
      this.sweeping = false;
    }
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.close();
  }
}
