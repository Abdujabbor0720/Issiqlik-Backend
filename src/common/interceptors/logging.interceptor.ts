import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * So'rov jurnali — bitta qator.
 *
 * ⚠️ Telemetriya ingest'i JURNALGA YOZILMAYDI: 2000 ta qurilma har
 * 30 soniyada signal yuborsa, kuniga ~5.7 mln qator bo'ladi va haqiqiy
 * xato ular orasida ko'rinmay qoladi. Sekin so'rovlar (>1s) esa
 * ingest bo'lsa ham yoziladi — u allaqachon muammoning o'zi.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private static readonly QUIET_PATHS = ['/api/data', '/telemetry/ingest'];

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();
    const quiet = LoggingInterceptor.QUIET_PATHS.some((path) =>
      req.originalUrl.includes(path),
    );

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - startedAt;
        if (quiet && ms < 1000) return;
        const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
        if (ms >= 1000) this.logger.warn(`SEKIN: ${line}`);
        else this.logger.log(line);
      }),
    );
  }
}
