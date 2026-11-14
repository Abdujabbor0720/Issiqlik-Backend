import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SIRKULYATSIYA CHEGARASI — «suv aylanayaptimi?».
 *
 * ⚠️⚠️ NIMA UCHUN KERAK. Ikki datchik paydo bo'lgandan keyin tizim
 * ILGARI KO'RINMAGAN nosozlikni aniqlay oladi: kotyol issiq, chiqish
 * harorati me'yorda, holat «faol» — lekin nasos to'xtagan yoki
 * ventil yopiq va issiqlik BINOGA BORMAYAPTI. Bitta datchik bilan bu
 * holatda hamma ko'rsatkich yashil turardi, bino esa sovuq bo'lardi
 * va sabab faqat joyiga borib aniqlanardi.
 *
 * ⚠️ Chegara QOTIRILMAYDI, sozlamaga chiqariladi: turli qozonxonada
 * normal ayirma boshqacha (katta binoda 15–20 °C, kichikda 5–8 °C).
 * Kodga yozilsa, uni o'zgartirish uchun reliz kerak bo'lardi —
 * holbuki bu MA'MURIY, dala sharoitiga qarab qo'yiladigan qiymat.
 */
export class CirculationThreshold1763400000000 implements MigrationInterface {
  name = 'CirculationThreshold1763400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * ⚠️ Sukut 3 °C — ATAYLAB PAST. Yolg'on ogohlantirish eng
     * zararli natija: operator ularga ishonmay qo'yadi va keyin
     * HAQIQIY xabarni ham o'tkazib yuboradi. 3 °C dan kichik ayirma
     * esa amalda faqat suv butunlay to'xtaganda bo'ladi.
     *
     * ⚠️ `CHECK (> 0)`: nol yoki manfiy chegara ogohlantirishni
     * HAR BIR o'lchovda ochardi — ya'ni butun park bir zumda
     * «sirkulyatsiya yo'q» bo'lib qolardi va bu xabar ma'nosini
     * butunlay yo'qotardi.
     */
    await queryRunner.query(`
      ALTER TABLE "system_settings"
        ADD COLUMN "min_delta_c" numeric(5,2) NOT NULL DEFAULT 3,
        ADD CONSTRAINT "CHK_system_settings_min_delta"
          CHECK ("min_delta_c" > 0 AND "min_delta_c" < 100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "system_settings"
        DROP CONSTRAINT IF EXISTS "CHK_system_settings_min_delta",
        DROP COLUMN IF EXISTS "min_delta_c"
    `);
  }
}
