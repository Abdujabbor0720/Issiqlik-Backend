import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { stableString } from '../../helpers/stringify.helpers';

interface ErrorBody {
  success: false;
  statusCode: number;
  error: { code: string; message: string; details?: unknown };
  path: string;
  timestamp: string;
}

/**
 * PostgreSQL xato kodi → foydalanuvchiga ko'rinadigan o'zbekcha xabar.
 *
 * ⚠️ Baza xatosi XOM holda chiqarilmaydi: `duplicate key value violates
 * unique constraint "UQ_boilers_lot_number"` matni operatorga hech narsa
 * demaydi va ustun nomlarini tashqariga chiqaradi.
 */
const PG_MESSAGES: Record<
  string,
  { status: number; code: string; message: string }
> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    code: 'DUPLICATE_ENTRY',
    message: 'Bunday yozuv allaqachon mavjud',
  },
  '23503': {
    status: HttpStatus.CONFLICT,
    code: 'FOREIGN_KEY_VIOLATION',
    message:
      'Bog‘liq yozuvlar mavjud — avval ularni o‘chiring yoki boshqasiga bog‘lang',
  },
  '23502': {
    status: HttpStatus.BAD_REQUEST,
    code: 'NOT_NULL_VIOLATION',
    message: 'Majburiy maydon to‘ldirilmagan',
  },
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    code: 'INVALID_INPUT',
    message: 'Yuborilgan qiymat formati noto‘g‘ri',
  },
  '22003': {
    status: HttpStatus.BAD_REQUEST,
    code: 'NUMERIC_OUT_OF_RANGE',
    message: 'Son ruxsat etilgan chegaradan tashqarida',
  },
};

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
};

function codeFor(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const body = this.toBody(exception, request);

    /*
     * ⚠️ 5xx — stack bilan, 4xx — bitta qator. Aks holda jurnal KUTILGAN
     * validatsiya xatolari bilan to'lib ketadi va haqiqiy nosozlik
     * ular orasida ko'rinmay qoladi.
     */
    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} → ${body.statusCode} ${body.error.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.originalUrl} → ${body.statusCode} ${body.error.code}: ${body.error.message}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, request: Request): ErrorBody {
    const base = {
      success: false as const,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        return {
          ...base,
          statusCode: status,
          error: { code: codeFor(status), message: res },
        };
      }

      const obj = res as Record<string, unknown>;
      const raw = obj.message;
      // ValidationPipe MASSIV qaytaradi — birinchisi xabar, hammasi `details`.
      const message = Array.isArray(raw)
        ? stableString(raw[0]) || 'Ma’lumotlar noto‘g‘ri'
        : stableString(raw) || exception.message;

      return {
        ...base,
        statusCode: status,
        error: {
          code: stableString(obj.code) || codeFor(status),
          message,
          details: Array.isArray(raw) && raw.length > 1 ? raw : undefined,
        },
      };
    }

    if (exception instanceof QueryFailedError) {
      const driver = exception as unknown as { code?: string };
      const mapped = driver.code ? PG_MESSAGES[driver.code] : undefined;
      if (mapped) {
        return {
          ...base,
          statusCode: mapped.status,
          error: { code: mapped.code, message: mapped.message },
        };
      }
    }

    /*
     * ⚠️ Noma'lum xatoning MATNI tashqariga chiqarilmaydi: unda ulanish
     * satri, fayl yo'li yoki SQL bo'lishi mumkin. To'liq matn jurnalda
     * (yuqorida) qoladi.
     */
    return {
      ...base,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Serverda kutilmagan xatolik yuz berdi',
      },
    };
  }
}
