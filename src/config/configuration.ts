/**
 * ILOVA SOZLAMALARI — yagona manba.
 *
 * ⚠️ `process.env` ga kodning boshqa joyidan TEGILMAYDI. Sabab: muhit
 * o'zgaruvchisi matn bo'lib keladi va har bir chaqiruv joyi uni o'zicha
 * o'qiydi — bir joyda `'false'` satri `true` bo'lib hisoblanadi, boshqasida
 * `0` soni `NaN` ga aylanadi. Bu yerda BIR MARTA o'qiladi, turga keltiriladi
 * va butun ilova `ConfigService` orqali AYNI qiymatni ko'radi.
 */
export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    logging: boolean;
    ssl: boolean;
  };
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshSecret: string;
    refreshTtl: string;
  };
  /**
   * Birinchi superadmin — FAQAT bo'sh bazada yaratiladi.
   * ⚠️ Mavjud hisobning paroli bu yerdan O'ZGARMAYDI: aks holda `.env`
   * fayliga teginish huquqi bor har kim istalgan hisobni egallab olardi.
   */
  admin: {
    login: string;
    password: string;
    fullName: string;
  };
  /**
   * KOTYOL HOLATI CHEGARALARI — foydalanuvchi bergan qoida.
   *
   * ⚠️ Bular faqat BOSHLANG'ICH qiymat: haqiqiy chegara bazadagi
   * `system_settings` jadvalida turadi va Sozlamalar sahifasidan
   * o'zgartiriladi. `.env` da qotirilsa, chegarani o'zgartirish uchun
   * serverni qayta ishga tushirish kerak bo'lardi.
   */
  boiler: {
    activeMinC: number;
    mediumMinC: number;
    criticalMinC: number;
    offlineAfterMinutes: number;
    normTemperature: number;
  };
  telemetry: {
    /** Bitta qurilma daqiqasiga nechta o'lchov yubora oladi. */
    maxReadingsPerMinute: number;
    /** O'lchovlar necha kun saqlanadi (keyin soatlik agregatga siqiladi). */
    retentionDays: number;
    /**
     * KO'CHISH DAVRI UCHUN UMUMIY TOKEN.
     *
     * ⚠️⚠️ BO'SH BO'LSA — umumiy token mexanizmi BUTUNLAY O'CHIQ va
     * bu SUKUTDAGI holat. Xonobodning 14 qurilmasida hozir `secrets.h`
     * dagi bitta umumiy token turibdi; ularni shaxsiy tokenga
     * o'tkazish davrida shu qiymat vaqtincha to'ldiriladi.
     *
     * ⚠️ U O'Z-O'ZIDAN yetarli EMAS: qurilma yozuvida
     * `allow_shared_token = true` ham bo'lishi kerak (sukut `false`).
     * Ya'ni token sizib chiqsa ham, u faqat ONGLI ravishda belgilangan
     * qurilmalarga ishlaydi — butun viloyatga emas.
     */
    sharedDeviceToken: string;
  };

  /**
   * TASHQI MANZIL — qurilmalar ko'radigan asosiy URL.
   *
   * ⚠️⚠️ OTA JAVOBIDAGI `url` AYNAN shundan quriladi va proshivka
   * uni QAT'IY tekshiradi (`net.cpp:6`, `isOwnServerUrl`):
   *   • `https://<host>/` bilan boshlanishi SHART;
   *   • ichida `@` bo'lmasligi kerak;
   *   • `http://` — RAD ETILADI.
   * Noto'g'ri bo'lsa, qurilma faylni umuman yuklab olmaydi va
   * tokenni ham yubormaydi.
   */
  publicBaseUrl: string;

  firmware: {
    /**
     * `.bin` FAYLLAR PAPKASI — WEB ROOT'DAN TASHQARIDA.
     *
     * ⚠️⚠️ Proshivka ichida qurilma tokeni bo'lishi mumkin (`secrets.h`
     * dagi `API_TOKEN` kompilyatsiyada `.bin` ga kiradi). Fayl ochiq
     * papkada turganda uni istalgan odam yuklab, `strings` bilan
     * tokenni ajratib olardi. Shuning uchun fayl statik servis
     * ko'rmaydigan joyda turadi va faqat token tekshirilgandan keyin
     * oqim bilan beriladi.
     */
    dir: string;
    /** Bir vaqtda ko'pi bilan nechta qurilma yuklab olishi mumkin. */
    maxConcurrentDownloads: number;
  };
  throttle: { ttl: number; limit: number };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    name: process.env.DB_NAME ?? 'issiqlik_db',
    logging: process.env.DB_LOGGING === 'true',
    ssl: process.env.DB_SSL === 'true',
  },

  jwt: {
    accessSecret:
      process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '30m',
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },

  admin: {
    login: (process.env.ADMIN_LOGIN ?? '').trim(),
    password: process.env.ADMIN_PASSWORD ?? '',
    fullName: (process.env.ADMIN_FULL_NAME ?? 'Tizim administratori').trim(),
  },

  boiler: {
    activeMinC: parseFloat(process.env.BOILER_ACTIVE_MIN_C ?? '50'),
    mediumMinC: parseFloat(process.env.BOILER_MEDIUM_MIN_C ?? '40'),
    criticalMinC: parseFloat(process.env.BOILER_CRITICAL_MIN_C ?? '20'),
    offlineAfterMinutes: parseInt(
      process.env.BOILER_OFFLINE_AFTER_MIN ?? '15',
      10,
    ),
    normTemperature: parseFloat(process.env.BOILER_NORM_TEMPERATURE ?? '60'),
  },

  telemetry: {
    maxReadingsPerMinute: parseInt(
      process.env.TELEMETRY_MAX_PER_MINUTE ?? '60',
      10,
    ),
    retentionDays: parseInt(process.env.TELEMETRY_RETENTION_DAYS ?? '90', 10),
    // ⚠️ Sukut BO'SH — umumiy token o'chiq (yuqoridagi izohga qara).
    sharedDeviceToken: (process.env.DEVICE_SHARED_TOKEN ?? '').trim(),
  },

  // ⚠️ Oxiridagi `/` olib tashlanadi: aks holda manzilda `//` chiqardi.
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'
  ).replace(/\/+$/, ''),

  firmware: {
    dir: process.env.FIRMWARE_DIR ?? './storage/firmware',
    maxConcurrentDownloads: parseInt(
      process.env.FIRMWARE_MAX_CONCURRENT ?? '10',
      10,
    ),
  },

  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '300', 10),
  },
});
