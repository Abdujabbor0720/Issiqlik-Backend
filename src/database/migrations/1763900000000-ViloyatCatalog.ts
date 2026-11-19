import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VILOYAT DARAJASI: tumanlar kaliti, MFY katalogi, muassasalar katalogi va
 * qurilma turlarining kontraktdagi nomlari.
 *
 * 1) `districts.key` — PROSHIVKADA QOTIRILGAN tuman kaliti (`andijon-sh`,
 *    `xonobod-sh`, `boz`, …). Ichki `code` (`andijon_sh`) va UUID `id`
 *    o'zgarmaydi: ularga 10 dan ortiq jadval ishora qiladi va PK'ni
 *    almashtirish har birini qayta yozishni talab qilardi. `key` — noyob
 *    tabiiy kalit, yangi jadvallar (`mahallas`, `organizations`) aynan unga
 *    FK bilan bog'lanadi.
 * 2) `mahallas` — MFYlar katalogi (`district_key`, `name`). Ma'lumot
 *    `npm run import:mfy` bilan `andijon-tumanlar-mfylar.json` dan yoziladi.
 * 3) `organizations` = MUASSASALAR KATALOGI: endi har yozuv tumanga
 *    tegishli (`district_key`) va ixtiyoriy MFYga (`mahalla_id`). Nom
 *    yagonaligi TUMAN ICHIDA: «12-maktab» har tumanda bor.
 *    ⚠️ Mavjud yozuvlar O'CHIRILMAYDI: har biri o'zini ishlatgan kotyollar
 *    tumaniga biriktiriladi. Bir nechta tumandagi kotyollar ishlatgan yozuv
 *    har tuman uchun alohida katalog yozuviga ajratiladi va kotyollar o'z
 *    tumanidagi nusxaga ko'chiriladi — birorta kotyol muassasasiz qolmaydi.
 * 4) `module_type` → `device_type`, qiymatlar `boiler/room` → `kotyol/xona`
 *    (qurilma kontraktidagi so'zlar). Ma'lumot yo'qotilmaydi: ustun qayta
 *    nomlanadi va qiymatlar joyida tarjima qilinadi.
 * 5) Qurilmaning PANELDAGI muassasasi (`devices.organization_id`) va oxirgi
 *    ishlatgan token turi (`last_token_kind`).
 * 6) «Yangi qurilmalar» ro'yxatiga tur, plata aytgan joylashuv va token izi.
 * 7) Telemetriyada xona harorati va namlik (qurilma darajasidagi grafik).
 */
export class ViloyatCatalog1763900000000 implements MigrationInterface {
  name = 'ViloyatCatalog1763900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── 1. Tuman kaliti ───
    await queryRunner.query(
      `ALTER TABLE "districts" ADD COLUMN "key" varchar(32)`,
    );
    await queryRunner.query(
      `UPDATE "districts" SET "key" = replace("code", '_', '-')`,
    );
    await queryRunner.query(
      `ALTER TABLE "districts" ALTER COLUMN "key" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "districts"
        ADD CONSTRAINT "UQ_districts_key" UNIQUE ("key"),
        ADD CONSTRAINT "CHK_districts_key" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,31}$')
    `);

    // ─── 2. MFYlar ───
    await queryRunner.query(`
      CREATE TABLE "mahallas" (
        "id"           uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        "district_key" varchar(32)  NOT NULL,
        "name"         varchar(160) NOT NULL,
        "is_archived"  boolean      NOT NULL DEFAULT false,
        CONSTRAINT "PK_mahallas" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mahallas_district" FOREIGN KEY ("district_key")
          REFERENCES "districts"("key") ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_mahallas_district_name"
        ON "mahallas" ("district_key", lower("name"))
    `);

    // ─── 3. Muassasalar katalogi ───
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "UQ_organizations_name"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_organizations_name"`);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN "district_key" varchar(32),
        ADD COLUMN "mahalla_id" uuid,
        ADD CONSTRAINT "FK_organizations_district" FOREIGN KEY ("district_key")
          REFERENCES "districts"("key") ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD CONSTRAINT "FK_organizations_mahalla" FOREIGN KEY ("mahalla_id")
          REFERENCES "mahallas"("id") ON DELETE SET NULL
    `);

    /*
     * ⚠️ Har muassasa — uni ishlatgan kotyollarning ENG KO'P uchragan
     * tumaniga. Qolgan tumanlar uchun nusxa yaratilib, o'sha tumandagi
     * kotyollar nusxaga ko'chiriladi.
     */
    await queryRunner.query(`
      DO $$
      DECLARE
        pair record;
        clone_id uuid;
      BEGIN
        FOR pair IN
          SELECT u.organization_id, u.district_key, u.district_id, u.rn
          FROM (
            SELECT b.organization_id,
                   d."key" AS district_key,
                   d.id    AS district_id,
                   ROW_NUMBER() OVER (
                     PARTITION BY b.organization_id
                     ORDER BY COUNT(*) DESC, d."key"
                   ) AS rn
            FROM "boilers" b
            JOIN "districts" d ON d.id = b.district_id
            WHERE b.organization_id IS NOT NULL
            GROUP BY b.organization_id, d."key", d.id
          ) u
          ORDER BY u.organization_id, u.rn
        LOOP
          IF pair.rn = 1 THEN
            UPDATE "organizations" SET "district_key" = pair.district_key
             WHERE id = pair.organization_id;
          ELSE
            INSERT INTO "organizations"
              ("name", "note", "is_archived", "object_type_id", "phone", "district_key")
            SELECT o."name", o."note", o."is_archived", o."object_type_id", o."phone",
                   pair.district_key
              FROM "organizations" o WHERE o.id = pair.organization_id
            RETURNING id INTO clone_id;

            UPDATE "boilers" SET "organization_id" = clone_id
             WHERE "organization_id" = pair.organization_id
               AND "district_id" = pair.district_id;
          END IF;
        END LOOP;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_organizations_district_name"
        ON "organizations" (COALESCE("district_key", ''), "name")
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_organizations_district_key" ON "organizations" ("district_key")`,
    );

    // ─── 4. Qurilma turi: module_type → device_type ───
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "CHK_devices_module_type"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_devices_one_boiler_module"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME COLUMN "module_type" TO "device_type"`,
    );
    await queryRunner.query(`
      UPDATE "devices"
         SET "device_type" = CASE "device_type" WHEN 'room' THEN 'xona' ELSE 'kotyol' END
    `);
    await queryRunner.query(`
      ALTER TABLE "devices"
        ALTER COLUMN "device_type" SET DEFAULT 'kotyol',
        ADD CONSTRAINT "CHK_devices_device_type" CHECK ("device_type" IN ('kotyol', 'xona'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_devices_one_kotyol_module" ON "devices" ("boiler_id")
      WHERE "boiler_id" IS NOT NULL AND "device_type" = 'kotyol'
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_devices_device_type" ON "devices" ("device_type")`,
    );

    // ─── 5. Paneldagi muassasa va token turi ───
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD COLUMN "organization_id" uuid,
        ADD COLUMN "last_token_kind" varchar(16),
        ADD CONSTRAINT "FK_devices_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE SET NULL,
        ADD CONSTRAINT "CHK_devices_last_token_kind"
          CHECK ("last_token_kind" IS NULL OR "last_token_kind" IN ('personal', 'shared'))
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_devices_organization_id" ON "devices" ("organization_id")`,
    );

    /*
     * ⚠️ `reported_district` endi KANONIK KALIT saqlaydi (taklif sifatida
     * ko'rsatiladi). Tanilgan xom qiymatlar kalitga aylantiriladi, tanilmagani
     * tozalanadi (spetsifikatsiya: noma'lum kalit e'tiborsiz qoldiriladi).
     */
    await queryRunner.query(`
      UPDATE "devices" dv SET "reported_district" = d."key"
        FROM "districts" d
       WHERE dv."reported_district" IS NOT NULL
         AND (lower(dv."reported_district") IN (d."key", d."code", lower(d."name"))
              OR dv."reported_district" = d."soato"
              OR (lower(dv."reported_district") = 'boston' AND d."key" = 'boz'))
    `);
    await queryRunner.query(`
      UPDATE "devices" SET "reported_district" = NULL
       WHERE "reported_district" IS NOT NULL
         AND "reported_district" NOT IN (SELECT "key" FROM "districts")
    `);
    await queryRunner.query(`
      UPDATE "devices" SET "reported_object_type" = NULL
       WHERE "reported_object_type" IS NOT NULL
         AND "reported_object_type" NOT IN (SELECT "code" FROM "object_types")
    `);

    // ─── 6. OTA: relizlar va tarqatishlar ───
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        DROP CONSTRAINT IF EXISTS "CHK_firmware_releases_module_type",
        DROP CONSTRAINT IF EXISTS "UQ_firmware_releases_type_version"
    `);
    await queryRunner.query(
      `ALTER TABLE "firmware_releases" RENAME COLUMN "module_type" TO "device_type"`,
    );
    await queryRunner.query(`
      UPDATE "firmware_releases"
         SET "device_type" = CASE "device_type" WHEN 'room' THEN 'xona' ELSE 'kotyol' END
    `);
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        ALTER COLUMN "device_type" SET DEFAULT 'kotyol',
        ADD COLUMN "type_source" varchar(16) NOT NULL DEFAULT 'marker',
        ADD COLUMN "marker_prefix" varchar(32),
        ADD CONSTRAINT "CHK_firmware_releases_device_type"
          CHECK ("device_type" IN ('kotyol', 'xona')),
        ADD CONSTRAINT "CHK_firmware_releases_type_source"
          CHECK ("type_source" IN ('marker', 'manual')),
        ADD CONSTRAINT "UQ_firmware_releases_type_version" UNIQUE ("device_type", "version")
    `);

    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        DROP CONSTRAINT IF EXISTS "CHK_firmware_rollouts_module_type"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_firmware_rollouts_one_active"`,
    );
    await queryRunner.query(
      `ALTER TABLE "firmware_rollouts" RENAME COLUMN "module_type" TO "device_type"`,
    );
    await queryRunner.query(`
      UPDATE "firmware_rollouts"
         SET "device_type" = CASE "device_type" WHEN 'room' THEN 'xona' ELSE 'kotyol' END
    `);
    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        ALTER COLUMN "device_type" SET DEFAULT 'kotyol',
        ADD CONSTRAINT "CHK_firmware_rollouts_device_type"
          CHECK ("device_type" IN ('kotyol', 'xona'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_firmware_rollouts_one_active" ON "firmware_rollouts" ("device_type")
      WHERE "status" = 'active'
    `);

    // ─── 7. «Yangi qurilmalar» ───
    await queryRunner.query(`
      ALTER TABLE "pending_devices"
        ADD COLUMN "device_type" varchar(16),
        ADD COLUMN "reported_district" varchar(32),
        ADD COLUMN "reported_object_type" varchar(32),
        ADD COLUMN "reported_institution" varchar(120),
        ADD COLUMN "token_hash" varchar(64),
        ADD COLUMN "token_preview" varchar(12),
        ADD COLUMN "token_kind" varchar(16),
        ADD COLUMN "token_conflict" boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT "CHK_pending_devices_device_type"
          CHECK ("device_type" IS NULL OR "device_type" IN ('kotyol', 'xona')),
        ADD CONSTRAINT "CHK_pending_devices_token_kind"
          CHECK ("token_kind" IS NULL OR "token_kind" IN ('personal', 'shared'))
    `);

    // ─── 8. Telemetriya: xona harorati va namlik ───
    await queryRunner.query(`
      ALTER TABLE "telemetry_readings"
        ADD COLUMN "room_temperature" numeric(5,2),
        ADD COLUMN "humidity" numeric(5,2),
        ADD CONSTRAINT "CHK_telemetry_humidity"
          CHECK ("humidity" IS NULL OR ("humidity" >= 0 AND "humidity" <= 100))
    `);
    // ⚠️ Xona o'lchovida quvur datchigi yo'q — `probe` ma'nosiz.
    await queryRunner.query(
      `ALTER TABLE "telemetry_readings" ALTER COLUMN "probe" DROP NOT NULL`,
    );
  }

  /**
   * ⚠️ Orqaga qaytarish faqat muassasa nomlari GLOBAL yagona bo'lsa mumkin:
   * aks holda eski `UQ_organizations_name` cheklovini tiklab bo'lmaydi va
   * qaysi nusxani o'chirishni migratsiya o'zi hal qilmasligi kerak.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const dup = (await queryRunner.query(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "name" FROM "organizations" GROUP BY "name" HAVING COUNT(*) > 1
      ) t
    `)) as Array<{ n: number }>;
    if (dup[0] && dup[0].n > 0) {
      throw new Error(
        `Orqaga qaytarib bo'lmaydi: ${dup[0].n} ta muassasa nomi bir nechta tumanda bor`,
      );
    }

    await queryRunner.query(
      `DELETE FROM "telemetry_readings" WHERE "probe" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "telemetry_readings" ALTER COLUMN "probe" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "telemetry_readings"
        DROP CONSTRAINT "CHK_telemetry_humidity",
        DROP COLUMN "room_temperature",
        DROP COLUMN "humidity"
    `);

    await queryRunner.query(`
      ALTER TABLE "pending_devices"
        DROP CONSTRAINT "CHK_pending_devices_device_type",
        DROP CONSTRAINT "CHK_pending_devices_token_kind",
        DROP COLUMN "device_type",
        DROP COLUMN "reported_district",
        DROP COLUMN "reported_object_type",
        DROP COLUMN "reported_institution",
        DROP COLUMN "token_hash",
        DROP COLUMN "token_preview",
        DROP COLUMN "token_kind",
        DROP COLUMN "token_conflict"
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_firmware_rollouts_one_active"`,
    );
    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        DROP CONSTRAINT "CHK_firmware_rollouts_device_type",
        ALTER COLUMN "device_type" SET DEFAULT 'boiler'
    `);
    await queryRunner.query(`
      UPDATE "firmware_rollouts"
         SET "device_type" = CASE "device_type" WHEN 'xona' THEN 'room' ELSE 'boiler' END
    `);
    await queryRunner.query(
      `ALTER TABLE "firmware_rollouts" RENAME COLUMN "device_type" TO "module_type"`,
    );
    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        ADD CONSTRAINT "CHK_firmware_rollouts_module_type"
          CHECK ("module_type" IN ('boiler', 'room'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_firmware_rollouts_one_active" ON "firmware_rollouts" ("module_type")
      WHERE "status" = 'active'
    `);

    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        DROP CONSTRAINT "UQ_firmware_releases_type_version",
        DROP CONSTRAINT "CHK_firmware_releases_type_source",
        DROP CONSTRAINT "CHK_firmware_releases_device_type",
        DROP COLUMN "type_source",
        DROP COLUMN "marker_prefix",
        ALTER COLUMN "device_type" SET DEFAULT 'boiler'
    `);
    await queryRunner.query(`
      UPDATE "firmware_releases"
         SET "device_type" = CASE "device_type" WHEN 'xona' THEN 'room' ELSE 'boiler' END
    `);
    await queryRunner.query(
      `ALTER TABLE "firmware_releases" RENAME COLUMN "device_type" TO "module_type"`,
    );
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        ADD CONSTRAINT "CHK_firmware_releases_module_type"
          CHECK ("module_type" IN ('boiler', 'room')),
        ADD CONSTRAINT "UQ_firmware_releases_type_version" UNIQUE ("module_type", "version")
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_devices_organization_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP CONSTRAINT "CHK_devices_last_token_kind",
        DROP CONSTRAINT "FK_devices_organization",
        DROP COLUMN "organization_id",
        DROP COLUMN "last_token_kind"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_devices_device_type"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_devices_one_kotyol_module"`,
    );
    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP CONSTRAINT "CHK_devices_device_type",
        ALTER COLUMN "device_type" SET DEFAULT 'boiler'
    `);
    await queryRunner.query(`
      UPDATE "devices"
         SET "device_type" = CASE "device_type" WHEN 'xona' THEN 'room' ELSE 'boiler' END
    `);
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME COLUMN "device_type" TO "module_type"`,
    );
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD CONSTRAINT "CHK_devices_module_type" CHECK ("module_type" IN ('boiler', 'room'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_devices_one_boiler_module" ON "devices" ("boiler_id")
      WHERE "boiler_id" IS NOT NULL AND "module_type" = 'boiler'
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_organizations_district_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_organizations_district_name"`,
    );
    await queryRunner.query(`
      ALTER TABLE "organizations"
        DROP CONSTRAINT "FK_organizations_mahalla",
        DROP CONSTRAINT "FK_organizations_district",
        DROP COLUMN "mahalla_id",
        DROP COLUMN "district_key"
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations" ADD CONSTRAINT "UQ_organizations_name" UNIQUE ("name")
    `);

    await queryRunner.query(`DROP TABLE "mahallas"`);
    await queryRunner.query(`
      ALTER TABLE "districts"
        DROP CONSTRAINT "CHK_districts_key",
        DROP CONSTRAINT "UQ_districts_key",
        DROP COLUMN "key"
    `);
  }
}
