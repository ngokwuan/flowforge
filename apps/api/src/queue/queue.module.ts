import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
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
      useFactory: (config: ConfigService) => {
        const queue = new Queue<ExecutionJobData>(EXECUTIONS_QUEUE_NAME, {
          connection: redisConnectionFromUrl(
            config.getOrThrow<string>('REDIS_URL'),
          ),
          prefix: queuePrefix(config.get<string>('NODE_ENV') ?? 'development'),
          defaultJobOptions: {
            removeOnComplete: { age: 60 * 60, count: 1000 },
            removeOnFail: { age: 7 * 24 * 60 * 60 },
          },
        });
        // Without a listener a Redis problem is easy to miss. Log it instead.
        const logger = new Logger('ExecutionsQueue');
        queue.on('error', (error) =>
          logger.error(`Queue error: ${error.message}`),
        );
        return queue;
      },
    },
  ],
  exports: [EXECUTIONS_QUEUE],
})
export class QueueModule implements OnModuleDestroy {
  constructor(
    @Inject(EXECUTIONS_QUEUE) private readonly queue: Queue<ExecutionJobData>,
  ) {}

  async onModuleDestroy() {
    await this.queue.close();
  }
}
