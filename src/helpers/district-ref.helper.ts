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
  code: string;
  soato: string | null;
  name: string;
}

/**
 * XONA MODULI PROSHIVKASINING TUMAN KALITLARI → tizim kodi.
 *
 * ⚠️⚠️ ANIQ RO'YXAT, TAXMIN EMAS. Proshivka menyusi tumanni o'z kaliti
 * bilan yuboradi (`andijon-sh`, `boston`). 13 tasi tizim kodi bilan AYNI,
 * faqat shu uchtasi farq qiladi. Umumiy «qisqa nom» qoidasi KIRITILMAYDI
 * (yuqoridagi izoh: «Andijon» ikki ma'noli) — faqat kelishilgan kalitlar.
 *
 * ⚠️ Solishtirish XOM qiymat bo'yicha (kichik harf, tutuq belgisi OLIB
 * TASHLANMAYDI): «Bo'ston» deb qo'lda yozilgan qisqa nom avvalgidek rad
 * etiladi, proshivka yuboradigan `boston` esa qabul qilinadi.
 *
 * ⚠️ `Map`, oddiy obyekt EMAS: `{}` da `"constructor"` kaliti prototipdan
 * topilib, so'rov yiqilardi.
 */
export const FIRMWARE_DISTRICT_KEYS: ReadonlyMap<string, string> = new Map([
  ['andijon-sh', 'andijon_sh'],
  ['xonobod-sh', 'xonobod_sh'],
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

  if (typeof raw === 'string') {
    const code = FIRMWARE_DISTRICT_KEYS.get(raw.trim().toLowerCase());
    if (code) {
      const found = districts.filter((item) => item.code === code);
      return found.length === 1 ? found[0] : null;
    }
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
