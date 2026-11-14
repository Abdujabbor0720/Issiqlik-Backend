import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * XONA (HAVO) HARORATI.
 *
 * ⚠️⚠️ NIMA UCHUN KERAK. Tizim shu paytgacha faqat QUVURDAGI suvni
 * o'lchardi. Qozon 70 °C bersa ham, radiatori yorilgan yoki derazasi
 * sinib yotgan sinfxona sovuq bo'ladi — va buni hech qaysi ko'rsatkich
 * ko'rsatmasdi. Bolalar o'tirgan xonaning harorati — oxir-oqibat butun
 * tizimning maqsadi.
 *
 * TUZILMA:
 *   • `rooms`         — xona: kotyolga (binoga) tegishli, datchik
 *                       kaliti bilan aniqlanadi;
 *   • `room_readings` — xona tarixi (SIYRAKLASHTIRILGAN, pastga qarang);
 *   • `system_settings` — me'yor (25 °C) va minimum (15 °C);
 *   • `alerts.room_id` — xona ogohlantirishi kotyolnikidan ALOHIDA.
 */
export class RoomTemperature1763500000000 implements MigrationInterface {
  name = 'RoomTemperature1763500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ───────────── 1. Xonalar ─────────────
    /*
     * ⚠️⚠️ XONA KOTYOLGA (BINOGA) TEGISHLI, QURILMAGA EMAS.
     * Plata buzilib almashtirilsa, datchiklar o'sha simlarda qoladi va
     * ularning manzillari (`sensor_key`) o'zgarmaydi. Xona qurilmaga
     * bog'langanda, plata almashtirilgan kuni «1-sinf», «Direktor
     * xonasi» kabi nomlar yo'qolib, xonalar «Xona 1, Xona 2» bo'lib
     * qaytadan yaratilardi va tarix ikkiga bo'linardi.
     *
     * ⚠️ `(boiler_id, sensor_key)` YAGONA: bitta datchik bitta binoda
     * ikki xona bo'lolmaydi — parallel kelgan ikki signal ikkita
     * «Xona 1» yarata olmaydi (baza darajasida taqiqlangan).
     *
     * ⚠️ `sensor_key` shakli CHECK bilan: kalit URL va jurnalga tushadi.
     * Servis uni allaqachon normallashtiradi (`normalizeRoomKey`), bu
     * esa — qo'lda yozilgan SQL uchun ikkinchi qavat.
     *
     * ⚠️ `is_monitored = false` — xona ko'rinadi, lekin O'RTACHAGA ham,
     * OGOHLANTIRISHGA ham kirmaydi. Masalan qozonxona xonasidagi datchik
     * (u yerda doim issiq) yoki ta'mirdagi xona. Xonani o'chirish emas,
     * chunki datchik baribir yuborishda davom etadi va xona ertasiga
     * yana avtomatik yaratilardi.
     */
    await queryRunner.query(`
      CREATE TABLE "rooms" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        "boiler_id"        uuid NOT NULL
                             REFERENCES "boilers"("id") ON DELETE CASCADE,
        "sensor_key"       varchar(64) NOT NULL,
        "name"             varchar(120) NOT NULL,
        "note"             varchar(400),
        "sort_order"       int NOT NULL DEFAULT 0,
        "is_auto_created"  boolean NOT NULL DEFAULT false,
        "is_monitored"     boolean NOT NULL DEFAULT true,
        "last_temperature" numeric(6,2),
        "last_reading_at"  timestamptz,
        "last_logged_at"   timestamptz,
        CONSTRAINT "CHK_rooms_sensor_key"
          CHECK ("sensor_key" ~ '^[a-z0-9][a-z0-9._:-]*$'),
        CONSTRAINT "CHK_rooms_name"
          CHECK (length(btrim("name")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rooms_boiler_sensor"
        ON "rooms" ("boiler_id", "sensor_key")
    `);

    // ───────────── 2. Xona tarixi ─────────────
    /*
     * ⚠️⚠️ SIYRAKLASHTIRILGAN TARIX. Qurilma har daqiqada yuboradi;
     * 2000 kotyol × 10 xona × 1440 = kuniga 28 mln qator bo'lardi.
     * Shuning uchun tarixga har xonadan `room_sample_minutes` da
     * (sukut 10) bitta qator yoziladi. JORIY qiymat (`rooms.last_*`)
     * esa har signalda yangilanadi — xarita kechikmaydi.
     *
     * ⚠️ Jadval ataylab TOR: `updated_at` yo'q (qator o'zgarmaydi),
     * `boiler_id` yo'q (xona orqali olinadi va grafik so'rovi
     * `room_id` bo'yicha boradi).
     *
     * ⚠️ `(room_id, recorded_at DESC)` — grafik so'rovi indeksning
     * boshidan o'qiydi; `(recorded_at)` — kunlik tozalash uchun.
     */
    await queryRunner.query(`
      CREATE TABLE "room_readings" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "room_id"     uuid NOT NULL
                        REFERENCES "rooms"("id") ON DELETE CASCADE,
        "temperature" numeric(6,2) NOT NULL,
        "recorded_at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_room_readings_room_time"
        ON "room_readings" ("room_id", "recorded_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_room_readings_recorded_at"
        ON "room_readings" ("recorded_at")
    `);

    // ───────────── 3. Sozlamalar ─────────────
    /*
     * ⚠️ Sukut qiymatlari — buyurtmachining talabi: me'yor 25 °C,
     * eng past 15 °C. Ikkalasi ham kabinetdan o'zgartiriladi.
     *
     * ⚠️ `room_min_c < room_norm_c` — CHECK bilan: teskarisi
     * qo'yilsa, «salqin» oraliq manfiy bo'lib, xona bir vaqtda ham
     * sovuq, ham me'yorda ko'rinardi.
     */
    await queryRunner.query(`
      ALTER TABLE "system_settings"
        ADD COLUMN "room_min_c"          numeric(5,2) NOT NULL DEFAULT 15,
        ADD COLUMN "room_norm_c"         numeric(5,2) NOT NULL DEFAULT 25,
        ADD COLUMN "room_sample_minutes" int NOT NULL DEFAULT 10,
        ADD CONSTRAINT "CHK_system_settings_room_range"
          CHECK ("room_min_c" >= -40 AND "room_norm_c" <= 70
                 AND "room_min_c" < "room_norm_c"),
        ADD CONSTRAINT "CHK_system_settings_room_sample"
          CHECK ("room_sample_minutes" BETWEEN 1 AND 1440)
    `);

    // ───────────── 4. Ogohlantirishlar ─────────────
    /*
     * ⚠️ `ADD VALUE` tranzaksiya ichida ishlaydi (PG12+), lekin yangi
     * qiymatni AYNI tranzaksiyada ENUM sifatida ishlatib bo'lmaydi.
     * Pastdagi CHECK uni `::text` bilan solishtiradi — enum'ga
     * o'girilmaydi, ya'ni bu cheklovga tushmaydi.
     */
    await queryRunner.query(`
      ALTER TYPE "alerts_type_enum" ADD VALUE IF NOT EXISTS 'room_cold'
    `);

    await queryRunner.query(`
      ALTER TABLE "alerts"
        ADD COLUMN "room_id" uuid
          REFERENCES "rooms"("id") ON DELETE CASCADE
    `);
    /*
     * ⚠️ Oddiy indeks ham kerak: xona o'chirilganda `ON DELETE CASCADE`
     * uning ogohlantirishlarini qidiradi va indekssiz butun `alerts`
     * jadvalini skanerlardi. Qisman yagona indeks faqat OCHIQ
     * qatorlarni qamraydi — yopilganlarini topa olmaydi.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_alerts_room_id" ON "alerts" ("room_id")
    `);

    /*
     * ⚠️⚠️ XONA TURI ⇔ XONA BOR. Xona ogohlantirishi xonasiz yoki
     * kotyol ogohlantirishi xona bilan yozilsa, quyidagi ikki yagona
     * indeks noto'g'ri to'plamni qo'riqlab qolardi.
     */
    await queryRunner.query(`
      ALTER TABLE "alerts"
        ADD CONSTRAINT "CHK_alerts_room_type"
          CHECK (("type"::text = 'room_cold') = ("room_id" IS NOT NULL))
    `);

    /*
     * ⚠️⚠️ YAGONALIK IKKIGA BO'LINADI.
     *
     * Eski indeks `(boiler_id, type)` edi. U shundayligicha qolsa,
     * bitta binoda IKKI xona bir vaqtda sovuq bo'lolmasdi — ikkinchisi
     * yagonalik xatosiga urilib, jimgina yo'qolardi.
     *
     * `room_id` ni shunchaki indeksga qo'shib bo'lmaydi: PostgreSQL
     * `NULL` larni TENG deb hisoblamaydi va kotyol ogohlantirishlari
     * (`room_id IS NULL`) yagonaligini YO'QOTARDI. Shuning uchun ikkita
     * QISMAN indeks — har biri o'z to'plami uchun.
     */
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_alerts_open_per_type"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_alerts_open_per_type"
        ON "alerts" ("boiler_id", "type")
        WHERE "state" IN ('open', 'acknowledged') AND "room_id" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_alerts_open_per_room"
        ON "alerts" ("room_id", "type")
        WHERE "state" IN ('open', 'acknowledged') AND "room_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /*
     * ⚠️ Xona ogohlantirishlari AVVAL o'chiriladi: ular eski enum'da
     * ifodalanmaydi va `USING` o'girmasi xato bilan to'xtardi. Bu
     * ongli ravishda orqaga qaytarishdagi MA'LUMOT YO'QOLISHI.
     */
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_alerts_open_per_room"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_alerts_open_per_type"`);
    await queryRunner.query(
      `ALTER TABLE "alerts" DROP CONSTRAINT IF EXISTS "CHK_alerts_room_type"`,
    );
    await queryRunner.query(`DELETE FROM "alerts" WHERE "room_id" IS NOT NULL`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alerts_room_id"`);
    await queryRunner.query(
      `ALTER TABLE "alerts" DROP COLUMN IF EXISTS "room_id"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_alerts_open_per_type"
        ON "alerts" ("boiler_id", "type")
        WHERE "state" IN ('open', 'acknowledged')
    `);

    await queryRunner.query(`
      ALTER TYPE "alerts_type_enum" RENAME TO "alerts_type_enum_old"
    `);
    await queryRunner.query(`
      CREATE TYPE "alerts_type_enum" AS ENUM
        ('offline', 'low_temperature', 'critical_temperature', 'overheat',
         'sensor_fault', 'no_circulation')
    `);
    await queryRunner.query(`
      ALTER TABLE "alerts"
        ALTER COLUMN "type" TYPE "alerts_type_enum"
        USING "type"::text::"alerts_type_enum"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "alerts_type_enum_old"`);

    await queryRunner.query(`
      ALTER TABLE "system_settings"
        DROP CONSTRAINT IF EXISTS "CHK_system_settings_room_sample",
        DROP CONSTRAINT IF EXISTS "CHK_system_settings_room_range",
        DROP COLUMN IF EXISTS "room_sample_minutes",
        DROP COLUMN IF EXISTS "room_norm_c",
        DROP COLUMN IF EXISTS "room_min_c"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "room_readings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rooms"`);
  }
}
