import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QURILMA TUMANI — plata o'zi yuboradi, kabinetda O'ZGARTIRILMAYDI.
 *
 * ⚠️⚠️ BIZNES QARORI (2026-11-14):
 *   • plata sozlash menyusida montajchi tumanni TANLAYDI va plata uni
 *     har signalda yuboradi (`district`: SOATO kodi);
 *   • kabinetda tumanni HECH KIM tahrirlay olmaydi;
 *   • modul faqat O'Z tumanidagi kotyolga biriktiriladi;
 *   • biriktirilmagan modulni faqat o'sha tuman mas'uli (va admin) ko'radi;
 *   • plata qayta sozlanib boshqa tuman tanlansa, u eski tumandagi
 *     kotyoldan AVTOMATIK ajratiladi.
 *
 * ⚠️ `district_id` — `NULL` bo'lishi mumkin: eski proshivka tuman
 * yubormaydi. Bunday modul avvalgidek ishlaydi, uning tumani biriktirilgan
 * kotyoldan olinadi.
 *
 * ⚠️ `ON DELETE SET NULL`: tuman o'chirilsa (amalda bo'lmaydi) qurilma
 * o'chib ketmasligi kerak.
 *
 * ⚠️ `reported_district` — plata yuborgan XOM qiymat. Server uni
 * taniy olmasa (masalan noto'g'ri kod), `district_id` o'zgarmaydi, xom
 * qiymat esa kabinetda ko'rinadi: «plata `9999999` yuboryapti — bunday
 * tuman yo'q». Usiz montajchi xatosini topib bo'lmasdi.
 */
export class DeviceDistrict1763600000000 implements MigrationInterface {
  name = 'DeviceDistrict1763600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD COLUMN "district_id" uuid
          REFERENCES "districts"("id") ON DELETE SET NULL,
        ADD COLUMN "reported_district" varchar(64)
    `);
    /*
     * ⚠️ Indeks — tuman mas'uli ro'yxati uchun: «biriktirilmagan VA
     * mening tumanimdagi» so'rovi har sahifa ochilganda bajariladi.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_devices_district_id" ON "devices" ("district_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_devices_district_id"`);
    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP COLUMN IF EXISTS "reported_district",
        DROP COLUMN IF EXISTS "district_id"
    `);
  }
}
