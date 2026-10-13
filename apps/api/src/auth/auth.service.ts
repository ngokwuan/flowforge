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
  private readonly dummyHash = hash('flowforge-dummy-password', ARGON2_OPTIONS);

  constructor(
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(data: RegisterInput) {
    const email = data.email.trim().toLowerCase();
    const passwordHash = await hash(data.password, ARGON2_OPTIONS);

    return this.users.createWithPersonalWorkspace({
      email,
      name: data.name,
      passwordHash,
    });
  }

  async login(data: LoginInput) {
    const email = data.email.trim().toLowerCase();
    const user = await this.users.findForLogin(email);

    const validUser = await verify(
      user?.passwordHash ?? (await this.dummyHash),
      data.password,
    );
    if (!user || !user.passwordHash || !validUser) {
      throw unauthorized(
        'AUTH_INVALID_CREDENTIALS',
        'Email hoặc mật khẩu không đúng',
      );
    }

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
      throw unauthorized(
        'AUTH_REFRESH_INVALID',
        'Phiên đăng nhập không hợp lệ',
      );
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
      throw unauthorized(
        'AUTH_UNAUTHORIZED',
        'Chưa đăng nhập hoặc phiên đã hết hạn',
      );
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

  private hashRefreshToken(token: string) {
    return createHmac(
      'sha256',
      this.config.get('JWT_REFRESH_SECRET', { infer: true }),
    )
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
