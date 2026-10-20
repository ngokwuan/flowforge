import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateWorkflowInput,
  ListWorkflowsQuery,
  UpdateWorkflowInput,
} from '@flowforge/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DETAIL_SELECT = { ...SUMMARY_SELECT, definition: true } as const;

const notFound = () =>
  new NotFoundException({
    code: 'WORKFLOW_NOT_FOUND',
    message: 'Không tìm thấy workflow',
  });

// The definition was validated by workflowDefinitionSchema before it got here.
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

// Every query below filters by workspaceId. That value comes from the membership
// the guard verified, never from the request body, so a workflow id alone can
// never reach another workspace's data.
@Injectable()
export class WorkflowsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, { limit, cursor }: ListWorkflowsQuery) {
    const rows = await this.prisma.workflow.findMany({
      where: { workspaceId },
      // id breaks ties so the order is total and cursor pages never overlap.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // one extra row tells us whether another page exists
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      select: SUMMARY_SELECT,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  async get(workspaceId: string, id: string) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, workspaceId },
      select: DETAIL_SELECT,
    });
    if (!workflow) throw notFound();
    return workflow;
  }

  create(workspaceId: string, userId: string, input: CreateWorkflowInput) {
    return this.prisma.workflow.create({
      data: {
        workspaceId,
        createdById: userId,
        name: input.name,
        description: input.description,
        definition: asJson(input.definition),
      },
      select: DETAIL_SELECT,
    });
  }

  async update(workspaceId: string, id: string, input: UpdateWorkflowInput) {
    const { version, name, description, definition } = input;

    try {
      // One atomic statement: it matches only if the row is still at `version`.
      // Of two concurrent updates with the same version, exactly one matches.
      return await this.prisma.workflow.update({
        where: { id, workspaceId, version },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(definition !== undefined && { definition: asJson(definition) }),
          version: { increment: 1 },
        },
        select: DETAIL_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        // No row matched: either it does not exist here, or the version is stale.
        const current = await this.prisma.workflow.findFirst({
          where: { id, workspaceId },
          select: { version: true },
        });
        if (!current) throw notFound();
        throw new ConflictException({
          code: 'WORKFLOW_VERSION_CONFLICT',
          message:
            'Workflow đã được cập nhật ở nơi khác, hãy tải lại rồi thử lại',
          details: { currentVersion: current.version },
        });
      }
      throw error;
    }
  }

  async remove(workspaceId: string, id: string) {
    const { count } = await this.prisma.workflow.deleteMany({
      where: { id, workspaceId },
    });
    if (count === 0) throw notFound();
  }
}
