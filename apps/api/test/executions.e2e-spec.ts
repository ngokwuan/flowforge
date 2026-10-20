import '../src/config/load-env.config';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { ExecutionJobData } from '@flowforge/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { ExecutionsService } from '../src/executions/executions.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { EXECUTIONS_QUEUE } from '../src/queue/queue.constants';

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

const wfUrl = (ws: string, id?: string) =>
  `/api/v1/workspaces/${ws}/workflows${id ? `/${id}` : ''}`;
const runUrl = (ws: string, wf: string) => `${wfUrl(ws, wf)}/executions`;
const execUrl = (ws: string, id: string) =>
  `/api/v1/workspaces/${ws}/executions/${id}`;

describe('Executions and queue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue<ExecutionJobData>;
  let executions: ExecutionsService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const get = (a: Actor, url: string) => request(http).get(url).set(auth(a));
  const post = (a: Actor, url: string) => request(http).post(url).set(auth(a));
  const patch = (a: Actor, url: string) =>
    request(http).patch(url).set(auth(a));

  const run = (
    a: Actor,
    ws: string,
    wf: string,
    body: object = {},
    key?: string,
  ) => {
    const req = post(a, runUrl(ws, wf));
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };

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

  const createWorkflow = (a: Actor, ws: string, name: string) =>
    post(a, wfUrl(ws))
      .send({ name, definition: validDefinition() })
      .expect(201);

  let alice: Actor; // owner of aliceWs
  let bob: Actor; // different tenant
  let carol: Actor; // VIEWER in aliceWs
  let aliceWs: string;
  let bobWs: string;
  let flowId: string; // a workflow in aliceWs that no test edits

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    queue = app.get<Queue<ExecutionJobData>>(EXECUTIONS_QUEUE);
    executions = app.get(ExecutionsService);
    http = app.getHttpServer();

    [alice, bob, carol] = await Promise.all([
      createActor('alice'),
      createActor('bob'),
      createActor('carol'),
    ]);
    [aliceWs, bobWs] = await Promise.all([
      personalWorkspaceId(alice),
      personalWorkspaceId(bob),
    ]);
    await post(alice, `/api/v1/workspaces/${aliceWs}/members`)
      .send({ email: carol.email, role: 'VIEWER' })
      .expect(201);
    flowId = (await createWorkflow(alice, aliceWs, 'Runnable')).body.id;
  });

  afterAll(async () => {
    // Tests use their own key prefix in Redis, so wiping the queue is safe.
    await queue.obliterate({ force: true });

    const users = await prisma.user.findMany({
      where: { email: { endsWith: DOMAIN } },
      select: { memberships: { select: { workspaceId: true } } },
    });
    const workspaceIds = users.flatMap((u) =>
      u.memberships.map((m) => m.workspaceId),
    );
    // Cascades to workflows, executions and steps.
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  it('creates a QUEUED execution and publishes a job with the same id', async () => {
    const res = await run(alice, aliceWs, flowId).expect(202);

    expect(res.body).toMatchObject({
      workflowId: flowId,
      workflowVersion: 1,
      status: 'QUEUED',
      trigger: 'MANUAL',
    });
    const job = await queue.getJob(res.body.id);
    expect(job?.data).toEqual({
      executionId: res.body.id,
      workspaceId: aliceWs,
    });
  });

  it('snapshots the definition, so later edits do not change the run', async () => {
    const created = await createWorkflow(alice, aliceWs, 'Snapshot');
    const id = created.body.id;
    const exec = await run(alice, aliceWs, id).expect(202);

    const changed = validDefinition();
    changed.nodes.push({
      id: 'extra',
      type: 'http.request',
      name: 'Extra',
      config: {},
    });
    changed.edges.push({ id: 'e2', source: 'call', target: 'extra' });
    await patch(alice, wfUrl(aliceWs, id))
      .send({ version: 1, definition: changed })
      .expect(200);

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: exec.body.id },
    });
    expect(row.workflowVersion).toBe(1);
    expect(row.definition).toEqual(created.body.definition);
  });

  it('stores the input', async () => {
    const res = await run(alice, aliceWs, flowId, {
      input: { orderId: 42 },
    }).expect(202);
    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.input).toEqual({ orderId: 42 });
  });

  it('returns the same execution for a repeated Idempotency-Key', async () => {
    const key = randomUUID();
    const first = await run(alice, aliceWs, flowId, {}, key).expect(202);
    const second = await run(alice, aliceWs, flowId, {}, key).expect(202);

    expect(second.body.id).toBe(first.body.id);
    expect(
      await prisma.execution.count({
        where: { workflowId: flowId, idempotencyKey: key },
      }),
    ).toBe(1);

    const other = await run(alice, aliceWs, flowId, {}, randomUUID()).expect(
      202,
    );
    expect(other.body.id).not.toBe(first.body.id);
  });

  it('creates exactly one execution when the same key arrives concurrently', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => run(alice, aliceWs, flowId, {}, key)),
    );

    for (const res of results) expect(res.status).toBe(202);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(
      await prisma.execution.count({
        where: { workflowId: flowId, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('creates a new execution each time when no key is sent', async () => {
    const a = await run(alice, aliceWs, flowId).expect(202);
    const b = await run(alice, aliceWs, flowId).expect(202);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('enforces roles and authentication', async () => {
    const viewer = await run(carol, aliceWs, flowId).expect(403);
    expect(viewer.body.code).toBe('WORKSPACE_FORBIDDEN');

    const outsider = await run(bob, aliceWs, flowId).expect(404);
    expect(outsider.body.code).toBe('WORKSPACE_NOT_FOUND');

    await request(http).post(runUrl(aliceWs, flowId)).send({}).expect(401);
  });

  it('does not run a workflow that belongs to another workspace', async () => {
    const missing = await run(alice, aliceWs, 'does-not-exist').expect(404);
    expect(missing.body.code).toBe('WORKFLOW_NOT_FOUND');

    // Bob names his own workspace but Alice's workflow id.
    const cross = await run(bob, bobWs, flowId).expect(404);
    expect(cross.body.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('rejects an oversized idempotency key and a malformed body', async () => {
    const longKey = 'k'.repeat(201);
    const key = await run(alice, aliceWs, flowId, {}, longKey).expect(400);
    expect(key.body.code).toBe('VALIDATION_ERROR');

    await post(alice, runUrl(aliceWs, flowId))
      .send({ input: [1, 2] })
      .expect(400);
  });

  it('lets members read an execution and its steps', async () => {
    const exec = await run(alice, aliceWs, flowId).expect(202);

    const own = await get(alice, execUrl(aliceWs, exec.body.id)).expect(200);
    expect(own.body).toMatchObject({
      id: exec.body.id,
      status: 'QUEUED',
      steps: [],
    });
    await get(carol, execUrl(aliceWs, exec.body.id)).expect(200);
  });

  it('hides executions from other workspaces', async () => {
    const exec = await run(alice, aliceWs, flowId).expect(202);

    const outsider = await get(bob, execUrl(aliceWs, exec.body.id)).expect(404);
    expect(outsider.body.code).toBe('WORKSPACE_NOT_FOUND');

    const cross = await get(bob, execUrl(bobWs, exec.body.id)).expect(404);
    expect(cross.body.code).toBe('EXECUTION_NOT_FOUND');
  });

  it('republishes a QUEUED execution whose job was lost', async () => {
    const wf = await prisma.workflow.findUniqueOrThrow({
      where: { id: flowId },
    });
    // Simulates a crash between the database insert and the queue publish.
    const lost = await prisma.execution.create({
      data: {
        workspaceId: aliceWs,
        workflowId: flowId,
        workflowVersion: wf.version,
        definition: wf.definition as object,
        trigger: 'MANUAL',
        queuedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    expect(await queue.getJob(lost.id)).toBeUndefined();

    const published = await executions.republishStaleQueued(5 * 60 * 1000);
    expect(published).toBeGreaterThanOrEqual(1);

    const job = await queue.getJob(lost.id);
    expect(job?.data).toEqual({ executionId: lost.id, workspaceId: aliceWs });
  });
});
