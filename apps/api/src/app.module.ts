import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createObserveModule } from '@nestjs/observe';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const observeKey = process.env.OBSERVE_APP_KEY;
const observeSecret = process.env.OBSERVE_APP_SECRET;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
    // Observe chỉ bật khi có đủ khóa (máy dev), tắt trong test và CI.
    ...(observeKey && observeSecret
      ? [
          ObserveModule.forRoot({
            appKey: observeKey,
            appSecret: observeSecret,
            serviceId: 'api',
          }),
        ]
      : []),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const nodeEnv = config.get<string>('NODE_ENV');
        return {
          pinoHttp: {
            level: nodeEnv === 'test' ? 'silent' : 'info',
            genReqId: (req, res) => {
              const id =
                (req.headers['x-request-id'] as string) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            transport:
              nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
          },
        };
      },
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
