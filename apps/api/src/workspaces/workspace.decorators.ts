import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Role } from '@flowforge/shared';
import { REQUIRED_ROLE_KEY, type WorkspaceMembership } from './workspace-roles';

// Minimum role for a route. Without it, any member may access the route.
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE_KEY, role);

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceMembership =>
    ctx.switchToHttp().getRequest<{ membership: WorkspaceMembership }>()
      .membership,
);
