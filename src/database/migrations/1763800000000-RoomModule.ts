import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * XONA HARORATI MODULI (ESP32 + DHT22) — ikkinchi qurilma turi.
 *
 * 1) `devices.module_type` — `boiler` | `room`. Mavjud qurilmalar
 *    `boiler`: hozirgacha dalada faqat qozonxona modullari bor edi.
 * 2) Plata yuboradigan joylashuv (`mfy`, `institution_name`,
 *    `object_type`) va oxirgi xona harorati / namligi — FAQAT ko'rsatish
 *    uchun. Ma'lumot yo'naltirishda ishlatilmaydi (§3: «institution_id ga
 *    ko'r-ko'rona ishonma») — kotyol hamon `boiler_id` orqali aniqlanadi.
 * 3) «Bitta kotyolga bitta modul» qoidasi endi faqat QOZONXONA moduliga:
 *    xona moduli kotyol holatiga tegmaydi, bitta binoda esa ular bir
 *    nechta bo'ladi (har sinfga bittadan).
 * 4) OTA: reliz va tarqatishning turi. Bir vaqtda HAR TUR uchun bitta
 *    faol tarqatish; versiya HAR TUR ichida yagona (xona 1.x va
 *    qozonxona 2.x mustaqil raqamlanadi).
 */
export class RoomModule1763800000000 implements MigrationInterface {
  name = 'RoomModule1763800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── 1–2. Qurilma ───
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD COLUMN "module_type" varchar(16) NOT NULL DEFAULT 'boiler',
        ADD COLUMN "reported_mfy" varchar(120),
        ADD COLUMN "reported_institution" varchar(120),
        ADD COLUMN "reported_object_type" varchar(32),
        ADD COLUMN "last_room_temperature" numeric(5,2),
        ADD COLUMN "last_humidity" numeric(5,2),
        ADD COLUMN "last_room_reading_at" timestamptz,
        ADD CONSTRAINT "CHK_devices_module_type"
          CHECK ("module_type" IN ('boiler', 'room'))
    `);

    // ─── 3. Bitta kotyolga bitta QOZONXONA moduli ───
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_devices_one_per_boiler"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_devices_one_boiler_module" ON "devices" ("boiler_id")
      WHERE "boiler_id" IS NOT NULL AND "module_type" = 'boiler'
    `);

    // ─── 4. OTA ───
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        ADD COLUMN "module_type" varchar(16) NOT NULL DEFAULT 'boiler',
        ADD CONSTRAINT "CHK_firmware_releases_module_type"
          CHECK ("module_type" IN ('boiler', 'room'))
    `);
    await queryRunner.query(
      `ALTER TABLE "firmware_releases" DROP CONSTRAINT "UQ_firmware_releases_version"`,
    );
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        ADD CONSTRAINT "UQ_firmware_releases_type_version" UNIQUE ("module_type", "version")
    `);

    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        ADD COLUMN "module_type" varchar(16) NOT NULL DEFAULT 'boiler',
        ADD CONSTRAINT "CHK_firmware_rollouts_module_type"
          CHECK ("module_type" IN ('boiler', 'room'))
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_firmware_rollouts_one_active"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_firmware_rollouts_one_active" ON "firmware_rollouts" ("module_type")
      WHERE "status" = 'active'
    `);
  }

  /**
   * ⚠️ Xona moduli yoki xona relizi bor bo'lsa, orqaga qaytarish TO'XTAYDI:
   * ularni jimgina «qozonxona» deb qayta belgilash OTA'da qozonxona
   * proshivkasini xona moduliga yo'l ochardi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "devices" WHERE "module_type" <> 'boiler') AS devices,
        (SELECT COUNT(*)::int FROM "firmware_releases" WHERE "module_type" <> 'boiler') AS releases
    `)) as Array<{ devices: number; releases: number }>;
    const blockers = rows[0];
    if (blockers && (blockers.devices > 0 || blockers.releases > 0)) {
      throw new Error(
        `Orqaga qaytarib bo'lmaydi: ${blockers.devices} ta xona moduli va ` +
          `${blockers.releases} ta xona relizi bor — avval ularni o'chiring`,
      );
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_firmware_rollouts_one_active"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_firmware_rollouts_one_active" ON "firmware_rollouts" ("status")
      WHERE "status" = 'active'
    `);
    await queryRunner.query(`
      ALTER TABLE "firmware_rollouts"
        DROP CONSTRAINT "CHK_firmware_rollouts_module_type",
        DROP COLUMN "module_type"
    `);

    await queryRunner.query(
      `ALTER TABLE "firmware_releases" DROP CONSTRAINT "UQ_firmware_releases_type_version"`,
    );
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        ADD CONSTRAINT "UQ_firmware_releases_version" UNIQUE ("version")
    `);
    await queryRunner.query(`
      ALTER TABLE "firmware_releases"
        DROP CONSTRAINT "CHK_firmware_releases_module_type",
        DROP COLUMN "module_type"
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_devices_one_boiler_module"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_devices_one_per_boiler" ON "devices" ("boiler_id")
      WHERE "boiler_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP CONSTRAINT "CHK_devices_module_type",
        DROP COLUMN "module_type",
        DROP COLUMN "reported_mfy",
        DROP COLUMN "reported_institution",
        DROP COLUMN "reported_object_type",
        DROP COLUMN "last_room_temperature",
        DROP COLUMN "last_humidity",
        DROP COLUMN "last_room_reading_at"
    `);
  }
}
