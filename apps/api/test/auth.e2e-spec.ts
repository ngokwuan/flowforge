import '../src/config/load-env.config';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { PrismaService } from '../src/prisma/prisma.service';

const DOMAIN = '@flowforge.test';
const URL = '/api/v1/auth/register';
const uniqueEmail = () => `user-${randomUUID()}${DOMAIN}`;

describe('POST /auth/register (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Remove only what this suite created (matched by the test domain).
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

  it('creates the user and never returns the password hash', async () => {
    const email = uniqueEmail();
    const res = await request(app.getHttpServer())
      .post(URL)
      .send({ email, password: 'Sup3rSecret!', name: 'Nguyễn Ngọc' })
      .expect(201);

    expect(res.body).toMatchObject({ email, name: 'Nguyễn Ngọc' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('password');
  });

  it('stores an argon2id hash and a personal workspace owned by the user', async () => {
    const email = uniqueEmail();
    await request(app.getHttpServer())
      .post(URL)
      .send({ email, password: 'Sup3rSecret!', name: 'Nguyễn Ngọc' })
      .expect(201);

    const row = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { memberships: { include: { workspace: true } } },
    });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain('Sup3rSecret!');
    expect(row.memberships).toHaveLength(1);
    expect(row.memberships[0].role).toBe('OWNER');
    expect(row.memberships[0].workspace.slug).toMatch(
      /^nguyen-ngoc-[0-9a-f]{6}$/,
    );
  });

  it('rejects a duplicate email, ignoring letter case', async () => {
    const email = uniqueEmail();
    const body = { password: 'Sup3rSecret!', name: 'A' };
    await request(app.getHttpServer())
      .post(URL)
      .send({ ...body, email })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(URL)
      .send({ ...body, email: email.toUpperCase() })
      .expect(409);
    expect(res.body.code).toBe('USER_EMAIL_TAKEN');
  });

  it('rejects invalid input with field-level details', async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .send({ email: 'not-an-email', password: '123', name: '' })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining(['email', 'password', 'name']),
    );
  });
});
