import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  EXECUTIONS_QUEUE_NAME,
  queuePrefix,
  redisConnectionFromUrl,
  type ExecutionJobData,
} from '@flowforge/shared';
import { EXECUTIONS_QUEUE } from './queue.constants';

@Global()
@Module({
  providers: [
    {
      provide: EXECUTIONS_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Queue<ExecutionJobData>(EXECUTIONS_QUEUE_NAME, {
          connection: redisConnectionFromUrl(
            config.getOrThrow<string>('REDIS_URL'),
          ),
          prefix: queuePrefix(config.get<string>('NODE_ENV') ?? 'development'),
          defaultJobOptions: {
            // Finished jobs are only bookkeeping: the database holds the real history.
            removeOnComplete: { age: 60 * 60, count: 1000 },
            removeOnFail: { age: 7 * 24 * 60 * 60 },
          },
        }),
    },
  ],
  exports: [EXECUTIONS_QUEUE],
})
export class QueueModule implements OnModuleDestroy {
  constructor(
    @Inject(EXECUTIONS_QUEUE) private readonly queue: Queue<ExecutionJobData>,
  ) {}

  // Runs on graceful shutdown (and app.close() in tests): closes Redis connections.
  async onModuleDestroy() {
    await this.queue.close();
  }
}
