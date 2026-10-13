import { Body, Controller, Post } from '@nestjs/common';
import { registerSchema, type RegisterInput } from '@flowforge/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // POST returns 201 Created by default.
  @Post('register')
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
  ) {
    return this.auth.register(body);
  }
}
