import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MASOFADAN YANGILASH (OTA).
 *
 * ESP32 v2.0.0 proshivkasi har 30 daqiqada serverdan so'raydi: «menga
 * yangi versiya bormi?». Bu migratsiya shu savolga javob berish va
 * tarqatishni BOSHQARISH uchun kerakli jadvallarni yasaydi.
 *
 * ⚠️⚠️ ENG MUHIM INVARIANT: BIR VAQTDA FAQAT BITTA `active` TARQATISH.
 * Ikkita faol tarqatish bitta qurilmaga IKKI XIL versiyani taklif
 * qilardi va qurilma ularni navbatma-navbat o'rnatib, cheksiz
 * «o'rnatish → qaytish → o'rnatish» halqasiga tushardi. Bu qoida
 * ILOVADA emas, BAZADA (qisman unique indeks) — chunki ilova kodida
 * tekshiruv qo'yilsa, ikki administrator bir vaqtda tugmani bosganda
 * poyga (race) tufayli ikkalasi ham o'tib ketardi.
 *
 * ⚠️⚠️ `.bin` FAYL BAZADA SAQLANMAYDI, faqat YO'LI. Fayl web
 * root'dan TASHQARIDA turadi (`FIRMWARE_DIR`) va u NestJS orqali,
 * token tekshirilgandan keyin oqim bilan beriladi. Sabab: proshivka
 * ichida qurilma tokeni bo'lishi mumkin — fayl ochiq papkada turganda
 * uni istalgan odam yuklab, tokenni ajratib olardi.
 */
export class FirmwareOta1763300000000 implements MigrationInterface {
  name = 'FirmwareOta1763300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ───────────────── 1. Proshivka relizlari ─────────────────
    /*
     * ⚠️ `version` UNIQUE — bitta versiya ikki marta yuklanmaydi (§9.2).
     * ⚠️ `sha256` HAM UNIQUE va bu ataylab: versiya raqami `.bin`
     * ichidagi `XONOBOD_FW_VERSION=x.y.z;` belgisidan O'QILADI, demak
     * bir xil baytlar = bir xil versiya. Ikki xil raqam bilan bir xil
     * fayl yuklansa, bu ANIQ xato (yig'ishni unutgan) va u shu yerda
     * to'xtaydi — aks holda «2.0.2 ga yangilandi» deb yozilib,
     * qurilmalarda aslida 2.0.1 ishlab turardi.
     */
    await queryRunner.query(`
      CREATE TABLE "firmware_releases" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        "version"        varchar(32)  NOT NULL,
        "file_path"      varchar(500) NOT NULL,
        "sha256"         varchar(64)  NOT NULL,
        "size"           integer      NOT NULL,
        "note"           varchar(1000),
        "uploaded_by_id" uuid,
        "is_archived"    boolean NOT NULL DEFAULT false,
        CONSTRAINT "UQ_firmware_releases_version" UNIQUE ("version"),
        CONSTRAINT "UQ_firmware_releases_sha256"  UNIQUE ("sha256"),
        /*
         * ⚠️ Hajm chegarasi BAZADA ham tekshiriladi: «min_spiffs» OTA
         * bo'limi 1 966 080 bayt va undan katta fayl qurilmaga
         * SIG'MAYDI. Tekshiruv faqat yuklash kodida bo'lsa, skript yoki
         * qo'lda INSERT orqali yaroqsiz reliz kirib, butun parkni
         * buzardi.
         */
        CONSTRAINT "CHK_firmware_releases_size"
          CHECK ("size" > 0 AND "size" <= 1966080),
        CONSTRAINT "FK_firmware_releases_user"
          FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id")
          ON DELETE SET NULL
      )
    `);

    // ───────────────── 2. Tarqatish (rollout) ─────────────────
    await queryRunner.query(`
      CREATE TYPE "firmware_rollouts_status_enum"
        AS ENUM ('active', 'paused', 'done', 'cancelled')
    `);

    /*
     * ⚠️ Maqsad turlari VILOYATGA moslashtirilgan. Texnik topshiriqda
     * (§9.3) «hammasi / tanlangan qurilmalar / muassasa turi (maktab,
     * bogcha)» deyilgan — Xonobod uchun. Andijon viloyatida 16 tuman
     * bor va eng tabiiy bosqichlash TUMAN bo'yicha: bitta tumanda
     * sinab ko'rib, keyin qolganiga tarqatiladi. Shuning uchun
     * `districts` qo'shildi, `object_types` esa bizdagi katalogga
     * (maktab/bog'cha/shifoxona…) bog'lanadi.
     */
    await queryRunner.query(`
      CREATE TYPE "firmware_rollouts_target_enum"
        AS ENUM ('all', 'districts', 'object_types', 'devices')
    `);

    await queryRunner.query(`
      CREATE TABLE "firmware_rollouts" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        "release_id"    uuid NOT NULL,
        "status"        "firmware_rollouts_status_enum"
                          NOT NULL DEFAULT 'active',
        "target_type"   "firmware_rollouts_target_enum" NOT NULL,
        "target_ids"    jsonb NOT NULL DEFAULT '[]'::jsonb,
        "max_devices"   integer,
        "note"          varchar(500),
        "created_by_id" uuid,
        "finished_at"   timestamptz,
        CONSTRAINT "FK_firmware_rollouts_release"
          FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_firmware_rollouts_user"
          FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
          ON DELETE SET NULL,
        /*
         * ⚠️ «Sinov rejimi» — «max_devices = 1». Chegara musbat
         * bo'lishi shart: 0 bo'lsa tarqatish jimgina hech kimga
         * tegmasdan «ishlayotgan» bo'lib turardi va administrator
         * nima uchun yangilanmayotganini soatlab qidirardi.
         */
        CONSTRAINT "CHK_firmware_rollouts_max_devices"
          CHECK ("max_devices" IS NULL OR "max_devices" > 0)
      )
    `);

    /*
     * ⚠️⚠️ BIR VAQTDA FAQAT BITTA FAOL TARQATISH — qisman unique
     * indeks. Indeks kaliti `status`, sharti esa `status = 'active'`:
     * demak indeksdagi BARCHA qatorlarning kaliti bir xil va
     * ikkinchisini qo'shib bo'lmaydi.
     *
     * Bu tekshiruvni ilova kodiga qo'yish YETARLI EMAS: ikki
     * administrator bir vaqtda «Tarqatishni boshlash» tugmasini bossa,
     * ikkala so'rov ham «faol tarqatish yo'q» deb ko'rib, ikkalasi ham
     * yozib ketardi.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_firmware_rollouts_one_active"
        ON "firmware_rollouts" ("status")
        WHERE "status" = 'active'
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_firmware_rollouts_release"
        ON "firmware_rollouts" ("release_id")
    `);

    // ───────────────── 3. Bloklash ─────────────────
    /*
     * ⚠️⚠️ BLOKLASH BO'LMASA PARK «QAYTISH HALQASI» GA TUSHADI.
     *
     * Yaroqsiz proshivka tarqatilsa, har bir qurilma: yuklab oladi →
     * o'rnatadi → qayta yuklanadi → serverga yubora olmaydi →
     * bootloader eskisiga qaytaradi → 30 daqiqadan keyin AYNI
     * versiyani YANA yuklab oladi. Cheksiz. Shu vaqt ichida qurilma
     * harorat o'lchashdan ko'proq yangilanish bilan shug'ullanadi.
     *
     * Qoida (§9.4): `rolled_back` kelsa YOKI ketma-ket 3 ta `failed`
     * kelsa, o'sha versiya o'sha qurilmaga BOSHQA taklif qilinmaydi.
     *
     * ⚠️ Kalit `(device_id, version)`, tarqatish ID'si EMAS: bir xil
     * versiya uchun yangi tarqatish yaratilsa, blok SAQLANIB qolishi
     * kerak — aks holda «qayta urinish» tugmasini bosmasdan, shunchaki
     * yangi tarqatish yasash bilan buzuq versiya qaytib kelardi.
     */
    await queryRunner.query(`
      CREATE TABLE "firmware_blocks" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "device_id"  uuid NOT NULL,
        "version"    varchar(32) NOT NULL,
        "fail_count" integer NOT NULL DEFAULT 0,
        "is_blocked" boolean NOT NULL DEFAULT false,
        "reason"     varchar(500),
        CONSTRAINT "UQ_firmware_blocks_device_version"
          UNIQUE ("device_id", "version"),
        CONSTRAINT "FK_firmware_blocks_device"
          FOREIGN KEY ("device_id") REFERENCES "devices"("id")
          ON DELETE CASCADE
      )
    `);

    // ───────────────── 4. OTA hodisalari ─────────────────
    /*
     * ⚠️ `checked` hodisasi YOZILMAYDI va bu ongli qaror. Qurilma har
     * 30 daqiqada tekshiradi: 2000 qurilma × 48 = kuniga 96 000 qator
     * — faqat «so'radi, yangilanish yo'q» degani uchun. Tekshiruv izi
     * `devices.last_check_at` da qoladi (§5 aynan shuni talab qiladi),
     * bu jadvalga esa faqat HAQIQIY o'zgarishlar tushadi.
     */
    await queryRunner.query(`
      CREATE TYPE "ota_events_status_enum"
        AS ENUM ('offered', 'installed', 'ok', 'failed', 'rolled_back')
    `);

    await queryRunner.query(`
      CREATE TABLE "ota_events" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "device_id"       uuid NOT NULL,
        "status"          "ota_events_status_enum" NOT NULL,
        "target_version"  varchar(32),
        "running_version" varchar(32),
        "message"         varchar(1000),
        "ip_address"      varchar(45),
        CONSTRAINT "FK_ota_events_device"
          FOREIGN KEY ("device_id") REFERENCES "devices"("id")
          ON DELETE CASCADE
      )
    `);

    /*
     * ⚠️ `(device_id, created_at DESC)` — «shu qurilmaning OTA tarixi»
     * va «shu qurilmaning oxirgi holati» so'rovlari uchun. Tarqatish
     * jarayoni ekrani har bir qurilma uchun oxirgi hodisani oladi va
     * bu indeksning boshidan o'qiladi.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_ota_events_device_time"
        ON "ota_events" ("device_id", "created_at" DESC)
    `);

    /* Versiya bo'yicha jarayon ko'rinishi uchun. */
    await queryRunner.query(`
      CREATE INDEX "IDX_ota_events_version_time"
        ON "ota_events" ("target_version", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ Teskari tartib: avval bog'liq jadvallar, keyin turlar.
    await queryRunner.query(`DROP TABLE IF EXISTS "ota_events"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "ota_events_status_enum"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "firmware_blocks"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "firmware_rollouts"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "firmware_rollouts_target_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "firmware_rollouts_status_enum"`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "firmware_releases"`);
  }
}
