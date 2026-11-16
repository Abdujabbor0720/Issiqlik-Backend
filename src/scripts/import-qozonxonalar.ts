/**
 * QOZONXONALAR RO'YXATINI IMPORT QILISH — serverdagi CLI.
 *
 * ⚠️ Mantiq `src/modules/boilers/import/boiler-import.core.ts` da — saytdagi
 * «Excel'dan import» oynasi bilan AYNI yadro. Bu fayl faqat argumentlarni
 * o'qiydi va hisobot chiqaradi.
 *
 * ⚠️⚠️ Sukut bo'yicha SINOV (hech narsa yozilmaydi). Yozish — `--apply`.
 *
 * Ishlatish (backend papkasida, `.env` dagi bazaga):
 *   npm run import:qozonxona -- --file <jadval.xlsx> --district andijon_sh [--devices <Qurilmalar.xlsx>]
 *   npm run import:qozonxona -- --file <jadval.xlsx> --district andijon_sh [--devices ...] --apply
 *   npm run import:qozonxona -- --file <jadval.xlsx> --district andijon_sh --rollback [--apply]
 */
import { basename } from 'node:path';
import { AppDataSource } from '../config/data-source';
import { District } from '../database/entities/district.entity';
import {
  ImportError,
  applyImportPlan,
  buildImportPlan,
  readBoilerSheet,
  readDevices,
  rollbackImport,
} from '../modules/boilers/import/boiler-import.core';

const ACTOR = { userId: null, label: 'import-qozonxonalar (skript)' };

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const fail = (message: string): never => {
  throw new ImportError(message);
};

async function main(): Promise<void> {
  const file = arg('file') ?? fail('--file <jadval.xlsx> berilmagan');
  const districtRef =
    arg('district') ??
    fail('--district <kod yoki SOATO> berilmagan (masalan andijon_sh)');
  const devicesFile = arg('devices');
  const apply = flag('apply');
  const rollback = flag('rollback');

  const sheet = await readBoilerSheet(file);
  const serials = devicesFile
    ? await readDevices(devicesFile)
    : new Map<string, string>();

  const ds = await AppDataSource.initialize();
  try {
    const found = await ds
      .getRepository(District)
      .createQueryBuilder('d')
      .where('d.code = :ref OR d.soato = :ref OR LOWER(d.name) = LOWER(:ref)', {
        ref: districtRef,
      })
      .getOne();
    const district = found ?? fail(`Tuman topilmadi: «${districtRef}»`);

    const plan = await buildImportPlan(ds.manager, {
      sheet,
      serials,
      district,
      fileName: basename(file),
      tag: arg('tag'),
    });

    console.log(`▶ Fayl: ${plan.fileName}  (sana: ${plan.date ?? '—'})`);
    console.log(`▶ Tuman: ${district.name}  ·  belgi: ${plan.marker}`);
    console.log(
      `▶ Rejim: ${rollback ? 'ORQAGA QAYTARISH' : 'IMPORT'} · ${
        apply ? 'YOZILADI' : 'SINOV (hech narsa yozilmaydi)'
      }\n`,
    );

    if (rollback) {
      const report = await rollbackImport(ds, plan.marker, apply, ACTOR);
      console.log(
        `  Belgili qozonxona: ${report.boilersMarked} (o'chiriladi ${report.boilersToRemove}, saqlanadi ${report.boilersKept} — modul/o'lchov bor)`,
      );
      console.log(
        `  Ular bilan birga o'chadigan avtomatik ogohlantirish: ${report.alertsWithRemoved}`,
      );
      console.log(
        `  Belgili muassasa: ${report.organizationsMarked} (qozonxonasi qolmaganlari o'chiriladi)`,
      );
      console.log(
        apply
          ? `\n✔ O'CHIRILDI: ${report.boilersToRemove} qozonxona, ${report.organizationsRemoved} muassasa.`
          : "\n✔ SINOV tugadi — hech narsa o'chirilmadi. Bajarish uchun: --rollback --apply",
      );
      return;
    }

    for (const row of plan.rows) {
      const org = row.organizationId ? 'mavjud ' : 'YANGI  ';
      const what = row.skipReason
        ? `— ${row.skipReason}`
        : `+ ${row.boilerCounts.length} qozonxona (kotyol: ${row.boilerCounts.join(' + ')})`;
      const serial = row.serial ? `  [plata ${row.serial}]` : '';
      console.log(
        `  ${String(row.excelRow).padStart(3)}  ${org} ${row.name.padEnd(34)} ${what}${serial}`,
      );
    }
    const t = plan.totals;
    console.log(
      `\n  Muassasa: ${t.institutions} (yangi ${t.newOrganizations}, mavjud ${t.existingOrganizations})`,
    );
    console.log(
      `  Qozonxona: ${t.boilers} ta yaratiladi, jami ${t.units} ta kotyol`,
    );
    console.log(`  Qozonxonasiz: ${t.withoutBoiler} ta`);
    for (const warning of plan.warnings) console.log(`  ⚠ ${warning}`);

    if (!apply) {
      console.log(
        '\n✔ SINOV tugadi — bazaga hech narsa yozilmadi. Yozish uchun: --apply',
      );
      return;
    }
    const result = await applyImportPlan(ds, plan, ACTOR);
    console.log(
      `\n✔ YOZILDI: ${result.organizationsCreated} ta muassasa, ${result.boilersCreated} ta qozonxona.`,
    );
    console.log(
      `  Orqaga qaytarish: ... --district ${district.code} --file <fayl> --rollback --apply`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ImportError) {
    console.error(
      `\n✖ TO'XTATILDI: ${error.message}\n  Bazaga hech narsa yozilmadi.`,
    );
  } else {
    console.error(
      '\n✖ Kutilmagan xato:',
      error instanceof Error ? error.message : error,
    );
  }
  process.exitCode = 1;
  if (AppDataSource.isInitialized) void AppDataSource.destroy();
});
