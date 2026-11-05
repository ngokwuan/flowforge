import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { ThrottlerConfigModule } from '../common/throttler/throttler-config.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';

@Module({
  // Secrets are passed per call from validated config, so no global secret here.
  imports: [
    UsersModule,
    PrismaModule,
    JwtModule.register({}),
    ScheduleModule.forRoot(),
    ThrottlerConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, RefreshTokenCleanupService],
  // Other modules that use JwtAuthGuard import AuthModule to get JwtService.
  exports: [JwtModule],
})
export class AuthModule {}
