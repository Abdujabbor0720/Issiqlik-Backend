import * as Joi from 'joi';

/**
 * Sozlama yetishmasa server ISHGA TUSHMASIN.
 *
 * ⚠️ Yarim sozlangan server eng yomon holat: xato runtime'da, allaqachon
 * ma'lumot yozilayotgan paytda chiqadi. Bu yerda esa u `npm start` ning
 * birinchi soniyasida, aniq maydon nomi bilan chiqadi.
 */
/**
 * O'RIN EGALLOVCHI NAMUNASI — `<...>` ko'rinishidagi qiymat.
 *
 * ⚠️ `.env.example` ommaviy repozitoriyada turadi va unda ataylab
 * ishlamaydigan qiymatlar yoziladi (`<openssl-rand-base64-48>`).
 * Ular uzunlik tekshiruvidan o'tib ketishi mumkin, shuning uchun
 * SHAKLI bo'yicha ham rad etiladi.
 */
const PLACEHOLDER = /<[^>]*>/;

const PLACEHOLDER_MESSAGE =
  'Qiymat .env.example dagi o‘rin egallovchi bo‘lib qolgan. ' +
  'Haqiqiy qiymat yozing: openssl rand -base64 48';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),

  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),
  DB_LOGGING: Joi.boolean().default(false),
  DB_SSL: Joi.boolean().default(false),

  /*
   * ⚠️⚠️ 32 belgidan qisqa sirni qabul qilmaymiz: `secret` kabi qiymat
   * bilan imzolangan token amalda imzolanmagan tokenga teng.
   *
   * ⚠️⚠️ O'RIN EGALLOVCHI QIYMAT ESA UMUMAN O'TMAYDI (`PLACEHOLDER`).
   * Sabab: `.env.example` ommaviy repozitoriyada turadi va unda
   * `<openssl-rand-base64-48>` kabi qiymatlar bor. Ular 24 belgi —
   * ya'ni uzunlik tekshiruvidan BEMALOL o'tardi. Kimdir faylni
   * serverga shunchaki nusxalab qo'ysa, tizim OMMAVIY MA'LUM sir
   * bilan ishga tushardi va repozitoriyani o'qigan har kim
   * administrator tokenini soxtalashtira olardi.
   *
   * Bunday xatoni ishlab chiqarishda topib bo'lmaydi — u hech qanday
   * belgi bermaydi. Shuning uchun u ISHGA TUSHISHDA to'xtatiladi.
   */
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .pattern(PLACEHOLDER, { invert: true })
    .required()
    .messages({
      'string.min': 'JWT_ACCESS_SECRET kamida 32 belgi bo‘lishi kerak',
      'string.pattern.invert.base': PLACEHOLDER_MESSAGE,
    }),
  JWT_ACCESS_TTL: Joi.string().default('30m'),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .pattern(PLACEHOLDER, { invert: true })
    .required()
    .messages({
      'string.min': 'JWT_REFRESH_SECRET kamida 32 belgi bo‘lishi kerak',
      'string.pattern.invert.base': PLACEHOLDER_MESSAGE,
    }),
  JWT_REFRESH_TTL: Joi.string().default('30d'),

  // ───────── Birinchi superadmin ─────────
  // Bo'sh bazada bitta `super_admin` shu qiymatlardan yaratiladi.
  ADMIN_LOGIN: Joi.string().allow('').default(''),
  ADMIN_PASSWORD: Joi.string()
    .allow('')
    .min(8)
    // ⚠️ `<superadmin-paroli>` bilan superadmin yaratilib qolmasin.
    .pattern(PLACEHOLDER, { invert: true })
    .default('')
    .messages({
      'string.min': 'ADMIN_PASSWORD kamida 8 belgi bo‘lishi kerak',
    }),
  ADMIN_FULL_NAME: Joi.string().allow('').default('Tizim administratori'),

  // ───────── Kotyol holati chegaralari (boshlang'ich) ─────────
  BOILER_ACTIVE_MIN_C: Joi.number().min(0).max(150).default(50),
  BOILER_MEDIUM_MIN_C: Joi.number().min(0).max(150).default(40),
  BOILER_CRITICAL_MIN_C: Joi.number().min(0).max(150).default(20),
  BOILER_OFFLINE_AFTER_MIN: Joi.number().min(1).max(1440).default(15),
  BOILER_NORM_TEMPERATURE: Joi.number().min(1).max(150).default(60),

  TELEMETRY_MAX_PER_MINUTE: Joi.number().min(1).max(600).default(60),
  TELEMETRY_RETENTION_DAYS: Joi.number().min(7).max(3650).default(90),

  /*
   * ⚠️⚠️ UMUMIY QURILMA TOKENI — sukut bo'yicha BO'SH (o'chiq).
   * To'ldirilsa, uzunligi KAMIDA 24 belgi bo'lishi shart: qisqa token
   * lug'at hujumiga ochiq va u bitta emas, O'NLAB qurilmaga kirish
   * beradi. `allow(...)` orqali bo'sh qiymatga ruxsat berilgan —
   * aks holda mexanizmni o'chirib qo'yish imkoni bo'lmasdi.
   */
  DEVICE_SHARED_TOKEN: Joi.string()
    .allow('')
    .min(24)
    .pattern(PLACEHOLDER, { invert: true })
    .default('')
    .messages({ 'string.pattern.invert.base': PLACEHOLDER_MESSAGE }),

  /*
   * ⚠️ `.bin` fayllar papkasi. Sukut `./storage/firmware` — loyiha
   * ichida, lekin statik servis YO'Q (`main.ts` da `useStaticAssets`
   * ishlatilmaydi), shuning uchun u web orqali ochilmaydi.
   * Ishlab chiqarishda `/var/lib/issiqlik/firmware` tavsiya qilinadi.
   */
  /*
   * ⚠️⚠️ Ishlab chiqarishda `https://` BO'LISHI SHART va domen
   * proshivkadagi `SERVER_HOST` bilan AYNI bo'lishi kerak. `http://`
   * ga faqat ishlab chiqish (`development`) uchun ruxsat.
   */
  PUBLIC_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000'),

  /*
   * ⚠️ Avtomatik ro'yxatga olingan qurilmalar soni chegarasi.
   *    Parkdan sezilarli katta qo'yilsa, chegara ma'nosini
   *    yo'qotadi; juda kichik qo'yilsa, haqiqiy qurilmalar
   *    ro'yxatga tusha olmay qoladi.
   */
  DEVICE_AUTO_ENROLL_MAX: Joi.number().min(0).max(100000).default(2000),

  FIRMWARE_DIR: Joi.string().default('./storage/firmware'),
  FIRMWARE_MAX_CONCURRENT: Joi.number().min(1).max(200).default(10),

  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(300),

  /*
   * ⚠️ FAYL ARXIVI — DigitalOcean Spaces (S3 bilan mos). IXTIYORIY:
   * berilmasa import ishlayveradi, faqat asl fayl arxivlanmaydi. Lekin
   * QISMAN berilsa (masalan kalit bor, bucket yo'q) — server ISHGA
   * TUSHMAYDI: «sozladim, lekin saqlanmayapti» degan jim xato bo'lmasin.
   */
  DO_REGION: Joi.string().allow('').optional(),
  DO_ENDPOINT: Joi.string().allow('').optional(),
  DO_ACCESS_KEY: Joi.string().allow('').optional(),
  DO_SECRET_KEY: Joi.string().allow('').optional(),
  DO_BUCKET_NAME: Joi.string().allow('').optional(),
  DO_BUCKET_PUBLIC_BASE_URL: Joi.string().allow('').optional(),
})
  // ⚠️ Chegaralar tartibi TEKSHIRILADI: `faol < o'rta` bo'lib qolsa, hamma
  // kotyol bir vaqtning o'zida ikki holatga tushardi va dashboard'dagi
  // yig'indi jami songa teng bo'lmay qolardi.
  .custom((value: Record<string, number>, helpers) => {
    const active = Number(value.BOILER_ACTIVE_MIN_C);
    const medium = Number(value.BOILER_MEDIUM_MIN_C);
    const critical = Number(value.BOILER_CRITICAL_MIN_C);
    const storageKeys = [
      'DO_ENDPOINT',
      'DO_ACCESS_KEY',
      'DO_SECRET_KEY',
      'DO_BUCKET_NAME',
    ] as const;
    const storageSet = storageKeys.filter((key) =>
      String((value as Record<string, unknown>)[key] ?? '').trim(),
    );
    if (storageSet.length > 0 && storageSet.length < storageKeys.length) {
      return helpers.message({
        custom: `Fayl arxivi (DO Spaces) qisman sozlangan — ${storageKeys.join(', ')} hammasi berilishi kerak`,
      });
    }
    if (!(active > medium && medium > critical)) {
      return helpers.message({
        custom:
          'Chegaralar kamayish tartibida bo‘lishi kerak: ' +
          'BOILER_ACTIVE_MIN_C > BOILER_MEDIUM_MIN_C > BOILER_CRITICAL_MIN_C',
      });
    }
    return value;
  });
