import { UserRole } from './enums';

/**
 * RUXSATLAR — MAYDA bo'laklarga bo'lingan.
 *
 * ⚠️ «Kotyolni ko'rish» va «kotyolni o'chirish» BOSHQA-BOSHQA qaror: tuman
 * operatoriga ro'yxatni ochish kerak, lekin yozuvni o'chirish huquqi
 * kerak emas. Bitta `boilers` kaliti bo'lsa, ko'rish huquqini berish
 * bilan birga o'chirish huquqi ham jimgina tarqalib ketardi.
 */
export const PERMISSIONS = {
  // Kotyollar
  BOILERS_VIEW: 'boilers.view',
  BOILERS_CREATE: 'boilers.create',
  BOILERS_UPDATE: 'boilers.update',
  BOILERS_DELETE: 'boilers.delete',
  BOILERS_IMPORT: 'boilers.import',

  // ESP32 qurilmalari
  DEVICES_VIEW: 'devices.view',
  DEVICES_CREATE: 'devices.create',
  DEVICES_UPDATE: 'devices.update',
  DEVICES_DELETE: 'devices.delete',
  /** Kalitni qayta generatsiya qilish — alohida, chunki u qurilmani
   *  tarmoqdan UZADI (eski kalit darhol ishlamay qoladi). */
  DEVICES_ROTATE_KEY: 'devices.rotate_key',

  /*
   * PROSHIVKA VA MASOFADAN YANGILASH (OTA).
   *
   * ⚠️⚠️ `FIRMWARE_ROLLOUT` — ALOHIDA va eng xavfli ruxsat: u butun
   * viloyat bo'ylab qurilmalarga yangi kod YUBORADI. Yaroqsiz reliz
   * tarqatilsa, yuzlab plata «o'rnatish → qaytish» halqasiga tushadi.
   * `FIRMWARE_UPLOAD` dan ajratilgani ham shuning uchun: fayl yuklash
   * — xavfsiz amal (hech kimga tegmaydi), tarqatish esa — qaytarib
   * bo'lmaydigan qaror.
   */
  FIRMWARE_VIEW: 'firmware.view',
  FIRMWARE_UPLOAD: 'firmware.upload',
  FIRMWARE_ROLLOUT: 'firmware.rollout',

  // Telemetriya
  TELEMETRY_VIEW: 'telemetry.view',
  TELEMETRY_EXPORT: 'telemetry.export',

  // Ogohlantirishlar
  ALERTS_VIEW: 'alerts.view',
  ALERTS_ACK: 'alerts.ack',

  // Kataloglar (marka, firma, tashkilot)
  CATALOGS_VIEW: 'catalogs.view',
  CATALOGS_MANAGE: 'catalogs.manage',

  // Hisobotlar va dashboard
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  // Foydalanuvchilar
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',

  // Tizim sozlamalari (harorat chegaralari)
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_UPDATE: 'settings.update',

  // Audit jurnali
  AUDIT_VIEW: 'audit.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * ROL → RUXSATLAR.
 *
 * ⚠️ `super_admin` ro'yxati HISOBLANADI, qo'lda sanalmaydi: yangi ruxsat
 * qo'shilganda uni bu yerga qo'shish esdan chiqsa, superadmin o'zi
 * yaratgan bo'limga kira olmay qolardi.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: ALL_PERMISSIONS,

  [UserRole.ADMIN]: [
    PERMISSIONS.BOILERS_VIEW,
    PERMISSIONS.BOILERS_CREATE,
    PERMISSIONS.BOILERS_UPDATE,
    PERMISSIONS.BOILERS_DELETE,
    PERMISSIONS.BOILERS_IMPORT,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.DEVICES_CREATE,
    PERMISSIONS.DEVICES_UPDATE,
    PERMISSIONS.DEVICES_DELETE,
    PERMISSIONS.DEVICES_ROTATE_KEY,
    /*
     * ⚠️ Administrator proshivkani KO'RADI va YUKLAYDI, lekin
     * TARQATMAYDI (`FIRMWARE_ROLLOUT` yo'q). Tarqatish — butun
     * viloyat parkiga ta'sir qiladigan qaror va u faqat bosh
     * administratorda qoladi (`ROLE_PERMISSIONS[SUPER_ADMIN]`
     * barcha ruxsatlarni hisoblab oladi).
     */
    PERMISSIONS.FIRMWARE_VIEW,
    PERMISSIONS.FIRMWARE_UPLOAD,
    PERMISSIONS.TELEMETRY_VIEW,
    PERMISSIONS.TELEMETRY_EXPORT,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.ALERTS_ACK,
    PERMISSIONS.CATALOGS_VIEW,
    PERMISSIONS.CATALOGS_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
    /*
     * ⚠️ Administrator TUMAN MAS'ULLARINI yarata va tahrirlay oladi —
     * bu uning bevosita vazifasi. Lekin O'CHIRISH (`USERS_DELETE`)
     * berilmaydi: hisobni o'chirish audit jurnalidagi shaxsni
     * «noma'lum» ga aylantiradi va bu qaytarib bo'lmaydigan qaror.
     *
     * ⚠️ `users.create` huquqi O'Z-O'ZIDAN huquq oshirishga yo'l
     * ochmaydi: `assertCanAssignRole` administratorga faqat
     * `operator` va `viewer` rolini berishga ruxsat beradi
     * (`users.service.ts`). Busiz administrator o'ziga yangi
     * `super_admin` yaratib olardi.
     */
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.SETTINGS_VIEW,
  ],

  /*
   * ⚠️ Operator kotyolni O'CHIRA OLMAYDI va qurilma kalitini
   * almashtira olmaydi: ikkalasi ham orqaga qaytarib bo'lmaydigan
   * amal va ular viloyat darajasida qabul qilinadi. Tuman kesimi esa
   * ruxsat emas, MA'LUMOT chegarasi — u `districtId` orqali qo'yiladi
   * (`scope.helper.ts`).
   */
  [UserRole.OPERATOR]: [
    PERMISSIONS.BOILERS_VIEW,
    PERMISSIONS.BOILERS_CREATE,
    PERMISSIONS.BOILERS_UPDATE,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.DEVICES_UPDATE,
    PERMISSIONS.FIRMWARE_VIEW,
    PERMISSIONS.TELEMETRY_VIEW,
    PERMISSIONS.TELEMETRY_EXPORT,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.ALERTS_ACK,
    PERMISSIONS.CATALOGS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    /* ⚠️ O'Z TUMANI bo'yicha Excel chiqarish — mas'ulning kundalik
       ishi (hokimlikka hisobot). Eksport baribir `applyDistrictScope`
       dan o'tadi, ya'ni boshqa tuman ma'lumoti faylga tushmaydi. */
    PERMISSIONS.REPORTS_EXPORT,
  ],

  [UserRole.VIEWER]: [
    PERMISSIONS.BOILERS_VIEW,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.FIRMWARE_VIEW,
    PERMISSIONS.TELEMETRY_VIEW,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.CATALOGS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],
};

/** Rolning o'zbekcha nomi — UI va audit jurnali uchun. */
export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.SUPER_ADMIN]: 'Bosh administrator',
  [UserRole.ADMIN]: 'Administrator',
  [UserRole.OPERATOR]: 'Tuman mas‘uli',
  [UserRole.VIEWER]: 'Kuzatuvchi',
};
