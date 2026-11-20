import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  applyMahallaPlan,
  buildMahallaPlan,
  readMahallaFile,
} from '../../modules/geo/import/mahalla-import.core';

/**
 * MFYLAR KATALOGI — `src/database/seeds/data/andijon-tumanlar-mfylar.json`
 * (16 tuman, 878 MFY) dan import.
 *
 * ⚠️ Tuman nomi `districts.key` ga moslanadi («Andijon shahri» → `andijon-sh`,
 * «Boʻston tumani» → `boz`). Yadro — `mahalla-import.core.ts` (CLI va
 * bootstrap bilan AYNI).
 *
 * ⚠️ IDEMPOTENT: mavjud MFY (tuman + nom, katta-kichik harfsiz) qayta
 * yozilmaydi, qo'lda qo'shilganlar saqlanadi.
 *
 * ⚠️ YANGI (bo'sh) BAZADA tumanlar migratsiyadan KEYIN, bootstrap'da
 * yaratiladi — bu migratsiya hech narsa yozmaydi, MFYlarni bootstrap
 * tumanlar yozilishi bilan import qiladi (`BootstrapService.ensureMahallas`).
 *
 * ⚠️ Tanilmagan tuman nomi bo'lsa migratsiya TO'XTAYDI: katalog jimgina
 * yarim qolmasligi kerak.
 */
export class ImportMahallas1764000000000 implements MigrationInterface {
  name = 'ImportMahallas1764000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const entries = readMahallaFile();
    if (!entries) {
      console.warn(
        'ImportMahallas: andijon-tumanlar-mfylar.json topilmadi — MFY importi o‘tkazib yuborildi',
      );
      return;
    }
    const districts = (await queryRunner.query(
      `SELECT COUNT(*)::int AS n FROM "districts"`,
    )) as Array<{ n: number }>;
    if (!districts[0]?.n) return;

    const plan = await buildMahallaPlan(queryRunner, entries);
    if (plan.unmatched.length > 0) {
      throw new Error(
        `ImportMahallas: tanilmagan tumanlar — ${plan.unmatched.join(', ')}`,
      );
    }
    await applyMahallaPlan(queryRunner, plan);
  }

  /**
   * ⚠️ Faqat fayldagi va hech qaysi muassasa ishora qilmaydigan MFYlar
   * o'chiriladi: muassasaga biriktirilgani katalogda qoladi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const entries = readMahallaFile();
    if (!entries) return;
    const plan = await buildMahallaPlan(queryRunner, entries);
    for (const district of plan.districts) {
      const source = entries.find((entry) => entry.tuman === district.source);
      for (const name of source?.mfylar ?? []) {
        await queryRunner.query(
          `DELETE FROM "mahallas" m
            WHERE m."district_key" = $1 AND lower(m."name") = lower($2)
              AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."mahalla_id" = m."id")`,
          [district.key, name.trim()],
        );
      }
    }
  }
}
