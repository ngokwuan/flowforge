import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  addMemberSchema,
  updateWorkspaceSchema,
  type AddMemberInput,
  type UpdateWorkspaceInput,
} from '@flowforge/shared';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import { CurrentMembership, RequireRole } from './workspace.decorators';
import type { WorkspaceMembership } from './workspace-roles';
import { WorkspacesService } from './workspaces.service';

// Guards run before pipes, so a non-member gets 404 before any body validation:
// an outsider learns nothing, not even whether their payload was well formed.
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  get(@CurrentMembership() membership: WorkspaceMembership) {
    return this.workspaces.getById(membership.workspaceId, membership.role);
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  @RequireRole('OWNER')
  rename(
    @CurrentMembership() membership: WorkspaceMembership,
    @Body(new ZodValidationPipe(updateWorkspaceSchema))
    body: UpdateWorkspaceInput,
  ) {
    return this.workspaces.rename(membership.workspaceId, body.name);
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceAccessGuard)
  members(@CurrentMembership() membership: WorkspaceMembership) {
    return this.workspaces.listMembers(membership.workspaceId);
  }

  @Post(':workspaceId/members')
  @UseGuards(WorkspaceAccessGuard)
  @RequireRole('OWNER')
  addMember(
    @CurrentMembership() membership: WorkspaceMembership,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
  ) {
    return this.workspaces.addMember(membership.workspaceId, body);
  }
}
