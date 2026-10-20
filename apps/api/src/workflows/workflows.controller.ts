import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createWorkflowSchema,
  listWorkflowsQuerySchema,
  updateWorkflowSchema,
  type CreateWorkflowInput,
  type ListWorkflowsQuery,
  type UpdateWorkflowInput,
} from '@flowforge/shared';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import {
  CurrentMembership,
  RequireRole,
} from '../workspaces/workspace.decorators';
import type { WorkspaceMembership } from '../workspaces/workspace-roles';
import { WorkflowsService } from './workflows.service';

// Without @RequireRole a route needs VIEWER. Writes need EDITOR, delete needs OWNER.
@Controller('workspaces/:workspaceId/workflows')
@UseGuards(JwtAuthGuard, WorkspaceAccessGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(
    @CurrentMembership() membership: WorkspaceMembership,
    @Query(new ZodValidationPipe(listWorkflowsQuerySchema))
    query: ListWorkflowsQuery,
  ) {
    return this.workflows.list(membership.workspaceId, query);
  }

  @Post()
  @RequireRole('EDITOR')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: WorkspaceMembership,
    @Body(new ZodValidationPipe(createWorkflowSchema))
    body: CreateWorkflowInput,
  ) {
    return this.workflows.create(membership.workspaceId, user.id, body);
  }

  @Get(':workflowId')
  get(
    @CurrentMembership() membership: WorkspaceMembership,
    @Param('workflowId') workflowId: string,
  ) {
    return this.workflows.get(membership.workspaceId, workflowId);
  }

  @Patch(':workflowId')
  @RequireRole('EDITOR')
  update(
    @CurrentMembership() membership: WorkspaceMembership,
    @Param('workflowId') workflowId: string,
    @Body(new ZodValidationPipe(updateWorkflowSchema))
    body: UpdateWorkflowInput,
  ) {
    return this.workflows.update(membership.workspaceId, workflowId, body);
  }

  @Delete(':workflowId')
  @RequireRole('OWNER')
  @HttpCode(204)
  remove(
    @CurrentMembership() membership: WorkspaceMembership,
    @Param('workflowId') workflowId: string,
  ) {
    return this.workflows.remove(membership.workspaceId, workflowId);
  }
}
