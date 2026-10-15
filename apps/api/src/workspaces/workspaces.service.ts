import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AddMemberInput, Role } from '@flowforge/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const WORKSPACE_SELECT = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
} as const;

const MEMBER_SELECT = {
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, workspace: { select: WORKSPACE_SELECT } },
    });
    return memberships.map(({ role, workspace }) => ({ ...workspace, role }));
  }

  async getById(workspaceId: string, role: Role) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: WORKSPACE_SELECT,
    });
    if (!workspace) {
      throw new NotFoundException({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'Không tìm thấy workspace',
      });
    }
    return { ...workspace, role };
  }

  rename(workspaceId: string, name: string) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name },
      select: WORKSPACE_SELECT,
    });
  }

  listMembers(workspaceId: string) {
    return this.prisma.membership.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: MEMBER_SELECT,
    });
  }

  async addMember(workspaceId: string, input: AddMemberInput) {
    try {
      // `connect` makes Prisma fail if the user does not exist, and the unique
      // (userId, workspaceId) constraint fails if they are already a member.
      // Both are checked by the database, so concurrent requests cannot race.
      return await this.prisma.membership.create({
        data: {
          role: input.role,
          workspace: { connect: { id: workspaceId } },
          user: { connect: { email: input.email.trim().toLowerCase() } },
        },
        select: MEMBER_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException({
            code: 'WORKSPACE_MEMBER_EXISTS',
            message: 'Người dùng đã là thành viên của workspace',
          });
        }
        if (error.code === 'P2025') {
          throw new NotFoundException({
            code: 'USER_NOT_FOUND',
            message: 'Không tìm thấy người dùng với email này',
          });
        }
      }
      throw error;
    }
  }
}
