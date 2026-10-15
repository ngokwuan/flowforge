import '../src/config/load-env.config';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { PrismaService } from '../src/prisma/prisma.service';

const DOMAIN = `@${randomUUID()}.flowforge.test`;
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
  const patch = (a: Actor, url: string) =>
    request(http).patch(url).set(auth(a));
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
      expect(bobList.body.map((w: { id: string }) => w.id)).not.toContain(
        aliceWs,
      );
    });

    it('answers the same for a foreign workspace and a nonexistent one', async () => {
      const foreign = await get(bob, base).expect(404);
      const missing = await get(
        bob,
        '/api/v1/workspaces/does-not-exist',
      ).expect(404);
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
      const res = await patch(alice, base)
        .send({ name: 'Alice HQ' })
        .expect(200);
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
      expect(
        members.body.map((m: { user: { email: string } }) => m.user.email),
      ).toContain(erin.email);
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
