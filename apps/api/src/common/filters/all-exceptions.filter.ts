import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const requestId = req.id;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const payload =
        typeof raw === 'string'
          ? { message: raw }
          : (raw as Record<string, unknown>);
      const isList = Array.isArray(payload.message);

      const body: ErrorBody = {
        code:
          typeof payload.code === 'string' ? payload.code : HttpStatus[status],
        message: isList
          ? 'Dữ liệu không hợp lệ'
          : String(payload.message ?? exception.message),
        details: isList ? payload.message : payload.details,
        requestId,
      };
      res.status(status).json(body);
      return;
    }

    this.logger.error(exception);
    const body: ErrorBody = {
      code: 'INTERNAL_ERROR',
      message: 'Lỗi server, vui lòng thử lại sau',
      requestId,
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
