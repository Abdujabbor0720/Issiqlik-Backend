/**
 * MFYLARNI IMPORT QILISH — `andijon-tumanlar-mfylar.json` dan.
 *
 * ⚠️ Sukut bo'yicha SINOV (hech narsa yozilmaydi). Yozish — `--apply`.
 *
 *   npm run import:mfy                      # repodagi ro'yxat, sinov
 *   npm run import:mfy -- --apply           # yozish
 *   npm run import:mfy -- --file boshqa.json [--apply]
 *
 * Fayl shakli: [{ "tuman": "Asaka tumani", "mfylar": ["...", "..."] }, ...]
 * Tuman nomi kalitga moslanadi («Andijon shahri» → andijon-sh,
 * «Bo'ston tumani» → boz). Tanilmagan nomlar hisobotda chiqadi.
 */
import { readFileSync } from 'node:fs';
import { AppDataSource } from '../config/data-source';
import {
  MAHALLA_FILE_PATH,
  applyMahallaPlan,
  buildMahallaPlan,
  parseMahallaFile,
} from '../modules/geo/import/mahalla-import.core';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  // ⚠️ Fayl berilmasa — repodagi rasmiy ro'yxat (migratsiya ham shuni o'qiydi).
  const file = arg('file') ?? MAHALLA_FILE_PATH;
  const apply = process.argv.includes('--apply');
  const entries = parseMahallaFile(JSON.parse(readFileSync(file, 'utf8')));

  const ds = await AppDataSource.initialize();
  try {
    await ds.transaction(async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('import-mfy'))`,
      );
      const plan = await buildMahallaPlan(manager, entries);

      for (const row of plan.districts) {
        console.log(
          `  ${row.name.padEnd(24)} [${row.key}] — faylda ${row.total}, ` +
            `yangi ${row.fresh.length}, mavjud ${row.existing}`,
        );
      }
      if (plan.unmatched.length) {
        console.log(`\n⚠️  Tanilmagan tumanlar: ${plan.unmatched.join(', ')}`);
      }
      if (plan.invalidNames) {
        console.log(`⚠️  Bo‘sh/yaroqsiz MFY nomlari: ${plan.invalidNames}`);
      }

      if (!apply) {
        console.log(
          '\nSINOV: hech narsa yozilmadi. Yozish uchun --apply qo‘shing.',
        );
        return;
      }
      const inserted = await applyMahallaPlan(manager, plan);
      console.log(`\n✔ YOZILDI: ${inserted} ta MFY.`);
    });
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
