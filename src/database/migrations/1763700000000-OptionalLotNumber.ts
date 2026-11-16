import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LOT RAQAMI — IXTIYORIY (biznes qarori, 2026-11-16).
 *
 * ⚠️ Rasmiy ro'yxatlarda (masalan ta'lim boshqarmasining qozonxonalar
 * jadvali) lot raqami YO'Q. Uni majburiy qilib qoldirish odamni «nimadir»
 * yozishga majburlardi — o'ylab topilgan raqam esa haqiqiy xarid hujjati
 * bilan adashtirilib ketardi. Bo'sh — «hali ma'lum emas» degani.
 *
 * ⚠️ Yagonalik saqlanadi: PostgreSQL'da UNIQUE indeks bir nechta `NULL`
 * ga ruxsat beradi, kiritilgan lot esa avvalgidek takrorlanmaydi.
 */
export class OptionalLotNumber1763700000000 implements MigrationInterface {
  name = 'OptionalLotNumber1763700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "boilers" ALTER COLUMN "lot_number" DROP NOT NULL`,
    );
  }

  /**
   * ⚠️ Lotsiz qozonxona bor bo'lsa, orqaga qaytarish TO'XTAYDI: ularga
   * soxta lot yozib qo'yish ma'lumotni buzardi. Avval lotlarni kiriting
   * yoki o'sha qozonxonalarni arxivlang.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "boilers" WHERE "lot_number" IS NULL`,
    )) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `${rows[0].count} ta qozonxonada lot raqami yo'q — NOT NULL qaytarib bo'lmaydi`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "boilers" ALTER COLUMN "lot_number" SET NOT NULL`,
    );
  }
}
