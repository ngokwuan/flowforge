import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';

@Module({
  // The queue comes from the global QueueModule.
  imports: [AuthModule, PrismaModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
