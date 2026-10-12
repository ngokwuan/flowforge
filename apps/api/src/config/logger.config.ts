import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Params } from 'nestjs-pino';

export const getLoggerConfig = (config: ConfigService): Params => {
  const nodeEnv = config.get<string>('NODE_ENV');

  return {
    pinoHttp: {
      level: nodeEnv === 'test' ? 'silent' : 'info',
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      transport:
        nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
    },
  };
};
