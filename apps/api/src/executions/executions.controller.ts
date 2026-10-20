import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createExecutionSchema,
  idempotencyKeySchema,
  type CreateExecutionInput,
} from '@flowforge/shared';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import {
  CurrentMembership,
  RequireRole,
} from '../workspaces/workspace.decorators';
import type { WorkspaceMembership } from '../workspaces/workspace-roles';
import { ExecutionsService } from './executions.service';

@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceAccessGuard)
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  // 202 Accepted: the run is recorded and queued, not finished.
  @Post('workflows/:workflowId/executions')
  @RequireRole('EDITOR')
  @HttpCode(202)
  create(
    @CurrentMembership() membership: WorkspaceMembership,
    @Param('workflowId') workflowId: string,
    @Body(new ZodValidationPipe(createExecutionSchema))
    body: CreateExecutionInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema))
    idempotencyKey: string | undefined,
  ) {
    return this.executions.create(
      membership.workspaceId,
      workflowId,
      body,
      idempotencyKey,
    );
  }

  @Get('executions/:executionId')
  get(
    @CurrentMembership() membership: WorkspaceMembership,
    @Param('executionId') executionId: string,
  ) {
    return this.executions.get(membership.workspaceId, executionId);
  }
}
