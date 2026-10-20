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

const validDefinition = () => ({
  nodes: [
    { id: 'trigger', type: 'trigger.manual', name: 'Start' },
    {
      id: 'call',
      type: 'http.request',
      name: 'Call API',
      config: { url: 'https://example.com' },
    },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
});

const wfUrl = (workspaceId: string, workflowId?: string) =>
  `/api/v1/workspaces/${workspaceId}/workflows${workflowId ? `/${workflowId}` : ''}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Workflows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const get = (a: Actor, url: string) => request(http).get(url).set(auth(a));
  const post = (a: Actor, url: string) => request(http).post(url).set(auth(a));
  const patch = (a: Actor, url: string) =>
    request(http).patch(url).set(auth(a));
  const del = (a: Actor, url: string) => request(http).delete(url).set(auth(a));

  const createWorkflow = (
    a: Actor,
    workspaceId: string,
    name = 'Flow',
    definition: unknown = validDefinition(),
  ) => post(a, wfUrl(workspaceId)).send({ name, definition });

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

  let alice: Actor; // owns aliceWs
  let bob: Actor; // different tenant
  let carol: Actor; // VIEWER in aliceWs
  let dave: Actor; // EDITOR in aliceWs
  let frank: Actor; // owns frankWs, used for list and pagination
  let aliceWs: string;
  let bobWs: string;
  let frankWs: string;
  let seededId: string; // a workflow in aliceWs that no test modifies

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    [alice, bob, carol, dave, frank] = await Promise.all([
      createActor('alice'),
      createActor('bob'),
      createActor('carol'),
      createActor('dave'),
      createActor('frank'),
    ]);
    [aliceWs, bobWs, frankWs] = await Promise.all([
      personalWorkspaceId(alice),
      personalWorkspaceId(bob),
      personalWorkspaceId(frank),
    ]);

    await post(alice, `/api/v1/workspaces/${aliceWs}/members`)
      .send({ email: carol.email, role: 'VIEWER' })
      .expect(201);
    await post(alice, `/api/v1/workspaces/${aliceWs}/members`)
      .send({ email: dave.email, role: 'EDITOR' })
      .expect(201);

    const seeded = await createWorkflow(alice, aliceWs, 'Seeded').expect(201);
    seededId = seeded.body.id;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: DOMAIN } },
      select: { memberships: { select: { workspaceId: true } } },
    });
    const workspaceIds = users.flatMap((u) =>
      u.memberships.map((m) => m.workspaceId),
    );
    // Deleting a workspace cascades to its workflows and memberships.
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  describe('create and read', () => {
    it('creates a workflow and applies defaults to the definition', async () => {
      const res = await createWorkflow(alice, aliceWs, 'My flow').expect(201);

      expect(res.body).toMatchObject({
        name: 'My flow',
        version: 1,
        isActive: false,
      });
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.definition.nodes[0].position).toEqual({ x: 0, y: 0 });
      expect(res.body.definition.nodes[0].config).toEqual({});

      const read = await get(alice, wfUrl(aliceWs, res.body.id)).expect(200);
      expect(read.body.definition).toEqual(res.body.definition);
    });

    it('rejects a workflow whose graph has a cycle', async () => {
      const cyclic = {
        nodes: [
          { id: 't', type: 'trigger.manual', name: 'Start' },
          { id: 'a', type: 'http.request', name: 'A' },
          { id: 'b', type: 'http.request', name: 'B' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 'a', target: 'b' },
          { id: 'e3', source: 'b', target: 'a' },
        ],
      };
      const res = await createWorkflow(alice, aliceWs, 'Cyclic', cyclic).expect(
        400,
      );
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.details)).toContain('vòng lặp');
    });

    it('rejects a workflow without a trigger', async () => {
      const noTrigger = {
        nodes: [{ id: 'a', type: 'http.request', name: 'A' }],
        edges: [],
      };
      const res = await createWorkflow(
        alice,
        aliceWs,
        'No trigger',
        noTrigger,
      ).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.details)).toContain('trigger');
    });

    it('lists summaries newest first and paginates with a cursor', async () => {
      for (const name of ['F1', 'F2', 'F3']) {
        await createWorkflow(frank, frankWs, name).expect(201);
        await sleep(15); // distinct timestamps keep the order unambiguous
      }

      const all = await get(frank, wfUrl(frankWs)).expect(200);
      expect(all.body.items.map((w: { name: string }) => w.name)).toEqual([
        'F3',
        'F2',
        'F1',
      ]);
      expect(all.body.items[0]).not.toHaveProperty('definition');
      expect(all.body.nextCursor).toBeNull();

      const page1 = await get(frank, `${wfUrl(frankWs)}?limit=2`).expect(200);
      expect(page1.body.items.map((w: { name: string }) => w.name)).toEqual([
        'F3',
        'F2',
      ]);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await get(
        frank,
        `${wfUrl(frankWs)}?limit=2&cursor=${page1.body.nextCursor}`,
      ).expect(200);
      expect(page2.body.items.map((w: { name: string }) => w.name)).toEqual([
        'F1',
      ]);
      expect(page2.body.nextCursor).toBeNull();

      await get(frank, `${wfUrl(frankWs)}?limit=0`).expect(400);
    });

    it('requires authentication', async () => {
      await request(http).get(wfUrl(aliceWs)).expect(401);
      await request(http).post(wfUrl(aliceWs)).send({}).expect(401);
    });
  });

  describe('roles', () => {
    it('a viewer can read but cannot create, update or delete', async () => {
      await get(carol, wfUrl(aliceWs)).expect(200);
      await get(carol, wfUrl(aliceWs, seededId)).expect(200);

      const attempts = [
        await createWorkflow(carol, aliceWs, 'Nope'),
        await patch(carol, wfUrl(aliceWs, seededId)).send({
          version: 1,
          name: 'x',
        }),
        await del(carol, wfUrl(aliceWs, seededId)),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_FORBIDDEN');
      }

      const unchanged = await get(alice, wfUrl(aliceWs, seededId)).expect(200);
      expect(unchanged.body).toMatchObject({ name: 'Seeded', version: 1 });
    });

    it('an editor can create and edit but cannot delete', async () => {
      const created = await createWorkflow(dave, aliceWs, 'By Dave').expect(
        201,
      );
      const id = created.body.id;

      await patch(dave, wfUrl(aliceWs, id))
        .send({ version: 1, name: 'By Dave v2' })
        .expect(200);

      const res = await del(dave, wfUrl(aliceWs, id)).expect(403);
      expect(res.body.code).toBe('WORKSPACE_FORBIDDEN');
      await get(alice, wfUrl(aliceWs, id)).expect(200);
    });
  });

  describe('tenant isolation', () => {
    it('hides every workflow route of a foreign workspace behind 404', async () => {
      const responses = await Promise.all([
        get(bob, wfUrl(aliceWs)),
        createWorkflow(bob, aliceWs, 'Intruder'),
        get(bob, wfUrl(aliceWs, seededId)),
        patch(bob, wfUrl(aliceWs, seededId)).send({ version: 1, name: 'x' }),
        del(bob, wfUrl(aliceWs, seededId)),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
      }
    });

    it('does not let a workflow id reach across workspaces', async () => {
      const bobFlow = await createWorkflow(bob, bobWs, 'Bobs').expect(201);

      // Alice asks her own workspace for Bob's workflow id.
      const a = await get(alice, wfUrl(aliceWs, bobFlow.body.id)).expect(404);
      expect(a.body.code).toBe('WORKFLOW_NOT_FOUND');

      // Bob uses his own workspace path with Alice's workflow id.
      const read = await get(bob, wfUrl(bobWs, seededId)).expect(404);
      expect(read.body.code).toBe('WORKFLOW_NOT_FOUND');
      await patch(bob, wfUrl(bobWs, seededId))
        .send({ version: 1, name: 'x' })
        .expect(404);
      await del(bob, wfUrl(bobWs, seededId)).expect(404);

      const unchanged = await get(alice, wfUrl(aliceWs, seededId)).expect(200);
      expect(unchanged.body).toMatchObject({ name: 'Seeded', version: 1 });
    });
  });

  describe('optimistic locking', () => {
    it('applies an update at the current version and bumps it', async () => {
      const created = await createWorkflow(alice, aliceWs, 'Lock A').expect(
        201,
      );
      const url = wfUrl(aliceWs, created.body.id);

      const first = await patch(alice, url)
        .send({ version: 1, name: 'Lock A v2' })
        .expect(200);
      expect(first.body).toMatchObject({ name: 'Lock A v2', version: 2 });
      expect(first.body.definition).toEqual(created.body.definition);

      const second = await patch(alice, url)
        .send({ version: 2, description: 'now described' })
        .expect(200);
      expect(second.body).toMatchObject({
        version: 3,
        description: 'now described',
      });
    });

    it('rejects a stale version with 409 and reports the current one', async () => {
      const created = await createWorkflow(alice, aliceWs, 'Lock B').expect(
        201,
      );
      const url = wfUrl(aliceWs, created.body.id);
      await patch(alice, url).send({ version: 1, name: 'first' }).expect(200);

      const stale = await patch(alice, url)
        .send({ version: 1, name: 'second' })
        .expect(409);
      expect(stale.body.code).toBe('WORKFLOW_VERSION_CONFLICT');
      expect(stale.body.details).toEqual({ currentVersion: 2 });

      const current = await get(alice, url).expect(200);
      expect(current.body.name).toBe('first');
    });

    it('lets only one of two concurrent updates with the same version win', async () => {
      const created = await createWorkflow(alice, aliceWs, 'Lock C').expect(
        201,
      );
      const url = wfUrl(aliceWs, created.body.id);

      const results = await Promise.all([
        patch(alice, url).send({ version: 1, name: 'A' }),
        patch(alice, url).send({ version: 1, name: 'B' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

      const current = await get(alice, url).expect(200);
      expect(current.body.version).toBe(2);
    });

    it('rejects an invalid definition and leaves the workflow untouched', async () => {
      const created = await createWorkflow(alice, aliceWs, 'Lock D').expect(
        201,
      );
      const url = wfUrl(aliceWs, created.body.id);

      const res = await patch(alice, url)
        .send({
          version: 1,
          definition: {
            nodes: [{ id: 'a', type: 'http.request', name: 'A' }],
            edges: [],
          },
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      const current = await get(alice, url).expect(200);
      expect(current.body.version).toBe(1);
      expect(current.body.definition).toEqual(created.body.definition);
    });

    it('rejects an update that changes nothing', async () => {
      const res = await patch(alice, wfUrl(aliceWs, seededId))
        .send({ version: 1 })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when updating a workflow that does not exist', async () => {
      const res = await patch(alice, wfUrl(aliceWs, 'does-not-exist'))
        .send({ version: 1, name: 'x' })
        .expect(404);
      expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
    });
  });

  describe('delete', () => {
    it('lets the owner delete a workflow', async () => {
      const created = await createWorkflow(alice, aliceWs, 'To delete').expect(
        201,
      );
      const url = wfUrl(aliceWs, created.body.id);

      await del(alice, url).expect(204);
      const res = await get(alice, url).expect(404);
      expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
    });
  });
});
