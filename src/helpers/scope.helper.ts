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
  assertNotNarrowRole(user);
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
  if (!user) return;
  assertNotNarrowRole(user);
  if (user.role !== UserRole.OPERATOR) return;
  if (!districtId || districtId !== user.districtId) {
    throw new ForbiddenException('Bu tuman sizga biriktirilmagan');
  }
}

/**
 * TUMAN KESIMINI BILMAYDIGAN ROLLAR — YOPIQ HOLATDA.
 *
 * ⚠️⚠️ Bu funksiya «operator bo'lmasa — cheklov yo'q» deb ishlaydi. Yangi
 * rollar (tashkilot mas'uli, obyekt javobgari) operator EMAS, lekin
 * viloyat darajasi ham emas: ular uchun `return qb` butun viloyatni
 * ochib berardi. Ularning ruxsatlari bu endpointlarga yetmaydi
 * (`permissions.ts`), lekin ruxsat ro'yxati bir kuni kengaytirilsa,
 * teshik jimgina ochilmasligi kerak — shuning uchun aniq 403.
 * Ularning kesimi `incident-scope.helper.ts` da.
 */
const NARROW_ROLES: readonly UserRole[] = [
  UserRole.AGENCY_OFFICER,
  UserRole.RESPONSIBLE,
];

/** Tashkilot mas'uli yoki obyekt javobgari — tuman kesimidan TASHQARIDAGI rol. */
export function isNarrowRole(user: AuthUser | undefined): boolean {
  return !!user && NARROW_ROLES.includes(user.role);
}

function assertNotNarrowRole(user: AuthUser): void {
  if (isNarrowRole(user)) {
    throw new ForbiddenException('Bu bo‘lim sizning vakolatingizga kirmaydi');
  }
}
