import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../constants/enums';
import type { Permission } from '../constants/permissions';

/**
 * Token ichidan chiqadigan foydalanuvchi.
 *
 * ⚠️ `districtId` — RUXSAT emas, MA'LUMOT CHEGARASI. Tuman operatori
 * kotyollar ro'yxatini ochganda `where` ga shu qiymat qo'shiladi
 * (`scope.helper.ts`). Buni guard qilib qo'yib bo'lmaydi: guard «ha/yo'q»
 * deydi, bu yerda esa so'rovning O'ZI torayishi kerak.
 */
export interface AuthUser {
  id: string;
  login: string;
  role: UserRole;
  permissions: Permission[];
  districtId: string | null;
  /**
   * Tashkilot mas'uli (`agency_officer`) uchun — u FAQAT shu idoraga
   * qarashli muassasalarning XAVF hodisalarini ko'radi
   * (`incident-scope.helper.ts`). Boshqa rollarda `null`.
   */
  agencyId: string | null;
  fullName: string;
}

export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = req.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
