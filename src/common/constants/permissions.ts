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

  /*
   * XAVF (INCIDENT) JARAYONI.
   *
   * ⚠️ `ACT` va `CLOSE` AJRATILGAN: javobgar shaxs hodisani qabul qiladi
   * va «bartaraf etildi» deb belgilaydi, lekin uni YOPA OLMAYDI — yopish
   * «tekshirildi» degani va u yuqori mas'ulning qarori. Bitta ruxsat
   * bo'lsa, javobgar o'z ishini o'zi qabul qilib qo'yardi.
   *
   * ⚠️ O'CHIRISH ruxsati YO'Q va endpoint ham YO'Q: hodisa tarixi —
   * mas'uliyat izi.
   */
  INCIDENTS_VIEW: 'incidents.view',
  INCIDENTS_ACT: 'incidents.act',
  INCIDENTS_CLOSE: 'incidents.close',

  /*
   * JAVOBGAR SHAXSLAR REYESTRI.
   *
   * ⚠️⚠️ `CONTACTS` ALOHIDA: telefon va email — shaxsiy ma'lumot.
   * Kuzatuvchi kim javobgar ekanini ko'radi, lekin uning raqamini
   * ko'rmaydi (niqoblangan). Ko'rish huquqi bilan birga raqam ham
   * tarqalsa, reyestr butun viloyat bo'ylab telefon kitobiga aylanardi.
   */
  RESPONSIBLES_VIEW: 'responsibles.view',
  RESPONSIBLES_MANAGE: 'responsibles.manage',
  RESPONSIBLES_CONTACTS: 'responsibles.contacts',

  // Monitoring jadvali va bayram kunlari
  SCHEDULES_VIEW: 'schedules.view',
  SCHEDULES_MANAGE: 'schedules.manage',

  /** Eskalatsiya muddatlari va qoidalari. */
  ESCALATION_MANAGE: 'escalation.manage',
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
    // XAVF jarayoni — viloyat darajasi.
    PERMISSIONS.INCIDENTS_VIEW,
    PERMISSIONS.INCIDENTS_ACT,
    PERMISSIONS.INCIDENTS_CLOSE,
    PERMISSIONS.RESPONSIBLES_VIEW,
    PERMISSIONS.RESPONSIBLES_MANAGE,
    PERMISSIONS.RESPONSIBLES_CONTACTS,
    PERMISSIONS.SCHEDULES_VIEW,
    /* ⚠️ Texnik topshiriq: jadval va eskalatsiya muddatlarini
       ADMINISTRATOR sozlaydi (tuman mas'uli emas — u faqat ko'radi). */
    PERMISSIONS.SCHEDULES_MANAGE,
    PERMISSIONS.ESCALATION_MANAGE,
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
    /*
     * ⚠️ TUMAN MAS'ULI O'ZI MODUL QO'SHADI (biznes qarori, 2026-11-14):
     * kotyol va modulni u o'z tumanida o'zi yaratadi, administratorni
     * kutmaydi. Xavfsiz, chunki:
     *   • biriktirish faqat O'Z tumanidagi kotyolga (`assertBoilerAssignable`);
     *   • boshqa tumandagi modulga TEGA OLMAYDI (`update` joriy kotyol
     *     tumanini ham tekshiradi);
     *   • o'chirish (`DEVICES_DELETE`) va kalitni almashtirish
     *     (`DEVICES_ROTATE_KEY`) — HAMON faqat administratorda.
     */
    PERMISSIONS.DEVICES_CREATE,
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
    /* ⚠️ XAVF — O'Z TUMANI bo'yicha (`incident-scope.helper.ts`). Javobgar
       shaxslarni ham o'z tumanidagi obyektlarga o'zi biriktiradi: maktab
       direktorini viloyat emas, tuman biladi. */
    PERMISSIONS.INCIDENTS_VIEW,
    PERMISSIONS.INCIDENTS_ACT,
    PERMISSIONS.INCIDENTS_CLOSE,
    PERMISSIONS.RESPONSIBLES_VIEW,
    PERMISSIONS.RESPONSIBLES_MANAGE,
    PERMISSIONS.RESPONSIBLES_CONTACTS,
    PERMISSIONS.SCHEDULES_VIEW,
  ],

  [UserRole.VIEWER]: [
    PERMISSIONS.BOILERS_VIEW,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.FIRMWARE_VIEW,
    PERMISSIONS.TELEMETRY_VIEW,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.CATALOGS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    // ⚠️ Kuzatuvchi XAVF va javobgarni ko'radi, TELEFONINI emas (`CONTACTS` yo'q).
    PERMISSIONS.INCIDENTS_VIEW,
    PERMISSIONS.RESPONSIBLES_VIEW,
    PERMISSIONS.SCHEDULES_VIEW,
  ],

  /*
   * ⚠️⚠️ TASHKILOT MAS'ULI — FAQAT XAVF JARAYONI. Kotyol, qurilma,
   * telemetriya, xarita ruxsatlari ATAYLAB berilmagan: o'sha endpointlar
   * tuman kesimi bilan cheklanadi (`applyDistrictScope`) va tashkilot
   * kesimini bilmaydi. Ruxsat berilsa, u butun viloyatni ko'rib qolardi.
   * Hodisa kartasida obyekt, harorat va jadval baribir bor.
   */
  [UserRole.AGENCY_OFFICER]: [
    PERMISSIONS.INCIDENTS_VIEW,
    PERMISSIONS.INCIDENTS_ACT,
    PERMISSIONS.INCIDENTS_CLOSE,
    PERMISSIONS.RESPONSIBLES_VIEW,
    PERMISSIONS.RESPONSIBLES_CONTACTS,
    PERMISSIONS.SCHEDULES_VIEW,
  ],

  /*
   * ⚠️ OBYEKT JAVOBGARI: qabul qiladi, chora yozadi, «bartaraf etildi»
   * deydi — lekin YOPMAYDI (`INCIDENTS_CLOSE` yo'q). Boshqa javobgarlarning
   * telefoni ham ko'rinmaydi (`CONTACTS` yo'q).
   */
  [UserRole.RESPONSIBLE]: [
    PERMISSIONS.INCIDENTS_VIEW,
    PERMISSIONS.INCIDENTS_ACT,
    PERMISSIONS.RESPONSIBLES_VIEW,
    PERMISSIONS.SCHEDULES_VIEW,
  ],
};

/** Rolning o'zbekcha nomi — UI va audit jurnali uchun. */
export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.SUPER_ADMIN]: 'Bosh administrator',
  [UserRole.ADMIN]: 'Administrator',
  [UserRole.OPERATOR]: 'Tuman mas‘uli',
  [UserRole.VIEWER]: 'Kuzatuvchi',
  [UserRole.AGENCY_OFFICER]: 'Tashkilot mas‘uli',
  [UserRole.RESPONSIBLE]: 'Obyekt javobgari',
};
