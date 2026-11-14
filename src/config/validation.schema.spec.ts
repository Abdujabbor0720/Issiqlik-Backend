import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validationSchema } from './validation.schema';

/**
 * ⚠️⚠️ BU TEST BITTA, LEKIN JUDA QIMMAT XATONI QO'RIQLAYDI.
 *
 * `.env.example` OMMAVIY repozitoriyada turadi va unda ataylab
 * ishlamaydigan qiymatlar yoziladi (`<openssl-rand-base64-48>`).
 * Kimdir uni serverda shunchaki `.env` deb nusxalab qo'ysa, tizim
 * REPOZITORIYANI O'QIGAN HAR KIMGA MA'LUM bo'lgan sir bilan ishga
 * tushardi — ya'ni istalgan odam administrator tokenini
 * soxtalashtira olardi.
 *
 * Bunday xato ishlab chiqarishda HECH QANDAY BELGI BERMAYDI: tizim
 * normal ishlaydi, loglar toza, hamma ekran joyida. Uni faqat
 * hujumdan keyin bilib olish mumkin. Shuning uchun u ishga
 * tushishda to'xtatiladi va shu test o'sha to'siqni qo'riqlaydi.
 */

/** Minimal `.env` o'quvchi — `dotenv` ni testga tortmaslik uchun. */
function parseEnvFile(relativePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(resolve(__dirname, '../..', relativePath), 'utf8');

  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function validate(env: Record<string, string>): string[] {
  const { error } = validationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
  return error?.details.map((detail) => detail.message) ?? [];
}

/** Barcha majburiy maydonlari to'ldirilgan, yaroqli namuna. */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_USERNAME: 'issiqlik',
    DB_PASSWORD: 'haqiqiy-parol',
    DB_NAME: 'issiqlik_db',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
  };
}

describe('validationSchema', () => {
  it('⚠️ `.env.example` TO‘G‘RIDAN-TO‘G‘RI nusxalansa — RAD ETADI', () => {
    const messages = validate(parseEnvFile('.env.example'));

    expect(messages.length).toBeGreaterThan(0);
    // Xabar nima qilish kerakligini AYTISHI shart, shunchaki
    // «noto'g'ri qiymat» emas.
    expect(messages.join(' ')).toContain('openssl rand');
  });

  it('haqiqiy `.env` qabul qilinadi', () => {
    // ⚠️ Agar bu yiqilsa, ishlab chiqish muhiti ishga tushmaydi —
    //    ya'ni test qoidani haddan tashqari qattiq qo'ygan.
    expect(validate(parseEnvFile('.env'))).toEqual([]);
  });

  it('to‘g‘ri to‘ldirilgan muhit qabul qilinadi', () => {
    expect(validate(validEnv())).toEqual([]);
  });

  describe('o‘rin egallovchi qiymatlar', () => {
    it.each([
      ['JWT_ACCESS_SECRET', '<openssl-rand-base64-48>'],
      ['JWT_REFRESH_SECRET', '<openssl-rand-base64-48>'],
      ['ADMIN_PASSWORD', '<superadmin-paroli>'],
      ['DEVICE_SHARED_TOKEN', '<umumiy-token-24-belgidan-uzun>'],
    ])('%s — `%s` rad etiladi', (key, placeholder) => {
      /*
       * ⚠️ Xatolar SONI tekshirilmaydi, BORLIGI tekshiriladi: qisqa
       * o'rin egallovchi ikkala qoidani ham buzadi (uzunlik VA
       * shakl), ya'ni ikki xabar qaytadi. Sonni qotirib qo'yish
       * testni mo'rt qilardi — qoida qattiqlashtirilgan har safar
       * u yiqilib, ishni to'sib turardi.
       */
      expect(validate({ ...validEnv(), [key]: placeholder }).length)
        .toBeGreaterThan(0);
    });

    it('⚠️ uzunlik tekshiruvi YETARLI EMAS — shakl ham tekshiriladi', () => {
      /*
       * `<openssl-rand-base64-48>` — 24 belgi. Ilgari chegara
       * `min(16)` edi va bu qiymat BEMALOL o'tib ketardi. Test
       * aynan shu holatni qotirib qo'yadi: chegara qanday
       * o'zgarmasin, `<...>` shakli baribir rad etiladi.
       */
      const placeholder = '<openssl-rand-base64-48>';
      expect(placeholder.length).toBeGreaterThan(16);

      const messages = validate({
        ...validEnv(),
        // Uzunligi YETARLI (44 belgi), lekin shakli o'rin egallovchi —
        // ya'ni faqat SHAKL tekshiruvi uni ushlab qolishi kerak.
        JWT_ACCESS_SECRET: `${placeholder}${'x'.repeat(20)}`,
      });
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain('openssl rand');
    });
  });

  describe('sir uzunligi', () => {
    it('32 belgidan qisqa JWT siri rad etiladi', () => {
      const messages = validate({
        ...validEnv(),
        JWT_ACCESS_SECRET: 'x'.repeat(31),
      });
      expect(messages.join(' ')).toContain('32 belgi');
    });

    it('aynan 32 belgi — qabul qilinadi', () => {
      expect(
        validate({ ...validEnv(), JWT_ACCESS_SECRET: 'x'.repeat(32) }),
      ).toEqual([]);
    });
  });

  describe('umumiy qurilma tokeni', () => {
    it('BO‘SH — mexanizm o‘chiq, bu SUKUTDAGI holat', () => {
      expect(validate({ ...validEnv(), DEVICE_SHARED_TOKEN: '' })).toEqual([]);
    });

    it('24 belgidan qisqa token rad etiladi', () => {
      // Qisqa token o'nlab qurilmaga kirish beradi — lug'at hujumiga ochiq.
      expect(
        validate({ ...validEnv(), DEVICE_SHARED_TOKEN: 'qisqa' }).length,
      ).toBe(1);
    });
  });
});
