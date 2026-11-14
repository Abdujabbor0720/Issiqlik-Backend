import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IKKI DATCHIK (kirish/chiqish) — bitta haroratdan JUFTLIKKA.
 *
 * ⚠️⚠️ ESP32 v2.0.0 proshivkasida har bir modulda IKKI DS18B20 bor:
 *   • kirish  (obratka)  — tizimdan qozonxonaga QAYTAYOTGAN suv, sovuqroq;
 *   • chiqish (podacha)  — qozonxonadan CHIQAYOTGAN issiq suv, issiqroq.
 * Ilgari jadvalda bitta `temperature` ustuni bor edi va u CHIQISH
 * haroratini bildirardi (holat formulasi ham shundan hisoblanadi).
 *
 * ⚠️⚠️ `temperature` USTUNI NOMI VA MA'NOSI O'ZGARMAYDI: u doim
 * CHIQISH harorati bo'lib qoladi. Sabab: undan grafik, Excel eksporti,
 * holat formulasi (`resolveBoilerStatus`), ogohlantirish mexanizmi va
 * dashboard agregatlari oziqlanadi. Ma'nosi jimgina o'zgarsa (masalan
 * «ikkalasining o'rtachasi» yoki «kirish» bo'lib qolsa), butun tizim
 * bo'ylab holat ~20 °C pastga siljib, VILOYAT MIQYOSIDA yolg'on
 * «ishlamayotgan» ogohlantirishlari boshlanardi. Mavjud Xonobod
 * panelida aynan shu xato bor (`worker.js:218` — juftlikdan KIRISH
 * harorati asosiy ustunga yoziladi); u bu yerga ko'chirilmaydi.
 *
 * ⚠️ MA'LUMOT YO'QOLMAYDI: eski qatorlar `probe = 'outlet'` deb
 * belgilanadi va `outlet_temperature` ga ko'chiriladi — chunki hozirgi
 * `modul1` proshivkasi aynan chiqish haroratini yuboradi.
 */
export class DualProbeTelemetry1763200000000 implements MigrationInterface {
  name = 'DualProbeTelemetry1763200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ───────────── 1. O'lchov tarkibi (probe) ─────────────
    /*
     * ⚠️ `probe` — o'lchovda NIMA borligini aytadi, qaysi datchik
     * «asosiy» ekanini EMAS:
     *   both    — ikkala datchik ishlagan (proshivka inlet+outlet yubordi);
     *   outlet  — faqat chiqish datchigi ishlagan;
     *   inlet   — faqat kirish datchigi ishlagan (chiqish NOMA'LUM!);
     *   unknown — eski proshivka: bitta harorat, qaysi quvurligi aytilmagan.
     *
     * Busiz `inlet` va `outlet` yakka o'lchovlari bir xil ko'rinardi va
     * sovuq obratka qiymati chiqish harorati o'rniga ishlatilardi.
     */
    await queryRunner.query(`
      CREATE TYPE "telemetry_readings_probe_enum"
        AS ENUM ('both', 'inlet', 'outlet', 'unknown')
    `);

    await queryRunner.query(`
      ALTER TABLE "telemetry_readings"
        ADD COLUMN "inlet_temperature"  numeric(6,2),
        ADD COLUMN "outlet_temperature" numeric(6,2),
        ADD COLUMN "probe" "telemetry_readings_probe_enum"
          NOT NULL DEFAULT 'unknown',
        ADD COLUMN "measured_at" timestamptz
    `);

    /*
     * ⚠️ MA'LUMOTNI KO'CHIRISH. Mavjud o'lchovlar `modul1`
     * proshivkasidan keldi va u FAQAT chiqish haroratini yuboradi
     * («faqat chiqishni ko'rsatadi» — texnik topshiriq). Shuning uchun
     * eski qiymat `outlet_temperature` ga tushadi. Agar bu bosqich
     * o'tkazib yuborilsa, butun o'tgan tarix grafikning chiqish
     * chizig'idan YO'QOLARDI.
     */
    await queryRunner.query(`
      UPDATE "telemetry_readings"
      SET "outlet_temperature" = "temperature",
          "probe" = 'outlet'
      WHERE "temperature" IS NOT NULL
    `);

    // ───────────── 2. Oflayn navbat uchun idempotentlik ─────────────
    /*
     * ⚠️⚠️ QISMAN UNIQUE INDEKS. Proshivkada oflayn navbat bor
     * (`OFFLINE_QUEUE_ENABLED`): internet yo'q paytdagi o'lchovlar
     * xotirada saqlanib, keyin `measured_at` bilan QAYTA yuboriladi.
     * Qurilma 2xx javobini olmasa, AYNI o'lchovni yana yuboradi —
     * ya'ni takror kafolatlangan. Indekssiz bitta o'lchov o'nlab
     * marta yozilib, kunlik o'rtacha harorat buzilardi.
     *
     * ⚠️ `WHERE "measured_at" IS NOT NULL` — qisman: oddiy (navbatsiz)
     * o'lchovlarda bu maydon bo'sh va ular uchun takror tushunchasi
     * yo'q. To'liq indeks bo'lsa, indeks behuda kattalashardi.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_telemetry_device_measured_at"
        ON "telemetry_readings" ("device_id", "measured_at")
        WHERE "measured_at" IS NOT NULL
    `);

    // ───────────── 3. Kotyolning joriy juftligi ─────────────
    /*
     * ⚠️ `last_temperature` SAQLANADI va chiqish haroratini bildiradi
     * (denormallashtirilgan: xarita 2000 ta kotyolni bitta so'rovda
     * o'qiydi). Yoniga kirish qiymati qo'shiladi — ikkisining AYIRMASI
     * («delta») nasos ishlayotganining eng aniq belgisi: delta ≈ 0
     * bo'lsa suv aylanmayapti, kotyol esa issiq bo'lib ko'rinishi
     * mumkin. Delta ustun sifatida SAQLANMAYDI — u ikki ustundan
     * hisoblanadi va saqlansa uchinchi haqiqat manbai paydo bo'lardi.
     */
    await queryRunner.query(`
      ALTER TABLE "boilers"
        ADD COLUMN "last_inlet_temperature"  numeric(6,2),
        ADD COLUMN "last_outlet_temperature" numeric(6,2)
    `);

    await queryRunner.query(`
      UPDATE "boilers"
      SET "last_outlet_temperature" = "last_temperature"
      WHERE "last_temperature" IS NOT NULL
    `);

    // ───────────── 4. Qurilma: token siyosati va OTA tekshiruvi ─────────────
    /*
     * ⚠️⚠️ `allow_shared_token` SUKUT BO'YICHA `false`.
     *
     * Texnik topshiriqda (§4) umumiy `DEVICE_TOKEN` tavsiya qilingan va
     * uning o'zi ham xavfdan ogohlantiradi: bitta plata qo'lga tushsa,
     * HAMMA muassasa nomidan soxta ma'lumot yuborish mumkin. Viloyat
     * miqyosida (16 tuman, yuzlab obyekt) bu qabul qilinmaydi, shuning
     * uchun tizim FAQAT shaxsiy tokenlar bilan ishlaydi. Ustun
     * qoldirildi: ko'chish davrida ayrim qurilmaga QO'LDA, vaqtincha
     * ruxsat berish kerak bo'lishi mumkin — lekin bu har bir qurilma
     * uchun alohida, ongli qaror bo'ladi, sukutdagi holat emas.
     *
     * ⚠️ `institution_hint` — proshivka yuboradigan `institution_id`
     * (`maktab-4`). Unga ISHONILMAYDI (§3): kotyol `boiler_id` orqali
     * aniqlanadi, bu maydon esa faqat MOS KELMASLIKNI aniqlash uchun
     * saqlanadi («plata boshqa binoga o'rnatilgan» holatini ko'rsatadi).
     */
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD COLUMN "institution_hint"   varchar(64),
        ADD COLUMN "allow_shared_token" boolean NOT NULL DEFAULT false,
        ADD COLUMN "last_check_at"      timestamptz,
        ADD COLUMN "token_issued_at"    timestamptz
    `);

    // ───────────── 5. Yangi ogohlantirish turlari ─────────────
    /*
     * ⚠️ `ALTER TYPE ... ADD VALUE` PostgreSQL 12+ da tranzaksiya
     * ichida ishlaydi, lekin yangi qiymatni AYNI tranzaksiyada
     * ISHLATIB bo'lmaydi. Shuning uchun bu yerda faqat QO'SHILADI —
     * birorta qatorga yozilmaydi.
     *
     * `sensor_fault`   — chiqish datchigi qiymat bermayapti: harorat
     *                    NOMA'LUM, demak holatni ham bilmaymiz;
     * `no_circulation` — kirish va chiqish harorati deyarli teng:
     *                    nasos to'xtagan yoki ventil yopiq.
     */
    await queryRunner.query(`
      ALTER TYPE "alerts_type_enum" ADD VALUE IF NOT EXISTS 'sensor_fault'
    `);
    await queryRunner.query(`
      ALTER TYPE "alerts_type_enum" ADD VALUE IF NOT EXISTS 'no_circulation'
    `);

    // ───────────── 6. Ro'yxatdan o'tmagan qurilmalar ─────────────
    /*
     * ⚠️ Noma'lum `device_id` dan kelgan so'rov RAD ETILADI (403), lekin
     * IZSIZ YO'QOLMAYDI: montajchi platani o'rnatib ketgan, kabinetda
     * esa u hali ro'yxatga kiritilmagan bo'lishi mumkin. Bu jadval
     * «yangi qurilma so'rayapti» bildirishnomasini beradi.
     *
     * ⚠️ `UNIQUE (device_id)` + `attempts` — har so'rovda YANGI qator
     * yozilmaydi: minutda bir marta so'rov yuboruvchi bitta notanish
     * qurilma kuniga 1440 qator yozib, jadvalni suiiste'mol vositasiga
     * aylantirardi.
     */
    await queryRunner.query(`
      CREATE TABLE "pending_devices" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        "device_id"        varchar(64) NOT NULL,
        "institution_hint" varchar(64),
        "firmware_version" varchar(40),
        "last_ip_address"  varchar(45),
        "attempts"         integer NOT NULL DEFAULT 1,
        "last_seen_at"     timestamptz NOT NULL DEFAULT now(),
        "is_dismissed"     boolean NOT NULL DEFAULT false,
        CONSTRAINT "UQ_pending_devices_device_id" UNIQUE ("device_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_pending_devices_open"
        ON "pending_devices" ("last_seen_at" DESC)
        WHERE "is_dismissed" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "pending_devices"`);

    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP COLUMN IF EXISTS "token_issued_at",
        DROP COLUMN IF EXISTS "last_check_at",
        DROP COLUMN IF EXISTS "allow_shared_token",
        DROP COLUMN IF EXISTS "institution_hint"
    `);

    await queryRunner.query(`
      ALTER TABLE "boilers"
        DROP COLUMN IF EXISTS "last_outlet_temperature",
        DROP COLUMN IF EXISTS "last_inlet_temperature"
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_telemetry_device_measured_at"`,
    );

    await queryRunner.query(`
      ALTER TABLE "telemetry_readings"
        DROP COLUMN IF EXISTS "measured_at",
        DROP COLUMN IF EXISTS "probe",
        DROP COLUMN IF EXISTS "outlet_temperature",
        DROP COLUMN IF EXISTS "inlet_temperature"
    `);

    await queryRunner.query(
      `DROP TYPE IF EXISTS "telemetry_readings_probe_enum"`,
    );

    /*
     * ⚠️⚠️ PostgreSQL enum'dan qiymatni OLIB TASHLAB bo'lmaydi —
     * turni qaytadan yasash kerak. Shuning uchun yangi turdagi
     * ogohlantirishlar AVVAL o'chiriladi: ular eski turda
     * ifodalanmaydi va `USING` o'girmasi xato bilan to'xtardi.
     *
     * ⚠️ Bu MA'LUMOT YO'QOLISHI (faqat `sensor_fault` va
     * `no_circulation` yozuvlari). Boshqa yo'l yo'q va bu `down`
     * migratsiyasi — ya'ni ongli ravishda orqaga qaytarish.
     */
    await queryRunner.query(`
      DELETE FROM "alerts" WHERE "type" IN ('sensor_fault', 'no_circulation')
    `);
    await queryRunner.query(`
      ALTER TYPE "alerts_type_enum" RENAME TO "alerts_type_enum_old"
    `);
    await queryRunner.query(`
      CREATE TYPE "alerts_type_enum" AS ENUM
        ('offline', 'low_temperature', 'critical_temperature', 'overheat')
    `);
    await queryRunner.query(`
      ALTER TABLE "alerts"
        ALTER COLUMN "type" TYPE "alerts_type_enum"
        USING "type"::text::"alerts_type_enum"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "alerts_type_enum_old"`);
  }
}
