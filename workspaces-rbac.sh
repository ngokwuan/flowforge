#!/usr/bin/env bash
# FlowForge: workspaces + role-based access control + tenant isolation tests.
# Run from the repo root:  bash workspaces-rbac.sh
# NEW files are skipped if they exist. Files marked "force" are OVERWRITTEN
# (the stubs created by `nest g`). Commit first.
set -e

write() {
  if [ -e "$1" ]; then
    echo "skip      $1 (already exists)"
    cat > /dev/null
  else
    mkdir -p "$(dirname "$1")"
    cat > "$1"
    echo "create    $1"
  fi
}

write_force() {
  mkdir -p "$(dirname "$1")"
  if [ -e "$1" ]; then echo "overwrite $1"; else echo "create    $1"; fi
  cat > "$1"
}

# ---------- Shared schemas (API now, web forms later) ----------

write packages/shared/src/workspaces.ts <<'EOF'
import { z } from 'zod';

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

// OWNER is deliberately not assignable here: ownership transfer is a separate,
// more careful operation that does not exist yet.
export const addMemberSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['EDITOR', 'VIEWER']),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;
EOF

if ! grep -q "workspaces" packages/shared/src/index.ts; then
  echo "export * from './workspaces';" >> packages/shared/src/index.ts
  echo "append    packages/shared/src/index.ts (export workspaces)"
fi

# ---------- Roles, decorators, guard ----------

write apps/api/src/workspaces/workspace-roles.ts <<'EOF'
import type { Role } from '@flowforge/shared';

// Higher rank can do everything a lower rank can.
export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export const REQUIRED_ROLE_KEY = 'workspace:requiredRole';

// What WorkspaceAccessGuard attaches to the request for handlers to use.
export interface WorkspaceMembership {
  workspaceId: string;
  role: Role;
}
EOF

write apps/api/src/workspaces/workspace.decorators.ts <<'EOF'
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@flowforge/shared';
import { REQUIRED_ROLE_KEY, type WorkspaceMembership } from './workspace-roles';

// Minimum role for a route. Without it, any member may access the route.
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE_KEY, role);

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceMembership =>
    ctx.switchToHttp().getRequest<{ membership: WorkspaceMembership }>()
      .membership,
);
EOF

write apps/api/src/workspaces/workspace-access.guard.ts <<'EOF'
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
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: AuthUser; membership?: WorkspaceMembership }
      >();
    const workspaceId = req.params.workspaceId;

    if (!req.user || !workspaceId) {
      throw unauthorized('AUTH_UNAUTHORIZED', 'Chưa đăng nhập hoặc phiên đã hết hạn');
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
EOF

# ---------- Service, controller, module (force) ----------

write_force apps/api/src/workspaces/workspaces.service.ts <<'EOF'
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
EOF

write_force apps/api/src/workspaces/workspaces.controller.ts <<'EOF'
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
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
EOF

write_force apps/api/src/workspaces/workspaces.module.ts <<'EOF'
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkspaceAccessGuard } from './workspace-access.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  // AuthModule exports JwtModule, which JwtAuthGuard needs.
  imports: [AuthModule, PrismaModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceAccessGuard],
})
export class WorkspacesModule {}
EOF

# ---------- e2e: tenant isolation and role matrix ----------

write apps/api/test/workspaces.e2e-spec.ts <<'EOF'
import '../src/config/load-env';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';

const DOMAIN = '@flowforge.test';
const PASSWORD = 'Sup3rSecret!';

interface Actor {
  email: string;
  token: string;
}

describe('Workspaces: isolation and roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const get = (a: Actor, url: string) => request(http).get(url).set(auth(a));
  const patch = (a: Actor, url: string) => request(http).patch(url).set(auth(a));
  const post = (a: Actor, url: string) => request(http).post(url).set(auth(a));

  async function createActor(label: string): Promise<Actor> {
    const email = `${label}-${randomUUID()}${DOMAIN}`;
    await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, token: res.body.accessToken as string };
  }

  const personalWorkspaceId = async (a: Actor) =>
    (await get(a, '/api/v1/workspaces').expect(200)).body[0].id as string;

  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let dave: Actor;
  let erin: Actor;
  let aliceWs: string;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    [alice, bob, carol, dave, erin] = await Promise.all([
      createActor('alice'),
      createActor('bob'),
      createActor('carol'),
      createActor('dave'),
      createActor('erin'),
    ]);
    aliceWs = await personalWorkspaceId(alice);
    base = `/api/v1/workspaces/${aliceWs}`;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: DOMAIN } },
      select: { memberships: { select: { workspaceId: true } } },
    });
    const workspaceIds = users.flatMap((u) =>
      u.memberships.map((m) => m.workspaceId),
    );
    // Deleting a workspace cascades to memberships; deleting a user to tokens.
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  describe('tenant isolation', () => {
    it("hides another user's workspace behind 404 on every route", async () => {
      const responses = await Promise.all([
        get(bob, base),
        patch(bob, base).send({ name: 'hacked' }),
        get(bob, `${base}/members`),
        post(bob, `${base}/members`).send({ email: bob.email, role: 'VIEWER' }),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
      }

      // Nothing leaked and nothing changed.
      const after = await get(alice, base).expect(200);
      expect(after.body.name).not.toBe('hacked');
      const bobList = await get(bob, '/api/v1/workspaces').expect(200);
      expect(bobList.body.map((w: { id: string }) => w.id)).not.toContain(aliceWs);
    });

    it('answers the same for a foreign workspace and a nonexistent one', async () => {
      const foreign = await get(bob, base).expect(404);
      const missing = await get(bob, '/api/v1/workspaces/does-not-exist').expect(404);
      expect(foreign.body.code).toBe(missing.body.code);
      expect(foreign.body.message).toBe(missing.body.message);
    });

    it('requires authentication', async () => {
      await request(http).get('/api/v1/workspaces').expect(401);
      await request(http).get(base).expect(401);
      await request(http).patch(base).send({ name: 'x' }).expect(401);
    });

    it('lists only the callers own workspaces', async () => {
      const res = await get(alice, '/api/v1/workspaces').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: aliceWs, role: 'OWNER' });
    });
  });

  describe('owner actions', () => {
    it('lets the owner rename the workspace', async () => {
      const res = await patch(alice, base).send({ name: 'Alice HQ' }).expect(200);
      expect(res.body.name).toBe('Alice HQ');
      const read = await get(alice, base).expect(200);
      expect(read.body).toMatchObject({ name: 'Alice HQ', role: 'OWNER' });
    });

    it('rejects an empty name with field-level details', async () => {
      const res = await patch(alice, base).send({ name: '   ' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('roles', () => {
    beforeAll(async () => {
      await post(alice, `${base}/members`)
        .send({ email: carol.email, role: 'VIEWER' })
        .expect(201);
      await post(alice, `${base}/members`)
        .send({ email: dave.email, role: 'EDITOR' })
        .expect(201);
    });

    const cases: Array<['viewer' | 'editor', () => Actor, string]> = [
      ['viewer', () => carol, 'VIEWER'],
      ['editor', () => dave, 'EDITOR'],
    ];

    it.each(cases)(
      'a %s can read but cannot use owner-only routes',
      async (_label, actor, role) => {
        const who = actor();

        const read = await get(who, base).expect(200);
        expect(read.body.role).toBe(role);
        await get(who, `${base}/members`).expect(200);

        const rename = await patch(who, base).send({ name: 'x' }).expect(403);
        expect(rename.body.code).toBe('WORKSPACE_FORBIDDEN');
        await post(who, `${base}/members`)
          .send({ email: bob.email, role: 'VIEWER' })
          .expect(403);

        // The forbidden calls changed nothing.
        const bobList = await get(bob, '/api/v1/workspaces').expect(200);
        expect(bobList.body).toHaveLength(1);
      },
    );
  });

  describe('adding members', () => {
    it('gives the new member access with the assigned role', async () => {
      const res = await post(alice, `${base}/members`)
        .send({ email: erin.email.toUpperCase(), role: 'VIEWER' })
        .expect(201);
      expect(res.body.user.email).toBe(erin.email);

      const list = await get(erin, '/api/v1/workspaces').expect(200);
      const shared = list.body.find((w: { id: string }) => w.id === aliceWs);
      expect(shared).toMatchObject({ role: 'VIEWER' });

      const members = await get(alice, `${base}/members`).expect(200);
      expect(members.body.map((m: { user: { email: string } }) => m.user.email)).toContain(erin.email);
    });

    it('rejects a duplicate member with 409', async () => {
      const res = await post(alice, `${base}/members`)
        .send({ email: erin.email, role: 'EDITOR' })
        .expect(409);
      expect(res.body.code).toBe('WORKSPACE_MEMBER_EXISTS');
    });

    it('returns 404 for an unknown email', async () => {
      const res = await post(alice, `${base}/members`)
        .send({ email: `nobody-${randomUUID()}${DOMAIN}`, role: 'VIEWER' })
        .expect(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('cannot grant the OWNER role', async () => {
      const res = await post(alice, `${base}/members`)
        .send({ email: bob.email, role: 'OWNER' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
EOF

echo
echo "Done. Next steps are in the chat."