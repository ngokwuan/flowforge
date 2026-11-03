import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { runExecution } from '@flowforge/engine';
import {
  EXECUTIONS_QUEUE_NAME,
  queuePrefix,
  redisConnectionFromUrl,
  type ExecutionJobData,
} from '@flowforge/shared';
import { ENV, type WorkerEnv } from '../config/env.js';
import { PrismaExecutionStore } from '../store/prisma-execution-store.js';

const jobDataSchema = z.object({
  executionId: z.string().min(1),
  workspaceId: z.string().min(1),
});

@Injectable()
export class ExecutionsWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExecutionsWorker.name);
  private readonly running = new Set<AbortController>();
  private worker?: Worker<ExecutionJobData>;

  constructor(
    @Inject(ENV) private readonly env: WorkerEnv,
    @Inject(PrismaExecutionStore) private readonly store: PrismaExecutionStore,
  ) {}

  onModuleInit() {
    this.worker = new Worker<ExecutionJobData>(
      EXECUTIONS_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: redisConnectionFromUrl(this.env.REDIS_URL),
        prefix: queuePrefix(this.env.NODE_ENV),
        concurrency: this.env.WORKER_CONCURRENCY,
      },
    );
    // Without listeners a Redis problem would go unnoticed.
    this.worker.on('error', (error) => this.logger.error(`Worker error: ${error.message}`));
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Job ${job?.id ?? '?'} failed: ${error.message}`),
    );
  }

  private async process(job: Job<ExecutionJobData>) {
    // A malformed job throws and is marked failed; it never reaches the engine.
    const { executionId } = jobDataSchema.parse(job.data);

    const controller = new AbortController();
    this.running.add(controller);
    try {
      const outcome = await runExecution(executionId, {
        store: this.store,
        signal: controller.signal,
        logger: {
          error: (message, detail) =>
            this.logger.error(message, detail instanceof Error ? detail.stack : String(detail)),
        },
      });
      this.logger.log(`Execution ${executionId}: ${outcome}`);
      return outcome;
    } finally {
      this.running.delete(controller);
    }
  }

  // close() stops taking jobs and waits for the running ones. If they take longer
  // than the grace period they are cancelled, so the process can always exit.
  async onApplicationShutdown() {
    if (!this.worker) return;
    const timer = setTimeout(() => {
      this.logger.warn(`Cancelling ${this.running.size} running execution(s)`);
      for (const controller of this.running) controller.abort();
    }, this.env.SHUTDOWN_GRACE_MS);
    try {
      await this.worker.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
