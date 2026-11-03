import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ENV, loadEnv } from './config/env.js';
import { PrismaService } from './prisma/prisma.service.js';
import { ExecutionsWorker } from './queue/executions-worker.service.js';
import { StaleSweeper } from './queue/stale-sweeper.service.js';
import { PrismaExecutionStore } from './store/prisma-execution-store.js';

@Module({
  controllers: [AppController],
  providers: [
    AppService,
    { provide: ENV, useFactory: loadEnv },
    PrismaService,
    PrismaExecutionStore,
    ExecutionsWorker,
    StaleSweeper,
  ],
})
export class AppModule {}
