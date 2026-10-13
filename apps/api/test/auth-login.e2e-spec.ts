import '../src/config/load-env';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { PrismaService } from '../src/prisma/prisma.service';

const DOMAIN = '@flowforge.test';
const PASSWORD = 'Sup3rSecret!';
const uniqueEmail = () => `login-${randomUUID()}${DOMAIN}`;

function refreshCookie(res: request.Response): { raw: string; value: string } {
  const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = cookies.find((c) => c.startsWith('refresh_token='));
  if (!raw) throw new Error('refresh_token cookie was not set');
  return { raw, value: raw.split(';')[0].split('=')[1] };
}

describe('Login, refresh, logout, me (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
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
    // Refresh tokens are removed by the cascade on User.
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  async function createUser() {
    const email = uniqueEmail();
    await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Test User' })
      .expect(201);
    return email;
  }

  async function login(email: string) {
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { res, cookie: refreshCookie(res) };
  }

  const refreshWith = (value: string) =>
    request(http).post('/api/v1/auth/refresh').set('Cookie', `refresh_token=${value}`);

  describe('login', () => {
    it('returns an access token and sets an httpOnly refresh cookie', async () => {
      const email = await createUser();
      const { res, cookie } = await login(email);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({ email });
      expect(JSON.stringify(res.body)).not.toContain(cookie.value);
      expect(cookie.raw).toMatch(/HttpOnly/i);
      expect(cookie.raw).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('stores only a hash of the refresh token', async () => {
      const email = await createUser();
      const { cookie } = await login(email);

      const rows = await prisma.refreshToken.findMany({
        where: { user: { email } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).not.toBe(cookie.value);
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gives the same error for a wrong password and an unknown email', async () => {
      const email = await createUser();
      const wrongPassword = await request(http)
        .post('/api/v1/auth/login')
        .send({ email, password: 'not-the-password' })
        .expect(401);
      const unknownEmail = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current user with a valid access token', async () => {
      const email = await createUser();
      const { res } = await login(email);

      const me = await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body.email).toBe(email);
      expect(me.body).not.toHaveProperty('passwordHash');
    });

    it('rejects a missing or garbage token with 401', async () => {
      await request(http).get('/api/v1/auth/me').expect(401);
      const res = await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.token')
        .expect(401);
      expect(res.body.code).toBe('AUTH_UNAUTHORIZED');
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new token each time and returns a working access token', async () => {
      const email = await createUser();
      const { cookie } = await login(email);

      const res = await refreshWith(cookie.value).expect(200);
      const next = refreshCookie(res);
      expect(next.value).not.toBe(cookie.value);

      await request(http)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('treats reuse of an old token as theft and revokes the whole family', async () => {
      const email = await createUser();
      const { cookie: first } = await login(email);
      const second = refreshCookie(await refreshWith(first.value).expect(200));

      const reuse = await refreshWith(first.value).expect(401);
      expect(reuse.body.code).toBe('AUTH_REFRESH_REUSED');

      // The legitimate newest token is revoked too.
      await refreshWith(second.value).expect(401);
    });

    it('lets only one of two concurrent refreshes succeed', async () => {
      const email = await createUser();
      const { cookie } = await login(email);

      const results = await Promise.all([
        refreshWith(cookie.value),
        refreshWith(cookie.value),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('rejects a missing or unknown token', async () => {
      const missing = await request(http).post('/api/v1/auth/refresh').expect(401);
      expect(missing.body.code).toBe('AUTH_REFRESH_MISSING');
      const unknown = await refreshWith('definitely-not-a-token').expect(401);
      expect(unknown.body.code).toBe('AUTH_REFRESH_INVALID');
    });
  });

  describe('logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const email = await createUser();
      const { cookie } = await login(email);

      const res = await request(http)
        .post('/api/v1/auth/logout')
        .set('Cookie', `refresh_token=${cookie.value}`)
        .expect(204);
      expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(
        /refresh_token=;/,
      );

      await refreshWith(cookie.value).expect(401);
    });

    it('is idempotent without a cookie', async () => {
      await request(http).post('/api/v1/auth/logout').expect(204);
    });
  });
});
