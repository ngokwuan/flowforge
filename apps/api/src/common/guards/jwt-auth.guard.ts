import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { unauthorized } from '../../auth/auth.errors';
import type { Env } from '../pipes/env-validation.pipe';
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
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        email: string;
      }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        algorithms: ['HS256'], // pin the algorithm, never trust the token header
      });
      req.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw fail();
    }
  }
}
