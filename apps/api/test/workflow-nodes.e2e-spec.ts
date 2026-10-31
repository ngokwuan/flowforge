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

interface TestNode {
  id: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
}

const trigger: TestNode = {
  id: 'trigger',
  type: 'trigger.manual',
  name: 'Start',
};

// trigger -> n1 -> n2 -> ... as a simple chain.
const chain = (...nodes: TestNode[]) => ({
  nodes: [trigger, ...nodes],
  edges: nodes.map((node, i) => ({
    id: `e${i}`,
    source: i === 0 ? trigger.id : nodes[i - 1].id,
    target: node.id,
  })),
});

const http = (config?: Record<string, unknown>): TestNode => ({
  id: 'call',
  type: 'http.request',
  name: 'Call',
  config,
});

const wfUrl = (ws: string, id?: string) =>
  `/api/v1/workspaces/${ws}/workflows${id ? `/${id}` : ''}`;

describe('Node validation on workflows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let alice: Actor;
  let aliceWs: string;

  const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const create = (definition: unknown) =>
    request(server)
      .post(wfUrl(aliceWs))
      .set(auth(alice))
      .send({ name: 'Flow', definition });
  const paths = (res: request.Response) =>
    (res.body.details as Array<{ path: string }>).map((d) => d.path);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    const email = `alice-${randomUUID()}${DOMAIN}`;
    await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'alice' })
      .expect(201);
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    alice = { email, token: login.body.accessToken as string };
    const list = await request(server)
      .get('/api/v1/workspaces')
      .set(auth(alice))
      .expect(200);
    aliceWs = list.body[0].id as string;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: DOMAIN } },
      select: { memberships: { select: { workspaceId: true } } },
    });
    const workspaceIds = users.flatMap((u) =>
      u.memberships.map((m) => m.workspaceId),
    );
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  it('rejects an unknown node type and points at it', async () => {
    const res = await create(
      chain({ id: 'x', type: 'does.not.exist', name: 'X' }),
    ).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(paths(res)).toContain('nodes.1.type');
  });

  it('rejects an http.request node without a url', async () => {
    const res = await create(chain(http({}))).expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');
  });

  it.each([
    'file:///etc/passwd',
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:8080/admin',
    'http://[::1]/',
    'http://user:secret@example.com/',
  ])('rejects the url %s at save time', async (url) => {
    const res = await create(chain(http({ url }))).expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');
  });

  it('accepts a templated url, which is only known at run time', async () => {
    const url = '{{ steps.trigger.output.url }}';
    const res = await create(chain(http({ url }))).expect(201);
    expect(res.body.definition.nodes[1].config.url).toBe(url);
  });

  it('stores node defaults explicitly', async () => {
    const res = await create(
      chain(http({ url: 'https://example.com/api' })),
    ).expect(201);
    expect(res.body.definition.nodes[1].config).toEqual({
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
      timeoutMs: 10000,
      maxResponseBytes: 1048576,
      failOnError: true,
    });
  });

  it('validates the If / Else node config', async () => {
    const bad = await create(
      chain({
        id: 'check',
        type: 'logic.if',
        name: 'Check',
        config: { left: 1, operator: 'equals' },
      }),
    ).expect(400);
    expect(paths(bad)).toContain('nodes.1.config.right');

    await create(
      chain({
        id: 'check',
        type: 'logic.if',
        name: 'Check',
        config: { left: 1, operator: 'equals', right: 1 },
      }),
    ).expect(201);
  });

  it('reports the problems of several nodes in one response', async () => {
    const res = await create({
      nodes: [
        trigger,
        { id: 'a', type: 'http.request', name: 'A', config: {} },
        { id: 'b', type: 'nope.nope', name: 'B', config: {} },
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'a' },
        { id: 'e1', source: 'a', target: 'b' },
      ],
    }).expect(400);
    expect(paths(res)).toEqual(
      expect.arrayContaining(['nodes.1.config.url', 'nodes.2.type']),
    );
  });

  it('applies the same validation on update and leaves the workflow untouched', async () => {
    const created = await create(
      chain(http({ url: 'https://example.com/ok' })),
    ).expect(201);
    const url = wfUrl(aliceWs, created.body.id);

    const res = await request(server)
      .patch(url)
      .set(auth(alice))
      .send({
        version: 1,
        definition: chain(http({ url: 'http://10.0.0.1/' })),
      })
      .expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');

    const current = await request(server).get(url).set(auth(alice)).expect(200);
    expect(current.body.version).toBe(1);
    expect(current.body.definition.nodes[1].config.url).toBe(
      'https://example.com/ok',
    );
  });

  describe('GET /node-types', () => {
    it('requires authentication', async () => {
      await request(server).get('/api/v1/node-types').expect(401);
    });

    it('lists every node type with a JSON Schema for its config', async () => {
      const res = await request(server)
        .get('/api/v1/node-types')
        .set(auth(alice))
        .expect(200);

      const types = (res.body as Array<{ type: string }>).map((t) => t.type);
      expect(types).toEqual(
        expect.arrayContaining(['trigger.manual', 'logic.if', 'http.request']),
      );
      for (const node of res.body as Array<{
        configSchema: { type: string };
      }>) {
        expect(node.configSchema.type).toBe('object');
      }
    });
  });
});
