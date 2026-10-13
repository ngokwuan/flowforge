import { UnauthorizedException } from '@nestjs/common';

export const unauthorized = (code: string, message: string) =>
  new UnauthorizedException({ code, message });
