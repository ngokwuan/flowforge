import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

@Module({
  // AuthModule exports JwtModule for JwtAuthGuard; PrismaModule serves the
  // service and WorkspaceAccessGuard.
  imports: [AuthModule, PrismaModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
})
export class WorkflowsModule {}
