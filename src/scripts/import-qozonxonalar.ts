/**
 * QOZONXONALAR RO'YXATINI IMPORT QILISH — ta'lim boshqarmasi jadvali
 * («Ҳудудлар ва таълим муассасалари номи | ... | қозонхоналар сони |
 * кўмирга мослашган қозонлар сони | марказлашган ...»).
 *
 * ⚠️⚠️ XAVFSIZLIK TARTIBI (prod bazada ishlatiladi):
 *   1. Sukut bo'yicha SINOV: hech narsa yozilmaydi, faqat reja chiqadi.
 *      Yozish — faqat `--apply` bilan.
 *   2. Fayl tekshiriladi: jami qatordagi sonlar (muassasa, maktab, DMTT,
 *      qozonxona, kotyol, markazlashgan) qatorlar yig'indisiga teng
 *      bo'lmasa, tanilmagan nom yoki tur chiqsa — ISH TO'XTAYDI.
 *   3. Hammasi BITTA tranzaksiyada + advisory lock (ikki parallel import yo'q).
 *   4. Qayta ishga tushirish xavfsiz: mavjud muassasa qayta yaratilmaydi,
 *      qozonxonasi BOR muassasaga yangi qozonxona qo'shilmaydi.
 *   5. Yaratilgan har bir yozuv `note` da belgi oladi (`[import:<tag>]`) —
 *      `--rollback --apply` FAQAT shularni o'chiradi; modul biriktirilgan
 *      yoki o'lchov kelgan qozonxonaga TEGMAYDI. Tizimning o'zi ochgan
 *      ogohlantirishlar (yangi qozonxona → «signal yo'q») to'siq EMAS —
 *      ular qozonxona bilan birga o'chadi (FK CASCADE).
 *
 * ⚠️ Lot raqami YOZILMAYDI (faylda yo'q va o'ylab topilmaydi).
 * ⚠️ Koordinata yozilmaydi — xaritada ko'rinishi uchun keyin qo'lda.
 * ⚠️ 2 ta qozonxonali muassasada kotyollar soni TENG bo'linadi
 *    (fayl faqat jami sonni beradi) va bu izohda aniq yoziladi.
 * ⚠️ Markazlashgan isitishdagi va rekonstruksiyadagi muassasalar uchun
 *    qozonxona YARATILMAYDI — faqat muassasa (katalog) qo'shiladi.
 *
 * Ishlatish (backend papkasida, `.env` dagi bazaga):
 *   node dist/scripts/import-qozonxonalar.js --file <jadval.xlsx> --district andijon_sh
 *   node dist/scripts/import-qozonxonalar.js --file <jadval.xlsx> --district andijon_sh \
 *        --devices <Qurilmalar.xlsx> --apply
 *   node dist/scripts/import-qozonxonalar.js --file <jadval.xlsx> --district andijon_sh --rollback [--apply]
 */
import { basename } from 'node:path';
import * as ExcelJS from 'exceljs';
import type { EntityManager } from 'typeorm';
import { AuditAction, FuelType } from '../common/constants/enums';
import { AppDataSource } from '../config/data-source';
import { Alert } from '../database/entities/alert.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Boiler } from '../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../database/entities/catalog.entities';
import { Device } from '../database/entities/device.entity';
import { District } from '../database/entities/district.entity';
import { TelemetryReading } from '../database/entities/telemetry-reading.entity';

// ───────────────────────── Argumentlar ─────────────────────────

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

class ImportError extends Error {}
const fail = (message: string): never => {
  throw new ImportError(message);
};

// ───────────────────────── Excel o'qish ─────────────────────────

type Cell = ExcelJS.CellValue;

function text(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return text(value.result as Cell);
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value).trim();
}

function count(value: Cell): number | null {
  const raw = text(value);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

type Kind = 'school' | 'kindergarten';

interface Row {
  excelRow: number;
  rawName: string;
  /** M<raqam> / D<raqam> — qurilmalar fayli bilan solishtirish kaliti. */
  key: string;
  baseName: string;
  kind: Kind;
  houses: number;
  boilers: number;
  central: boolean;
  remark: string | null;
}

/** Kirill qisqartmalari → lotin. Qolgan kirill harf — xato (taxmin qilinmaydi). */
const TRANSLIT: Array<[RegExp, string]> = [
  [/ИДУМ/giu, 'IDUM'],
  [/ДМТТ/giu, 'DMTT'],
  [/ДИМ/giu, 'DIM'],
  [/мактаб/giu, 'maktab'],
];
function transliterate(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TRANSLIT) {
    out = out.replace(pattern, replacement);
  }
  if (/[Ѐ-ӿ]/u.test(out)) {
    fail(`Tanilmagan kirill so'z: «${value}» — skriptga qo'shish kerak`);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function parseName(raw: string): {
  key: string;
  baseName: string;
  kind: Kind;
} {
  const name = raw.replace(/\s+/g, ' ').trim();
  let match = /^(\d+)\s*-\s*мактаб\s*(?:\((.+)\))?$/iu.exec(name);
  if (match) {
    const extra = match[2] ? `, ${transliterate(match[2])}` : '';
    return {
      key: `M${Number(match[1])}`,
      baseName: `${Number(match[1])}-maktab${extra}`,
      kind: 'school',
    };
  }
  match = /^(\d+)\s*-\s*ДИМ$/iu.exec(name);
  if (match) {
    return {
      key: `M${Number(match[1])}`,
      baseName: `${Number(match[1])}-maktab, DIM`,
      kind: 'school',
    };
  }
  match = /^(\d+)\s*-\s*ДМТТ$/iu.exec(name);
  if (match) {
    return {
      key: `D${Number(match[1])}`,
      baseName: `${Number(match[1])}-DMTT`,
      kind: 'kindergarten',
    };
  }
  return fail(`Muassasa nomi tanilmadi: «${raw}»`);
}

async function readBoilerSheet(
  file: string,
): Promise<{ rows: Row[]; date: string | null }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) return fail("Faylda varaq yo'q");

  const header = text(sheet.getRow(4).getCell(2).value);
  if (!/муассасалари номи/iu.test(header)) {
    fail(`Kutilgan jadval emas: 4-qator 2-ustun «${header}»`);
  }
  const dateCell = text(sheet.getRow(2).getCell(8).value);
  const dateMatch = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(dateCell);
  const date = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`
    : null;

  const totals = sheet.getRow(5);
  const expected = {
    institutions: count(totals.getCell(3).value),
    schools: count(totals.getCell(4).value),
    kindergartens: count(totals.getCell(5).value),
    houses: count(totals.getCell(6).value),
    boilers: count(totals.getCell(7).value),
    central: count(totals.getCell(8).value),
  };

  const rows: Row[] = [];
  sheet.eachRow((row, index) => {
    if (index < 6) return;
    const rawName = text(row.getCell(2).value);
    if (!rawName) return;
    const parsed = parseName(rawName);
    const isSchool = count(row.getCell(4).value) === 1;
    const isKg = count(row.getCell(5).value) === 1;
    const kind: Kind | null =
      isSchool && !isKg ? 'school' : isKg && !isSchool ? 'kindergarten' : null;
    if (kind !== parsed.kind) {
      fail(
        `${index}-qator «${rawName}»: nomdagi tur va ustundagi belgi mos emas`,
      );
    }
    const remarkCell = [6, 7, 8]
      .map((column) => text(row.getCell(column).value))
      .find((value) => value !== '' && Number.isNaN(Number(value)));
    rows.push({
      excelRow: index,
      rawName,
      ...parsed,
      houses: count(row.getCell(6).value) ?? 0,
      boilers: count(row.getCell(7).value) ?? 0,
      central: count(row.getCell(8).value) === 1,
      remark: remarkCell ?? null,
    });
  });

  // Jami qator bilan solishtirish — fayl formati o'zgargan bo'lsa to'xtaymiz.
  const actual = {
    institutions: rows.length,
    schools: rows.filter((r) => r.kind === 'school').length,
    kindergartens: rows.filter((r) => r.kind === 'kindergarten').length,
    houses: rows.reduce((s, r) => s + r.houses, 0),
    boilers: rows.reduce((s, r) => s + r.boilers, 0),
    central: rows.filter((r) => r.central).length,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (expected[key] !== actual[key]) {
      fail(
        `Jami «${key}»: sarlavhada ${expected[key]}, qatorlarda ${actual[key]} — fayl tekshirilsin`,
      );
    }
  }
  const keys = new Set<string>();
  for (const row of rows) {
    if (keys.has(row.key)) fail(`Takror muassasa: «${row.rawName}»`);
    keys.add(row.key);
    if (row.houses > 0 && row.boilers < row.houses) {
      fail(
        `${row.excelRow}-qator «${row.rawName}»: kotyol (${row.boilers}) qozonxonadan (${row.houses}) kam`,
      );
    }
  }
  return { rows, date };
}

async function readDevices(file: string): Promise<Map<string, string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const columns = new Map<string, number>();
  sheet
    .getRow(1)
    .eachCell((cell, column) =>
      columns.set(text(cell.value).toLowerCase(), column),
    );
  const nameCol = columns.get('name');
  const serialCol = columns.get('serial number');
  if (!nameCol || !serialCol) {
    return fail("Qurilmalar faylida «Name» / «Serial Number» ustuni yo'q");
  }

  const result = new Map<string, string>();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const name = text(row.getCell(nameCol).value);
    const serial = text(row.getCell(serialCol).value);
    const match = /^(\d+)\s*-\s*(maktab|dmtt)/i.exec(name);
    if (!match || !/^[0-9A-F]{6,16}$/i.test(serial)) return;
    const key = `${match[2].toLowerCase() === 'dmtt' ? 'D' : 'M'}${Number(match[1])}`;
    result.set(key, serial.toUpperCase());
  });
  return result;
}

// ───────────────────────── Reja ─────────────────────────

interface Plan {
  row: Row;
  name: string;
  /** Mavjud muassasa id si (bo'lsa). */
  orgId: string | null;
  orgNote: string | null;
  /** Yaratiladigan qozonxonalar — har biri kotyol soni. */
  boilerCounts: number[];
  skipReason: string | null;
  serial: string | null;
}

function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rest = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0));
}

// ───────────────────────── Asosiy ─────────────────────────

async function main(): Promise<void> {
  const file = arg('file') ?? fail('--file <jadval.xlsx> berilmagan');
  const districtRef =
    arg('district') ??
    fail('--district <kod yoki SOATO> berilmagan (masalan andijon_sh)');
  const devicesFile = arg('devices');
  const apply = flag('apply');
  const rollback = flag('rollback');

  const { rows, date } = await readBoilerSheet(file);
  const serials = devicesFile
    ? await readDevices(devicesFile)
    : new Map<string, string>();

  const ds = await AppDataSource.initialize();
  try {
    const found = await ds
      .getRepository(District)
      .createQueryBuilder('d')
      .where(
        'd.code = :ref OR d.soato = :ref OR LOWER(d.name) = LOWER(:ref)',
        { ref: districtRef },
      )
      .getOne();
    const district = found ?? fail(`Tuman topilmadi: «${districtRef}»`);
    const tag = arg('tag') ?? `mmtb:${district.code}:${date ?? 'nomalum-sana'}`;
    const marker = `[import:${tag}]`;

    console.log(`▶ Fayl: ${basename(file)}  (sana: ${date ?? '—'})`);
    console.log(`▶ Tuman: ${district.name}  ·  belgi: ${marker}`);
    console.log(
      `▶ Rejim: ${rollback ? 'ORQAGA QAYTARISH' : 'IMPORT'} · ${
        apply ? 'YOZILADI' : 'SINOV (hech narsa yozilmaydi)'
      }\n`,
    );

    if (rollback) {
      await runRollback(ds.manager, marker, apply);
      return;
    }

    const types = await ds.getRepository(ObjectType).find();
    const typeByCode = new Map(types.map((t) => [t.code, t]));
    for (const code of ['school', 'kindergarten'] as const) {
      if (!typeByCode.get(code)) fail(`Obyekt turi «${code}» katalogda yo'q`);
    }

    const source = `Manba: «${basename(file)}»${date ? ` (${date})` : ''}.`;
    const plans: Plan[] = [];
    for (const row of rows) {
      const name = `${row.baseName} (${district.shortName})`;
      const existing = await ds
        .getRepository(Organization)
        .createQueryBuilder('o')
        .where('LOWER(o.name) = LOWER(:name)', { name })
        .getOne();
      const existingBoilers = existing
        ? await ds.getRepository(Boiler).count({
            where: { organizationId: existing.id, isArchived: false },
          })
        : 0;

      let skipReason: string | null = null;
      if (row.remark) skipReason = `qozonxona yaratilmaydi: «${row.remark}»`;
      else if (row.central)
        skipReason = 'markazlashgan isitish — qozonxona yaratilmaydi';
      else if (row.houses === 0)
        skipReason = "qozonxona soni ko'rsatilmagan";
      else if (existingBoilers > 0)
        skipReason = `muassasada allaqachon ${existingBoilers} ta qozonxona bor — tegilmaydi`;

      plans.push({
        row,
        name,
        orgId: existing?.id ?? null,
        orgNote: existing ? null : `${source} ${marker}`,
        boilerCounts: skipReason ? [] : split(row.boilers, row.houses),
        skipReason,
        serial: serials.get(row.key) ?? null,
      });
    }

    // ── Hisobot ──
    for (const plan of plans) {
      const org = plan.orgId ? 'mavjud ' : 'YANGI  ';
      const what = plan.skipReason
        ? `— ${plan.skipReason}`
        : `+ ${plan.boilerCounts.length} qozonxona (kotyol: ${plan.boilerCounts.join(' + ')})`;
      const serial = plan.serial ? `  [plata ${plan.serial}]` : '';
      console.log(
        `  ${String(plan.row.excelRow).padStart(3)}  ${org} ${plan.name.padEnd(34)} ${what}${serial}`,
      );
    }
    const newOrgs = plans.filter((p) => !p.orgId).length;
    const newBoilers = plans.reduce((s, p) => s + p.boilerCounts.length, 0);
    const newUnits = plans.reduce(
      (s, p) => s + p.boilerCounts.reduce((a, b) => a + b, 0),
      0,
    );
    const centralWithDevice = plans
      .filter((p) => p.row.central && p.serial)
      .map((p) => p.name);
    console.log(
      `\n  Muassasa: ${plans.length} (yangi ${newOrgs}, mavjud ${plans.length - newOrgs})`,
    );
    console.log(
      `  Qozonxona: ${newBoilers} ta yaratiladi, jami ${newUnits} ta kotyol`,
    );
    console.log(
      `  Qozonxonasiz: ${plans.filter((p) => p.skipReason).length} ta`,
    );
    if (centralWithDevice.length) {
      console.log(
        `  ⚠ Plata bor, lekin markazlashgan (qozonxona yo'q): ${centralWithDevice.join(', ')}`,
      );
    }

    if (!apply) {
      console.log(
        '\n✔ SINOV tugadi — bazaga hech narsa yozilmadi. Yozish uchun: --apply',
      );
      return;
    }

    const result = await ds.transaction(async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('import-qozonxonalar'))`,
      );
      let orgsCreated = 0;
      let boilersCreated = 0;
      for (const plan of plans) {
        let orgId = plan.orgId;
        if (!orgId) {
          // Lock ostida qayta tekshiruv — parallel yaratilgan bo'lishi mumkin.
          const again = await manager
            .getRepository(Organization)
            .createQueryBuilder('o')
            .where('LOWER(o.name) = LOWER(:name)', { name: plan.name })
            .getOne();
          if (again) {
            orgId = again.id;
          } else {
            const saved = await manager.getRepository(Organization).save(
              manager.getRepository(Organization).create({
                name: plan.name,
                note: plan.orgNote,
                objectTypeId: typeByCode.get(plan.row.kind)!.id,
              }),
            );
            orgId = saved.id;
            orgsCreated += 1;
          }
        }
        if (plan.boilerCounts.length === 0) continue;
        const already = await manager.getRepository(Boiler).count({
          where: { organizationId: orgId, isArchived: false },
        });
        if (already > 0) continue;

        const total = plan.boilerCounts.reduce((a, b) => a + b, 0);
        for (const [index, units] of plan.boilerCounts.entries()) {
          const lines = [source];
          if (plan.boilerCounts.length > 1) {
            lines.push(
              `${plan.boilerCounts.length} ta qozonxonadan ${index + 1}-si; jami ${total} ta kotyol ` +
                `qozonxonalarga teng bo'lingan (aniq taqsimot faylda yo'q).`,
            );
          }
          if (plan.serial && index === 0) {
            lines.push(`Eski tizimdagi plata seriyasi: ${plan.serial}.`);
          }
          lines.push(marker);
          await manager.getRepository(Boiler).save(
            manager.getRepository(Boiler).create({
              districtId: district.id,
              lotNumber: null,
              organizationId: orgId,
              boilerCount: units,
              fuelType: FuelType.COAL,
              note: lines.join(' '),
            }),
          );
          boilersCreated += 1;
        }
      }
      await manager.getRepository(AuditLog).save(
        manager.getRepository(AuditLog).create({
          userId: null,
          actorLabel: 'import-qozonxonalar (skript)',
          action: AuditAction.CREATE,
          entityName: 'import',
          entityId: null,
          summary: `Import ${marker}: ${orgsCreated} muassasa, ${boilersCreated} qozonxona — ${district.name}`,
          after: { file: basename(file), tag, orgsCreated, boilersCreated },
        }),
      );
      return { orgsCreated, boilersCreated };
    });

    console.log(
      `\n✔ YOZILDI: ${result.orgsCreated} ta muassasa, ${result.boilersCreated} ta qozonxona.`,
    );
    console.log(
      `  Orqaga qaytarish: ... --district ${district.code} --file <fayl> --rollback --apply`,
    );
  } finally {
    await ds.destroy();
  }
}

async function runRollback(
  manager: EntityManager,
  marker: string,
  apply: boolean,
): Promise<void> {
  const boilers = await manager
    .getRepository(Boiler)
    .createQueryBuilder('b')
    .where('b.note LIKE :m', { m: `%${marker}%` })
    .getMany();

  const keep: string[] = [];
  const remove: Boiler[] = [];
  let alertsWithRemoved = 0;
  for (const boiler of boilers) {
    const [devices, readings, alerts] = await Promise.all([
      manager.getRepository(Device).count({ where: { boilerId: boiler.id } }),
      manager
        .getRepository(TelemetryReading)
        .count({ where: { boilerId: boiler.id } }),
      manager.getRepository(Alert).count({ where: { boilerId: boiler.id } }),
    ]);
    // ⚠️ Haqiqiy ma'lumot (modul / o'lchov) bor qozonxona saqlanadi.
    if (devices || readings) {
      keep.push(boiler.id);
    } else {
      remove.push(boiler);
      alertsWithRemoved += alerts;
    }
  }
  const orgs = await manager
    .getRepository(Organization)
    .createQueryBuilder('o')
    .where('o.note LIKE :m', { m: `%${marker}%` })
    .getMany();

  console.log(
    `  Belgili qozonxona: ${boilers.length} (o'chiriladi ${remove.length}, saqlanadi ${keep.length} — modul/o'lchov bor)`,
  );
  console.log(
    `  Ular bilan birga o'chadigan avtomatik ogohlantirish: ${alertsWithRemoved}`,
  );
  console.log(
    `  Belgili muassasa: ${orgs.length} (qozonxonasi qolmaganlari o'chiriladi)`,
  );
  if (!apply) {
    console.log(
      "\n✔ SINOV tugadi — hech narsa o'chirilmadi. Bajarish uchun: --rollback --apply",
    );
    return;
  }

  await manager.transaction(async (tx) => {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext('import-qozonxonalar'))`,
    );
    if (remove.length) {
      await tx.getRepository(Boiler).delete(remove.map((b) => b.id));
    }
    let orgsRemoved = 0;
    for (const org of orgs) {
      const left = await tx
        .getRepository(Boiler)
        .count({ where: { organizationId: org.id } });
      if (left === 0) {
        await tx.getRepository(Organization).delete(org.id);
        orgsRemoved += 1;
      }
    }
    await tx.getRepository(AuditLog).save(
      tx.getRepository(AuditLog).create({
        userId: null,
        actorLabel: 'import-qozonxonalar (skript)',
        action: AuditAction.DELETE,
        entityName: 'import',
        entityId: null,
        summary: `Import bekor qilindi ${marker}: ${remove.length} qozonxona, ${orgsRemoved} muassasa o'chirildi`,
        after: {
          removedBoilers: remove.length,
          keptBoilers: keep.length,
          orgsRemoved,
        },
      }),
    );
    console.log(
      `\n✔ O'CHIRILDI: ${remove.length} qozonxona, ${orgsRemoved} muassasa (saqlandi: ${keep.length}).`,
    );
  });
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
