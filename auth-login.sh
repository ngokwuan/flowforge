#!/usr/bin/env bash
# FlowForge: login, refresh-token rotation, logout, /auth/me.
# Run from the repo root:  bash auth-login.sh
# NEW files are skipped if they exist. Files marked "force" are OVERWRITTEN
# (auth/users files created by the previous scripts). Commit first.
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

# ---------- Small shared pieces ----------

write apps/api/src/auth/auth.constants.ts <<'EOF'
export const REFRESH_COOKIE = 'refresh_token';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
EOF

write apps/api/src/auth/auth.errors.ts <<'EOF'
import { UnauthorizedException } from '@nestjs/common';

export const unauthorized = (code: string, message: string) =>
  new UnauthorizedException({ code, message });
EOF

write apps/api/src/common/decorators/current-user.decorator.ts <<'EOF'
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  email: string;
}

// Reads the user that JwtAuthGuard attached to the request.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
EOF

write apps/api/src/common/guards/jwt-auth.guard.ts <<'EOF'
import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { unauthorized } from '../../auth/auth.errors';
import type { Env } from '../../config/env';
import type { AuthUser } from '../decorators/current-user.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();

    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    const fail = () =>
      unauthorized('AUTH_UNAUTHORIZED', 'Chưa đăng nhập hoặc phiên đã hết hạn');
    if (type !== 'Bearer' || !token) throw fail();

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(
        token,
        {
          secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
          algorithms: ['HS256'], // pin the algorithm, never trust the token header
        },
      );
      req.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw fail();
    }
  }
}
EOF

# ---------- Users service (force): adds two lookups ----------

write_force apps/api/src/users/users.service.ts <<'EOF'
import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { slugify } from '../common/utils/slugify';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // Creates the user together with a personal workspace they own.
  // Prisma runs nested writes in one transaction, so a user can never exist
  // without their workspace and membership.
  async createWithPersonalWorkspace(input: CreateUserInput) {
    // Random suffix keeps the slug unique; a collision is ~1 in 16 million.
    const slug = `${slugify(input.name)}-${randomBytes(3).toString('hex')}`;

    try {
      return await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          memberships: {
            create: {
              role: 'OWNER',
              workspace: {
                create: { name: `Workspace của ${input.name}`, slug },
              },
            },
          },
        },
        // Never select passwordHash for a response.
        select: { id: true, email: true, name: true, createdAt: true },
      });
    } catch (error) {
      // Rely on the unique constraint instead of "check, then insert":
      // two concurrent requests can both pass a check, but not the constraint.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'USER_EMAIL_TAKEN',
          message: 'Email đã được sử dụng',
        });
      }
      throw error;
    }
  }

  // Only for the login flow: includes the hash. Never return this to a client.
  findForLogin(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, passwordHash: true },
    });
  }

  findPublicById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, createdAt: true },
    });
  }
}
EOF

# ---------- Auth service (force) ----------

write_force apps/api/src/auth/auth.service.ts <<'EOF'
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import type { LoginInput, RegisterInput } from '@flowforge/shared';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import { unauthorized } from './auth.errors';

// argon2id with the OWASP minimum parameters (19 MiB memory, 2 iterations).
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

interface TokenUser {
  id: string;
  email: string;
}

@Injectable()
export class AuthService {
  // Verified against when the email does not exist, so a miss costs the same
  // time as a wrong password and response time does not reveal which emails exist.
  private readonly dummyHash = hash('flowforge-dummy-password', ARGON2_OPTIONS);

  constructor(
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(input: RegisterInput) {
    // Normalize so "A@x.com" and "a@x.com" cannot become two accounts.
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hash(input.password, ARGON2_OPTIONS);

    return this.users.createWithPersonalWorkspace({
      email,
      name: input.name,
      passwordHash,
    });
  }

  async login(input: LoginInput) {
    const email = input.email.trim().toLowerCase();
    const user = await this.users.findForLogin(email);

    // Always run exactly one verification, whether or not the user exists.
    const valid = await verify(
      user?.passwordHash ?? (await this.dummyHash),
      input.password,
    );
    if (!user || !user.passwordHash || !valid) {
      // Same answer for "unknown email" and "wrong password".
      throw unauthorized(
        'AUTH_INVALID_CREDENTIALS',
        'Email hoặc mật khẩu không đúng',
      );
    }

    // A login starts a new "family": every token rotated from this one shares it.
    const familyId = randomUUID();
    const refreshToken = await this.createRefreshToken(
      this.prisma,
      user.id,
      familyId,
    );
    const accessToken = await this.signAccessToken(user);

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  async refresh(rawToken: string | undefined) {
    if (!rawToken) {
      throw unauthorized('AUTH_REFRESH_MISSING', 'Thiếu phiên đăng nhập');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashRefreshToken(rawToken) },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!stored) {
      throw unauthorized('AUTH_REFRESH_INVALID', 'Phiên đăng nhập không hợp lệ');
    }
    if (stored.expiresAt <= new Date()) {
      throw unauthorized(
        'AUTH_REFRESH_EXPIRED',
        'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại',
      );
    }

    // Rotation. The conditional update is a compare-and-set: only ONE of several
    // concurrent requests can flip revokedAt from null, so a token is used once.
    const nextToken = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) return null;
      return this.createRefreshToken(tx, stored.userId, stored.familyId);
    });

    if (!nextToken) {
      // The token was already used. Either a client bug or a stolen token:
      // end the whole session family so neither party keeps access.
      await this.revokeFamily(stored.familyId);
      throw unauthorized(
        'AUTH_REFRESH_REUSED',
        'Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại',
      );
    }

    return {
      accessToken: await this.signAccessToken(stored.user),
      refreshToken: nextToken,
    };
  }

  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashRefreshToken(rawToken) },
      select: { familyId: true },
    });
    if (stored) await this.revokeFamily(stored.familyId);
  }

  async me(userId: string) {
    const user = await this.users.findPublicById(userId);
    if (!user) {
      throw unauthorized('AUTH_UNAUTHORIZED', 'Chưa đăng nhập hoặc phiên đã hết hạn');
    }
    return user;
  }

  private signAccessToken(user: TokenUser) {
    return this.jwt.signAsync(
      { sub: user.id, email: user.email },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        algorithm: 'HS256',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    );
  }

  // The refresh token is random, not a JWT. Only its keyed hash is stored, so a
  // database leak does not hand out usable tokens. HMAC-SHA256 is enough here
  // because the token already has 256 bits of entropy (no need for argon2).
  private hashRefreshToken(token: string) {
    return createHmac('sha256', this.config.get('JWT_REFRESH_SECRET', { infer: true }))
      .update(token)
      .digest('hex');
  }

  private async createRefreshToken(
    db: Pick<PrismaService, 'refreshToken'>,
    userId: string,
    familyId: string,
  ) {
    const token = randomBytes(32).toString('base64url');
    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: this.hashRefreshToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return token;
  }

  private revokeFamily(familyId: string) {
    return this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
EOF

# ---------- Auth controller (force) ----------

write_force apps/api/src/auth/auth.controller.ts <<'EOF'
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@flowforge/shared';
import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../config/env';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { REFRESH_COOKIE, REFRESH_TOKEN_TTL_MS } from './auth.constants';
import { AuthService } from './auth.service';

const COOKIE_PATH = '/api/v1/auth';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // POST returns 201 Created by default.
  @Post('register')
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
  ) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.auth.login(body);
    res.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions());
    // The refresh token travels only in the httpOnly cookie, never in the body.
    return { accessToken, user };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.auth.refresh(
      this.readRefreshCookie(req),
    );
    res.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions());
    return { accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(this.readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    return cookies?.[REFRESH_COOKIE];
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true, // JavaScript in the page cannot read it, which limits XSS damage
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'lax',
      path: COOKIE_PATH, // the browser sends it only to auth endpoints
      maxAge: REFRESH_TOKEN_TTL_MS,
    };
  }
}
EOF

# ---------- Auth module (force) ----------

write_force apps/api/src/auth/auth.module.ts <<'EOF'
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  // Secrets are passed per call from validated config, so no global secret here.
  imports: [UsersModule, PrismaModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService],
  // Other modules that use JwtAuthGuard import AuthModule to get JwtService.
  exports: [JwtModule],
})
export class AuthModule {}
EOF

# ---------- e2e test ----------

write apps/api/test/auth-login.e2e-spec.ts <<'EOF'
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
EOF

echo
echo "Done. Next steps are in the chat."