import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OBYEKT TURI — qotirilgan ro'yxatdan KATALOGGA.
 *
 * ⚠️⚠️ Ilgari tur `organizations.kind` ustunida matn bo'lib turardi va
 * ruxsat etilgan qiymatlar kodga qotirilgan edi. Yangi tur qo'shish
 * uchun migratsiya + backend relizi + frontend relizi kerak bo'lardi —
 * holbuki «sport maktabi» yoki «tibbiyot punkti» qo'shish MA'MURIY
 * qaror, dasturchi ishi emas. Endi tur boshqa kataloglar kabi
 * jadvalda va admin uni o'zi to'ldiradi.
 *
 * ⚠️ MA'LUMOT YO'QOLMAYDI: migratsiya avval turlarni yozadi, keyin
 * mavjud tashkilotlarni `kind` KALITI bo'yicha ularga bog'laydi va
 * faqat SHUNDAN KEYIN eski ustunni olib tashlaydi. Ketma-ketlik
 * buzilsa (avval ustun olib tashlansa), tashkilotlarning turi
 * qaytarib bo'lmas tarzda yo'qolardi.
 */
export class ObjectTypesCatalog1763100000000 implements MigrationInterface {
  name = 'ObjectTypesCatalog1763100000000';

  /** Boshlang'ich turlar — eski qotirilgan ro'yxat bilan AYNI. */
  private static readonly DEFAULTS: Array<[code: string, name: string]> = [
    ['school', 'Maktab'],
    ['kindergarten', 'Bog‘cha'],
    ['hospital', 'Shifoxona'],
    ['clinic', 'Poliklinika'],
    ['college', 'Kollej'],
    ['admin', 'Ma‘muriy bino'],
    ['residential', 'Turar-joy'],
    ['other', 'Boshqa'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─────────── 1. Katalog jadvali ───────────
    await queryRunner.query(`
      CREATE TABLE "object_types" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "name"        varchar(180) NOT NULL,
        "code"        varchar(40)  NOT NULL,
        "note"        varchar(500),
        "is_archived" boolean NOT NULL DEFAULT false,
        CONSTRAINT "UQ_object_types_name" UNIQUE ("name"),
        CONSTRAINT "UQ_object_types_code" UNIQUE ("code")
      )
    `);

    // ─────────── 2. Boshlang'ich turlar ───────────
    for (const [code, name] of ObjectTypesCatalog1763100000000.DEFAULTS) {
      await queryRunner.query(
        `INSERT INTO "object_types" ("code", "name") VALUES ($1, $2)`,
        [code, name],
      );
    }

    // ─────────── 3. Tashkilotga ishora ustuni ───────────
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ADD COLUMN "object_type_id" uuid,
      ADD CONSTRAINT "FK_organizations_object_type"
        FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id")
        ON DELETE SET NULL
    `);

    /*
     * ─────────── 4. MA'LUMOTNI KO'CHIRISH ───────────
     * ⚠️ Mos keluvchi kalit topilmasa, tashkilot `other` ga
     * bog'lanadi — `NULL` qoldirilmaydi. Turi bo'sh tashkilot
     * hisobotda «turkumsiz» bo'lib osilib qolardi va uni qo'lda
     * qidirib topish kerak bo'lardi.
     */
    await queryRunner.query(`
      UPDATE "organizations" o
      SET "object_type_id" = COALESCE(
        (SELECT t."id" FROM "object_types" t WHERE t."code" = o."kind"),
        (SELECT t."id" FROM "object_types" t WHERE t."code" = 'other')
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_organizations_object_type"
      ON "organizations" ("object_type_id")
    `);

    // ─────────── 5. Eski ustun ───────────
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "kind"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ Teskari tartib: avval eski ustun tiklanadi va TO'LDIRILADI,
    // keyingina yangi tuzilma olib tashlanadi.
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ADD COLUMN "kind" varchar(40) NOT NULL DEFAULT 'other'
    `);
    await queryRunner.query(`
      UPDATE "organizations" o
      SET "kind" = COALESCE(
        (SELECT t."code" FROM "object_types" t WHERE t."id" = o."object_type_id"),
        'other'
      )
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_organizations_object_type"`,
    );
    await queryRunner.query(`
      ALTER TABLE "organizations"
      DROP CONSTRAINT IF EXISTS "FK_organizations_object_type",
      DROP COLUMN IF EXISTS "object_type_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "object_types"`);
  }
}
