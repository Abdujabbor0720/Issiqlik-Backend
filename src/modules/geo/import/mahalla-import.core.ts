import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeReportedText } from '../../../helpers/device-profile.helper';
import {
  matchDistrictName,
  type DistrictRecord,
} from '../../../helpers/district-ref.helper';

/**
 * ⚠️ FAQAT `query()` — `EntityManager` ham, migratsiyaning `QueryRunner` i ham
 * shuni beradi. Yadro entity metama'lumotiga TAYANMAYDI: migratsiya kelajakda
 * entity o'zgarsa ham o'zgarmasdan ishlashi kerak.
 */
export interface SqlRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** Repodagi rasmiy ro'yxat (`src/database/seeds/data`, build'da `dist` ga ko'chadi). */
export const MAHALLA_FILE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'database',
  'seeds',
  'data',
  'andijon-tumanlar-mfylar.json',
);

/** Faylni o'qish; yo'q bo'lsa `null` (import o'tkazib yuboriladi). */
export function readMahallaFile(
  path = MAHALLA_FILE_PATH,
): MahallaFileEntry[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return parseMahallaFile(JSON.parse(text));
}

/**
 * MFYLAR IMPORTI — `andijon-tumanlar-mfylar.json`:
 *   [{ "tuman": "Asaka tumani", "mfylar": ["Navbahor", "Bog'ishamol", …] }, …]
 *
 * ⚠️ BITTA yadro: migratsiya (`ImportMahallas`), bootstrap (yangi baza) va
 * CLI (`npm run import:mfy`) AYNI kodni chaqiradi.
 * ⚠️ IDEMPOTENT: mavjud MFY (tuman + nom, katta-kichik harfsiz) qayta
 * yozilmaydi — fayl qayta import qilinsa takror paydo bo'lmaydi.
 * ⚠️ Tanilmagan tuman nomi BUTUN importni to'xtatmaydi, lekin hisobotda
 * aniq ko'rsatiladi: ular qo'lda tuzatilib qayta import qilinadi.
 */

export interface MahallaFileEntry {
  tuman: string;
  mfylar: string[];
}

export interface MahallaImportPlan {
  districts: Array<{
    source: string;
    key: string;
    name: string;
    total: number;
    fresh: string[];
    existing: number;
  }>;
  unmatched: string[];
  invalidNames: number;
}

export function parseMahallaFile(raw: unknown): MahallaFileEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      'Fayl JSON massivi bo‘lishi kerak: [{ "tuman": ..., "mfylar": [...] }]',
    );
  }
  return raw.map((item, index) => {
    const entry = item as Partial<MahallaFileEntry>;
    if (typeof entry?.tuman !== 'string' || !Array.isArray(entry.mfylar)) {
      throw new Error(
        `${index + 1}-yozuv: "tuman" (matn) va "mfylar" (massiv) kerak`,
      );
    }
    return {
      tuman: entry.tuman,
      mfylar: entry.mfylar.filter(
        (name): name is string => typeof name === 'string',
      ),
    };
  });
}

export async function buildMahallaPlan(
  manager: SqlRunner,
  entries: MahallaFileEntry[],
): Promise<MahallaImportPlan> {
  const districts = (await manager.query(
    `SELECT "id", "key", "code", "soato", "name", "kind" FROM "districts"`,
  )) as Array<DistrictRecord & { kind: string }>;
  const plan: MahallaImportPlan = {
    districts: [],
    unmatched: [],
    invalidNames: 0,
  };

  for (const entry of entries) {
    const district = matchDistrictName(entry.tuman, districts);
    if (!district) {
      plan.unmatched.push(entry.tuman);
      continue;
    }
    const existingRows = (await manager.query(
      `SELECT lower("name") AS name FROM "mahallas" WHERE "district_key" = $1`,
      [district.key],
    )) as Array<{ name: string }>;
    const existing = new Set(existingRows.map((row) => row.name));

    const seen = new Set<string>();
    const fresh: string[] = [];
    let already = 0;
    for (const raw of entry.mfylar) {
      const name = sanitizeReportedText(raw, 160);
      if (!name) {
        plan.invalidNames += 1;
        continue;
      }
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      if (existing.has(lower)) already += 1;
      else fresh.push(name);
    }
    plan.districts.push({
      source: entry.tuman,
      key: district.key,
      name: district.name,
      total: seen.size,
      fresh,
      existing: already,
    });
  }
  return plan;
}

/** @returns Yozilgan MFYlar soni. */
export async function applyMahallaPlan(
  manager: SqlRunner,
  plan: MahallaImportPlan,
): Promise<number> {
  let inserted = 0;
  for (const district of plan.districts) {
    for (const name of district.fresh) {
      const result = (await manager.query(
        `INSERT INTO "mahallas" ("district_key", "name") VALUES ($1, $2)
         ON CONFLICT ("district_key", lower("name")) DO NOTHING
         RETURNING "id"`,
        [district.key, name],
      )) as unknown[];
      inserted += result.length;
    }
  }
  return inserted;
}
