/**
 * PLATA YUBORGAN TUMAN — matndan tumanni aniqlash.
 *
 * ⚠️⚠️ NIMA UCHUN QAT'IY. Tuman — modulning O'ZGARMAS hududi: kabinetda
 * uni hech kim tahrirlay olmaydi va modul faqat o'z tumanidagi kotyolga
 * biriktiriladi (biznes qarori, 2026-11-14). Noto'g'ri aniqlangan tuman
 * modulni BOSHQA tumanga «qulflab» qo'yardi. Shuning uchun taxmin
 * qilinmaydi: faqat aniq mos kelgan, YAGONA tuman qabul qilinadi.
 *
 * Qabul qilinadigan shakllar (ustuvorlik tartibida):
 *   1) SOATO kodi — `1703401` (davlat standarti, asosiy shakl);
 *   2) tizim kodi  — `andijon_sh`;
 *   3) to'liq nom  — `Andijon shahri`, `Bo'ston tumani`.
 *
 * ⚠️ QISQA NOM («Andijon») QABUL QILINMAYDI: «Andijon» — tuman, «Andijon
 * sh.» — shahar; odam ikkalasini ham «Andijon» deb yozadi va modul
 * jimgina boshqa tumanga tushib qolardi.
 */

/** Plata yuboradigan maydon nomlari — asosiysi `district`. */
const DISTRICT_FIELDS = [
  'district',
  'district_code',
  'districtCode',
  'district_id',
  'soato',
  'tuman',
];

export const DISTRICT_REF_MAX_LEN = 64;

/**
 * NORMALLASHTIRISH.
 *
 * ⚠️ O'zbekcha tutuq belgisining KAMIDA BESH xil yozilishi bor
 * (‘ ’ ʻ ʼ '). Montajchi klaviaturasi qaysi birini bersa ham, «Bo'ston» va
 * bazadagi «Bo‘ston» BITTA tuman bo'lishi kerak — shuning uchun ularning
 * hammasi olib tashlanadi va solishtirish faqat harflar bo'yicha boradi.
 */
export function normalizeDistrictRef(raw: unknown): string | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
  else return null;

  const value = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʻʼ'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value || value.length > DISTRICT_REF_MAX_LEN) return null;
  return value;
}

/** Xom yukdan tuman maydonini olish (normallashtirmasdan). */
export function extractDistrictRef(raw: Record<string, unknown>): unknown {
  for (const field of DISTRICT_FIELDS) {
    const value = raw[field];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export interface DistrictRecord {
  id: string;
  /** Proshivka kaliti (`andijon-sh`) — `districts.key`. */
  key: string;
  code: string;
  soato: string | null;
  name: string;
  /** Xaritadagi qisqa yorliq (`Asaka`). Sof funksiyalar uchun ixtiyoriy. */
  shortName?: string;
}

/**
 * ESKI PROSHIVKALAR YUBORGAN TUMAN KALITLARI → kanonik kalit (`districts.key`).
 *
 * ⚠️⚠️ ANIQ RO'YXAT, TAXMIN EMAS. Yangi proshivka (kotyol v2.1.0, xona v1.1.0)
 * kanonik kalitni yuboradi (`andijon-sh`, `boz`) va u `districts.key` bilan
 * to'g'ridan-to'g'ri mos keladi. Xona modulining 1.0.0 versiyasi Bo'ston
 * tumanini `boston` deb yuborgan — faqat shu taxallus qoldirilgan.
 *
 * ⚠️ `Map`, oddiy obyekt EMAS: `{}` da `"constructor"` kaliti prototipdan
 * topilib, so'rov yiqilardi.
 */
export const LEGACY_DISTRICT_KEYS: ReadonlyMap<string, string> = new Map([
  ['boston', 'boz'],
]);

/**
 * TUMANNI TOPISH.
 *
 * ⚠️ Har bosqichda faqat BITTA tuman mos kelsa qabul qilinadi; bir
 * nechtasi mos kelsa — `null` (noaniq). Bosqichlar ustuvorlik tartibida:
 * SOATO kodi topilsa, nom bo'yicha qidirilmaydi.
 */
export function matchDistrict(
  raw: unknown,
  districts: DistrictRecord[],
): DistrictRecord | null {
  const ref = normalizeDistrictRef(raw);
  if (!ref) return null;

  /*
   * ⚠️ 1-BOSQICH — PROSHIVKA KALITI (asosiy shakl). Solishtirish XOM qiymat
   * bo'yicha (kichik harf, tutuq belgisi OLIB TASHLANMAYDI): `boz` qabul
   * qilinadi, qo'lda yozilgan «Bo'z» esa keyingi bosqichlarga o'tadi.
   */
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase();
    const key = LEGACY_DISTRICT_KEYS.get(lowered) ?? lowered;
    const found = districts.filter((item) => item.key === key);
    if (found.length === 1) return found[0];
  }

  const steps: Array<(item: DistrictRecord) => string | null> = [
    (item) => normalizeDistrictRef(item.soato),
    (item) => normalizeDistrictRef(item.code),
    (item) => normalizeDistrictRef(item.name),
  ];

  for (const keyOf of steps) {
    const found = districts.filter((item) => keyOf(item) === ref);
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}

/**
 * TUMAN NOMINI KALITGA MOSLASH — MFY fayli («Asaka tumani», «Andijon sh.»).
 *
 * ⚠️ `matchDistrict` dan FARQI: bu yerda inson yozgan nom keladi va
 * qo'shimchalar har xil («tumani», «t.», «shahri», «sh.»). Qo'shimcha olib
 * tashlanadi, lekin TURI saqlanadi: «Andijon shahri» → `andijon-sh`,
 * «Andijon tumani» → `andijon` (ikkalasini adashtirish — eng xavfli xato).
 * Qo'shimchasiz «Andijon» — NOANIQ, `null`.
 *
 * ⚠️ Eski nom ham qabul qilinadi: «Bo'z tumani» → `boz` (Bo'ston).
 */
export function matchDistrictName(
  raw: unknown,
  districts: Array<DistrictRecord & { kind?: string }>,
): DistrictRecord | null {
  const direct = matchDistrict(raw, districts);
  if (direct) return direct;

  const ref = normalizeDistrictRef(raw);
  if (!ref) return null;

  const CITY = /\s+(shahri|shahar|sh\.?)$/;
  const RAYON = /\s+(tumani|tuman|t\.?)$/;
  const kind = CITY.test(ref) ? 'city' : RAYON.test(ref) ? 'district' : null;
  if (!kind) return null;
  const base = ref.replace(CITY, '').replace(RAYON, '').trim();
  const aliases: Record<string, string> = { boz: 'boston' };
  const wanted = aliases[base] ?? base;

  const found = districts.filter((item) => {
    const itemRef = normalizeDistrictRef(item.name) ?? '';
    const itemKind = CITY.test(itemRef) ? 'city' : 'district';
    const itemBase = itemRef.replace(CITY, '').replace(RAYON, '').trim();
    return itemKind === kind && itemBase === wanted;
  });
  return found.length === 1 ? found[0] : null;
}
