/**
 * QOZONXONALAR RO'YXATINI IMPORT QILISH — umumiy yadro.
 *
 * Jadval: ta'lim boshqarmasining qozonxonalar ro'yxati («Ҳудудлар ва
 * таълим муассасалари номи | ... | қозонхоналар сони | кўмирга
 * мослашган қозонлар сони | марказлашган ...»).
 *
 * ⚠️⚠️ BITTA YADRO, IKKI KIRISH: saytdagi «Excel'dan import» oynasi
 * (`BoilerImportService`) va serverdagi CLI (`src/scripts/
 * import-qozonxonalar.ts`) AYNAN shu funksiyalarni chaqiradi. Ikki
 * nusxa bo'lsa, bir kuni sayt bir xil, skript boshqacha yozardi.
 *
 * ⚠️⚠️ XAVFSIZLIK:
 *   1. Avval REJA (`buildImportPlan`) — bazaga hech narsa yozmaydi.
 *   2. Fayl tekshiriladi: jami qatordagi sonlar qatorlar yig'indisiga
 *      teng bo'lmasa, tanilmagan nom yoki tur chiqsa — `ImportError`.
 *   3. Yozish (`applyImportPlan`) — BITTA tranzaksiya + advisory lock;
 *      muassasa va qozonxonalar lock ostida QAYTA tekshiriladi.
 *   4. Qayta import xavfsiz: mavjud muassasa qayta yaratilmaydi,
 *      qozonxonasi BOR muassasaga yangi qozonxona qo'shilmaydi.
 *   5. Har yozuv `note` da belgi oladi (`[import:<tag>]`); orqaga
 *      qaytarish FAQAT shularni o'chiradi, modul biriktirilgan yoki
 *      o'lchov kelgan qozonxonaga TEGMAYDI.
 *
 * ⚠️ Lot raqami YOZILMAYDI (faylda yo'q, o'ylab topilmaydi).
 * ⚠️ 2 ta qozonxonali muassasada kotyollar soni TENG bo'linadi (fayl
 *    faqat jami sonni beradi) — izohda aniq yoziladi.
 * ⚠️ Markazlashgan isitishdagi va rekonstruksiyadagi muassasa uchun
 *    qozonxona YARATILMAYDI — faqat muassasa (katalog) qo'shiladi.
 */
import * as ExcelJS from 'exceljs';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditAction, FuelType } from '../../../common/constants/enums';
import { Alert } from '../../../database/entities/alert.entity';
import { AuditLog } from '../../../database/entities/audit-log.entity';
import { Boiler } from '../../../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../../../database/entities/catalog.entities';
import { Device } from '../../../database/entities/device.entity';
import type { District } from '../../../database/entities/district.entity';
import { TelemetryReading } from '../../../database/entities/telemetry-reading.entity';

/** Foydalanuvchiga ko'rsatiladigan, kutilgan xato (fayl noto'g'ri va h.k.). */
export class ImportError extends Error {}
const fail = (message: string): never => {
  throw new ImportError(message);
};

export type ImportSource = string | Buffer;

export interface ImportActor {
  userId: string | null;
  label: string;
}

// ───────────────────────── Excel o'qish ─────────────────────────

type Cell = ExcelJS.CellValue;

async function loadWorkbook(source: ImportSource): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    if (typeof source === 'string') {
      await workbook.xlsx.readFile(source);
    } else {
      // exceljs turlari eski `Buffer` ni kutadi — Node bufer bilan mos.
      await workbook.xlsx.load(source as unknown as ArrayBuffer);
    }
  } catch {
    fail("Faylni o'qib bo'lmadi — bu .xlsx (Excel) fayli ekanini tekshiring");
  }
  return workbook;
}

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

export type ImportKind = 'school' | 'kindergarten';

export interface SheetRow {
  excelRow: number;
  rawName: string;
  /** M<raqam> / D<raqam> — qurilmalar fayli bilan solishtirish kaliti. */
  key: string;
  baseName: string;
  kind: ImportKind;
  houses: number;
  boilers: number;
  central: boolean;
  remark: string | null;
}

export interface ParsedSheet {
  rows: SheetRow[];
  /** Jadvaldagi sana, `YYYY-MM-DD`. */
  date: string | null;
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
    fail(`Tanilmagan kirill so'z: «${value}»`);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function parseName(raw: string): {
  key: string;
  baseName: string;
  kind: ImportKind;
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

export async function readBoilerSheet(
  source: ImportSource,
): Promise<ParsedSheet> {
  const workbook = await loadWorkbook(source);
  const sheet = workbook.worksheets[0];
  if (!sheet) return fail("Faylda varaq yo'q");

  const header = text(sheet.getRow(4).getCell(2).value);
  if (!/муассасалари номи/iu.test(header)) {
    fail(
      'Kutilgan jadval emas: 4-qator 2-ustunda «Ҳудудлар ва таълим муассасалари номи» bo‘lishi kerak',
    );
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

  const rows: SheetRow[] = [];
  sheet.eachRow((row, index) => {
    if (index < 6) return;
    const rawName = text(row.getCell(2).value);
    if (!rawName) return;
    const parsed = parseName(rawName);
    const isSchool = count(row.getCell(4).value) === 1;
    const isKg = count(row.getCell(5).value) === 1;
    const kind: ImportKind | null =
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
  const labels: Record<keyof typeof expected, string> = {
    institutions: 'muassasa',
    schools: 'maktab',
    kindergartens: 'DMTT',
    houses: 'qozonxona',
    boilers: 'kotyol',
    central: 'markazlashgan',
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (expected[key] !== actual[key]) {
      fail(
        `Jami «${labels[key]}»: sarlavhada ${expected[key] ?? '—'}, qatorlarda ${actual[key]} — fayl tekshirilsin`,
      );
    }
  }
  if (rows.length === 0) fail("Jadvalda muassasa qatori yo'q");

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

/** Eski tizim eksporti («Qurilmalar»): muassasa kaliti → plata seriyasi. */
export async function readDevices(
  source: ImportSource,
): Promise<Map<string, string>> {
  const workbook = await loadWorkbook(source);
  const sheet = workbook.worksheets[0];
  if (!sheet) return fail("Qurilmalar faylida varaq yo'q");
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

export interface ImportRowPlan {
  excelRow: number;
  sourceName: string;
  name: string;
  kind: ImportKind;
  /** Mavjud muassasa (bo'lsa). */
  organizationId: string | null;
  /** Yaratiladigan qozonxonalar — har biri kotyol soni. */
  boilerCounts: number[];
  skipReason: string | null;
  serial: string | null;
}

export interface ImportPlan {
  fileName: string;
  date: string | null;
  tag: string;
  marker: string;
  district: { id: string; name: string; code: string; shortName: string };
  rows: ImportRowPlan[];
  totals: {
    institutions: number;
    newOrganizations: number;
    existingOrganizations: number;
    boilers: number;
    units: number;
    withoutBoiler: number;
  };
  warnings: string[];
}

function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rest = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0));
}

function findOrganization(
  manager: EntityManager,
  name: string,
): Promise<Organization | null> {
  return manager
    .getRepository(Organization)
    .createQueryBuilder('o')
    .where('LOWER(o.name) = LOWER(:name)', { name })
    .getOne();
}

/** REJA — bazaga hech narsa yozmaydi. */
export async function buildImportPlan(
  manager: EntityManager,
  input: {
    sheet: ParsedSheet;
    serials: Map<string, string>;
    district: District;
    fileName: string;
    tag?: string;
  },
): Promise<ImportPlan> {
  const { sheet, serials, district, fileName } = input;
  const tag =
    input.tag ?? `mmtb:${district.code}:${sheet.date ?? 'nomalum-sana'}`;
  const marker = `[import:${tag}]`;

  const types = await manager.getRepository(ObjectType).find();
  for (const code of ['school', 'kindergarten'] as const) {
    if (!types.some((t) => t.code === code)) {
      fail(`Obyekt turi «${code}» katalogda yo'q`);
    }
  }

  const rows: ImportRowPlan[] = [];
  for (const row of sheet.rows) {
    const name = `${row.baseName} (${district.shortName})`;
    const existing = await findOrganization(manager, name);
    const existingBoilers = existing
      ? await manager.getRepository(Boiler).count({
          where: { organizationId: existing.id, isArchived: false },
        })
      : 0;

    let skipReason: string | null = null;
    if (row.remark) skipReason = `Qozonxona yaratilmaydi: «${row.remark}»`;
    else if (row.central)
      skipReason = 'Markazlashgan isitish — qozonxona yaratilmaydi';
    else if (row.houses === 0) skipReason = "Qozonxona soni ko'rsatilmagan";
    else if (existingBoilers > 0)
      skipReason = `Allaqachon ${existingBoilers} ta qozonxona bor — tegilmaydi`;

    rows.push({
      excelRow: row.excelRow,
      sourceName: row.rawName,
      name,
      kind: row.kind,
      organizationId: existing?.id ?? null,
      boilerCounts: skipReason ? [] : split(row.boilers, row.houses),
      skipReason,
      serial: serials.get(row.key) ?? null,
    });
  }

  const newOrganizations = rows.filter((r) => !r.organizationId).length;
  const warnings: string[] = [];
  const centralWithDevice = sheet.rows
    .filter((row) => row.central && serials.has(row.key))
    .map((row) => `${row.baseName} (${district.shortName})`);
  if (centralWithDevice.length) {
    warnings.push(
      `Platasi bor, lekin faylda markazlashgan isitish (qozonxona yaratilmaydi): ${centralWithDevice.join(', ')}`,
    );
  }

  return {
    fileName,
    date: sheet.date,
    tag,
    marker,
    district: {
      id: district.id,
      name: district.name,
      code: district.code,
      shortName: district.shortName,
    },
    rows,
    totals: {
      institutions: rows.length,
      newOrganizations,
      existingOrganizations: rows.length - newOrganizations,
      boilers: rows.reduce((s, r) => s + r.boilerCounts.length, 0),
      units: rows.reduce(
        (s, r) => s + r.boilerCounts.reduce((a, b) => a + b, 0),
        0,
      ),
      withoutBoiler: rows.filter((r) => r.skipReason).length,
    },
    warnings,
  };
}

// ───────────────────────── Yozish ─────────────────────────

export interface ImportResult {
  organizationsCreated: number;
  boilersCreated: number;
}

export async function applyImportPlan(
  dataSource: DataSource,
  plan: ImportPlan,
  actor: ImportActor,
  /** Auditga qo'shimcha (masalan arxivdagi asl fayl kalitlari). */
  auditExtra: Record<string, unknown> = {},
): Promise<ImportResult> {
  return dataSource.transaction(async (manager) => {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtext('import-qozonxonalar'))`,
    );
    const types = await manager.getRepository(ObjectType).find();
    const typeIdByCode = new Map(types.map((t) => [t.code, t.id]));
    const source = `Manba: «${plan.fileName}»${plan.date ? ` (${plan.date})` : ''}.`;

    let organizationsCreated = 0;
    let boilersCreated = 0;
    for (const row of plan.rows) {
      // ⚠️ Lock ostida QAYTA tekshiruv — reja tuzilgandan beri boshqa
      // import yoki odam shu muassasani yaratgan bo'lishi mumkin.
      const existing = await findOrganization(manager, row.name);
      let organizationId = existing?.id ?? null;
      if (!organizationId) {
        const saved = await manager.getRepository(Organization).save(
          manager.getRepository(Organization).create({
            name: row.name,
            note: `${source} ${plan.marker}`,
            objectTypeId: typeIdByCode.get(row.kind) ?? null,
          }),
        );
        organizationId = saved.id;
        organizationsCreated += 1;
      }
      if (row.boilerCounts.length === 0) continue;
      const already = await manager.getRepository(Boiler).count({
        where: { organizationId, isArchived: false },
      });
      if (already > 0) continue;

      const total = row.boilerCounts.reduce((a, b) => a + b, 0);
      for (const [index, units] of row.boilerCounts.entries()) {
        const lines = [source];
        if (row.boilerCounts.length > 1) {
          lines.push(
            `${row.boilerCounts.length} ta qozonxonadan ${index + 1}-si; jami ${total} ta kotyol ` +
              `qozonxonalarga teng bo'lingan (aniq taqsimot faylda yo'q).`,
          );
        }
        if (row.serial && index === 0) {
          lines.push(`Eski tizimdagi plata seriyasi: ${row.serial}.`);
        }
        lines.push(plan.marker);
        await manager.getRepository(Boiler).save(
          manager.getRepository(Boiler).create({
            districtId: plan.district.id,
            lotNumber: null,
            organizationId,
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
        userId: actor.userId,
        actorLabel: actor.label,
        action: AuditAction.CREATE,
        entityName: 'import',
        entityId: null,
        summary: `Excel import ${plan.marker}: ${organizationsCreated} muassasa, ${boilersCreated} qozonxona — ${plan.district.name}`,
        after: {
          file: plan.fileName,
          tag: plan.tag,
          organizationsCreated,
          boilersCreated,
          ...auditExtra,
        },
      }),
    );
    return { organizationsCreated, boilersCreated };
  });
}

// ───────────────────────── Orqaga qaytarish ─────────────────────────

export interface RollbackReport {
  boilersMarked: number;
  boilersToRemove: number;
  boilersKept: number;
  alertsWithRemoved: number;
  organizationsMarked: number;
  organizationsRemoved: number;
}

/**
 * ⚠️ To'siq — FAQAT haqiqiy ma'lumot (biriktirilgan modul yoki kelgan
 * o'lchov). Tizim o'zi ochgan ogohlantirishlar (yangi qozonxona → «signal
 * yo'q») to'siq EMAS: ular qozonxona bilan birga o'chadi (FK CASCADE).
 */
export async function rollbackImport(
  dataSource: DataSource,
  marker: string,
  apply: boolean,
  actor: ImportActor,
): Promise<RollbackReport> {
  const manager = dataSource.manager;
  const boilers = await manager
    .getRepository(Boiler)
    .createQueryBuilder('b')
    .where('b.note LIKE :m', { m: `%${marker}%` })
    .getMany();

  const remove: string[] = [];
  let kept = 0;
  let alertsWithRemoved = 0;
  for (const boiler of boilers) {
    const [devices, readings, alerts] = await Promise.all([
      manager.getRepository(Device).count({ where: { boilerId: boiler.id } }),
      manager
        .getRepository(TelemetryReading)
        .count({ where: { boilerId: boiler.id } }),
      manager.getRepository(Alert).count({ where: { boilerId: boiler.id } }),
    ]);
    if (devices || readings) {
      kept += 1;
    } else {
      remove.push(boiler.id);
      alertsWithRemoved += alerts;
    }
  }
  const orgs = await manager
    .getRepository(Organization)
    .createQueryBuilder('o')
    .where('o.note LIKE :m', { m: `%${marker}%` })
    .getMany();

  const report: RollbackReport = {
    boilersMarked: boilers.length,
    boilersToRemove: remove.length,
    boilersKept: kept,
    alertsWithRemoved,
    organizationsMarked: orgs.length,
    organizationsRemoved: 0,
  };
  if (!apply) return report;

  await dataSource.transaction(async (tx) => {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext('import-qozonxonalar'))`,
    );
    if (remove.length) await tx.getRepository(Boiler).delete(remove);
    for (const org of orgs) {
      const left = await tx
        .getRepository(Boiler)
        .count({ where: { organizationId: org.id } });
      if (left === 0) {
        await tx.getRepository(Organization).delete(org.id);
        report.organizationsRemoved += 1;
      }
    }
    await tx.getRepository(AuditLog).save(
      tx.getRepository(AuditLog).create({
        userId: actor.userId,
        actorLabel: actor.label,
        action: AuditAction.DELETE,
        entityName: 'import',
        entityId: null,
        summary: `Import bekor qilindi ${marker}: ${remove.length} qozonxona, ${report.organizationsRemoved} muassasa`,
        after: { ...report },
      }),
    );
  });
  return report;
}
