import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@flowforge/shared';
import type { Request } from 'express';
import { unauthorized } from '../auth/auth.errors';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  REQUIRED_ROLE_KEY,
  ROLE_RANK,
  type WorkspaceMembership,
} from './workspace-roles';

// Use AFTER JwtAuthGuard, on routes that have a :workspaceId parameter.
// Every workspace-scoped feature (workflows, executions, credentials) reuses it.
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request<{ workspaceId?: string }> & {
        user?: AuthUser;
        membership?: WorkspaceMembership;
      }
    >();
    const workspaceId = req.params.workspaceId;

    if (!req.user || !workspaceId) {
      throw unauthorized(
        'AUTH_UNAUTHORIZED',
        'Chưa đăng nhập hoặc phiên đã hết hạn',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: req.user.id, workspaceId } },
      select: { role: true },
    });

    // 404 rather than 403 for non-members: a 403 would confirm the workspace
    // exists, letting outsiders probe for ids.
    if (!membership) {
      throw new NotFoundException({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'Không tìm thấy workspace',
      });
    }

    const required =
      this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'VIEWER';

    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException({
        code: 'WORKSPACE_FORBIDDEN',
        message: 'Bạn không có quyền thực hiện thao tác này',
      });
    }

    req.membership = { workspaceId, role: membership.role };
    return true;
  }
}
