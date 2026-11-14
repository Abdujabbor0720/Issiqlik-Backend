import { ForbiddenException } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { UserRole } from '../common/constants/enums';
import type { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * TUMAN CHEGARASI — so'rovga qo'shiladi, guard qilib qo'yilmaydi.
 *
 * ⚠️ Guard «ha/yo'q» deydi: operator kotyollar ro'yxatiga kirishi
 * KERAK, lekin ro'yxatning O'ZI torayishi kerak. Shuning uchun
 * chegara `where` da.
 *
 * ⚠️⚠️ Bu funksiya kotyolga tegadigan HAR BIR ro'yxat so'rovida
 * chaqiriladi. Bitta unutilgan joy — tuman operatori butun viloyat
 * ma'lumotini ko'radigan teshik.
 */
export function applyDistrictScope<T extends object>(
  qb: SelectQueryBuilder<T>,
  user: AuthUser | undefined,
  column: string,
): SelectQueryBuilder<T> {
  if (!user) return qb;
  if (user.role !== UserRole.OPERATOR) return qb;
  if (!user.districtId) {
    /*
     * ⚠️ Tumansiz operator — ma'lumot xatosi. Bunday hisob bo'lmasligi
     * kerak (`users.service.ts` buni rad etadi), lekin bazaga qo'lda
     * yozilgan bo'lsa, u BUTUN viloyatni ko'rib qolmasligi kerak.
     * Shuning uchun bo'sh ro'yxat emas, aniq xato.
     */
    throw new ForbiddenException(
      'Hisobingizga tuman biriktirilmagan — administratorga murojaat qiling',
    );
  }
  return qb.andWhere(`${column} = :scopedDistrictId`, {
    scopedDistrictId: user.districtId,
  });
}

/** Operator shu tumanga tegishli yozuv bilan ishlay oladimi. */
export function assertDistrictAccess(
  user: AuthUser | undefined,
  districtId: string | null | undefined,
): void {
  if (!user || user.role !== UserRole.OPERATOR) return;
  if (!districtId || districtId !== user.districtId) {
    throw new ForbiddenException('Bu tuman sizga biriktirilmagan');
  }
}
