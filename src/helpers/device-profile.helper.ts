import { ModuleType } from '../common/constants/enums';

/**
 * PLATA O'ZI HAQIDA AYTADIGAN MA'LUMOT — modul turi, joylashuv, namlik.
 *
 * ⚠️⚠️ HAMMASI FAQAT KO'RSATISH UCHUN. Bu qiymatlar ma'lumotni hech qayerga
 * YO'NALTIRMAYDI (§3: «institution_id ga ko'r-ko'rona ishonma»): kotyol
 * hamon `devices.boiler_id` orqali aniqlanadi. Ular tuman mas'uliga yuzlab
 * biriktirilmagan modul orasidan O'Z binosidagisini topishga yordam beradi.
 *
 * ⚠️ HECH QACHON XATO TASHLAMAYDI: buzuq joylashuv maydoni harorat
 * o'lchovini rad etmasligi kerak (qurilma 400/422 ni «butunlay rad etildi»
 * deb o'qiydi va o'lchovni TASHLAYDI). Yaroqsiz qiymat `rejected` ga tushadi.
 */

/** Matn maydonlari chegarasi, belgi (bazadagi `varchar(120)`). */
export const REPORTED_TEXT_MAX = 120;
/** Obyekt turi kaliti chegarasi (bazadagi `varchar(32)`). */
export const OBJECT_TYPE_KEY_MAX = 32;

export const HUMIDITY_MIN = 0;
export const HUMIDITY_MAX = 100;

/**
 * Modul turi nomlari. ⚠️ Faqat ANIQ so'zlar: «room» va «boiler» —
 * proshivka bilan kelishilgan qiymatlar, qolganlari inson adashishiga
 * zaxira. Noma'lum qiymat turni O'ZGARTIRMAYDI.
 */
const MODULE_TYPE_ALIASES: Record<string, ModuleType> = {
  boiler: ModuleType.BOILER,
  kotyol: ModuleType.BOILER,
  qozonxona: ModuleType.BOILER,
  room: ModuleType.ROOM,
  xona: ModuleType.ROOM,
};

const FIELDS = {
  moduleType: ['module_type', 'moduleType'],
  mfy: ['mfy', 'mahalla', 'mfy_name'],
  institution: ['institution_name', 'institutionName', 'muassasa_nomi'],
  objectType: ['object_type', 'objectType', 'obyekt_turi'],
  humidity: ['humidity', 'humidity_pct', 'room_humidity', 'namlik'],
} as const;

function pick(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** `room` / `boiler` (va zaxira nomlar) → tur; boshqa hamma narsa → `null`. */
export function parseModuleType(raw: unknown): ModuleType | null {
  if (typeof raw !== 'string') return null;
  return MODULE_TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * QURILMADAN KELGAN MATNNI TOZALASH.
 *
 * ⚠️ NFC — «Bogʻishamol» ikki xil bayt ketma-ketligida kelishi mumkin
 * (tayyor harf yoki harf + birikuvchi belgi). Normallashtirilmasa, ekranda
 * bir xil ko'rinadigan ikki qiymat qidiruvda boshqa-boshqa bo'lardi.
 *
 * ⚠️ Boshqaruv va YO'NALISH belgilari (`U+202E` va boshqalar) olib
 * tashlanadi: ular jadvalda matnni teskari aylantirib, «12-maktab» ni
 * boshqa muassasa qilib ko'rsatishi mumkin edi.
 *
 * ⚠️ Chegara BELGI bo'yicha (`Array.from`), UTF-16 birligi bo'yicha emas:
 * aks holda ko'p baytli harf o'rtasidan kesilib, buzuq belgi qolardi.
 */
export function sanitizeReportedText(
  raw: unknown,
  maxLength = REPORTED_TEXT_MAX,
): string | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
  else return null;

  /*
   * \u26a0\ufe0f Boshqaruv belgilarini ATAYLAB qidiradigan regex \u2014 `no-control-regex`
   * aynan shuni taqiqlaydi, lekin bu yerda maqsadning o'zi shu.
   */
  const unsafe =
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const clean = text
    .normalize('NFC')
    .replace(unsafe, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return Array.from(clean).slice(0, maxLength).join('');
}

/**
 * OBYEKT TURI KALITI — «Kataloglar → Obyekt turlari» dagi mashina kodi.
 * ⚠️ Kichik harfga o'tkaziladi (`School` = `school`); ruxsat etilmagan
 * belgi bo'lsa — `null`: kalit qidiruv va jadvalda ishlatiladi.
 */
export function normalizeObjectTypeKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key || key.length > OBJECT_TYPE_KEY_MAX) return null;
  return /^[a-z][a-z0-9_-]*$/.test(key) ? key : null;
}

/**
 * NAMLIK, % — 0…100.
 *
 * ⚠️ `""` → `0` bo'lishiga YO'L QO'YILMAYDI (`Number("") === 0`): bo'sh
 * qiymat «quruq havo» bo'lib ko'rinardi. DHT22 o'qiy olmasa `NaN` beradi
 * — u ham rad etiladi.
 */
export function parseHumidity(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && raw.trim() !== '')
    value = Number(raw.trim());
  else return null;
  if (!Number.isFinite(value)) return null;
  if (value < HUMIDITY_MIN || value > HUMIDITY_MAX) return null;
  return Math.round(value * 100) / 100;
}

export interface RejectedProfileField {
  field:
    'module_type' | 'mfy' | 'institution_name' | 'object_type' | 'humidity';
  value: unknown;
}

export interface ReportedProfile {
  /**
   * Plata AYTGAN tur (sarlavha yoki tana). `null` — aytmagan: eski
   * proshivka yoki xona modulining 1.0.0 versiyasi.
   */
  declaredType: ModuleType | null;
  /** `undefined` — maydon kelmagan (eski qiymat SAQLANADI). */
  mfy: string | undefined;
  institution: string | undefined;
  objectType: string | undefined;
  humidity: number | undefined;
  rejected: RejectedProfileField[];
}

/**
 * XOM YUKDAN PROFILNI O'QISH.
 *
 * ⚠️⚠️ `undefined` va `null` FARQ QILADI: kelmagan maydon `undefined` —
 * bazadagi oxirgi qiymat O'CHIRILMAYDI (talab: «Kelmagan maydon
 * o'chirilmasin»). Yaroqsiz qiymat ham `undefined` + `rejected`: buzuq
 * matn yaxshi ma'lum qiymatni bosib ketmasligi kerak.
 *
 * ⚠️ `X-Module-Type` sarlavhasi TANADAN USTUN: u OTA'ning `GET`
 * so'rovlarida ham bor (tana yo'q), ya'ni yagona universal manba —
 * `X-Device-Id` bilan AYNI qoida.
 */
export function extractReportedProfile(
  raw: Record<string, unknown>,
  headerModuleType: unknown,
): ReportedProfile {
  const rejected: RejectedProfileField[] = [];

  const declaredRaw =
    typeof headerModuleType === 'string' && headerModuleType.trim()
      ? headerModuleType
      : pick(raw, FIELDS.moduleType);
  const declaredType = parseModuleType(declaredRaw);
  if (declaredRaw !== undefined && declaredType === null) {
    rejected.push({ field: 'module_type', value: declaredRaw });
  }

  const text = (
    field: RejectedProfileField['field'],
    value: unknown,
    parse: (input: unknown) => string | null,
  ): string | undefined => {
    if (value === undefined) return undefined;
    const parsed = parse(value);
    if (parsed === null) {
      rejected.push({ field, value });
      return undefined;
    }
    return parsed;
  };

  const humidityRaw = pick(raw, FIELDS.humidity);
  let humidity: number | undefined;
  if (humidityRaw !== undefined) {
    const parsed = parseHumidity(humidityRaw);
    if (parsed === null)
      rejected.push({ field: 'humidity', value: humidityRaw });
    else humidity = parsed;
  }

  return {
    declaredType,
    mfy: text('mfy', pick(raw, FIELDS.mfy), (v) => sanitizeReportedText(v)),
    institution: text('institution_name', pick(raw, FIELDS.institution), (v) =>
      sanitizeReportedText(v),
    ),
    objectType: text(
      'object_type',
      pick(raw, FIELDS.objectType),
      normalizeObjectTypeKey,
    ),
    humidity,
    rejected,
  };
}

/**
 * MODUL TURINI ANIQLASH — aytilgani, aytilmasa YUK SHAKLIDAN.
 *
 * ⚠️⚠️ Xulosa faqat ANIQ shakldan: suv harorati maydoni bor → `boiler`
 * (xona moduli uni hech qachon yubormaydi); suv harorati umuman yo'q, xona
 * harorati bor → `room`. Boshqa holatda `null` — tur O'ZGARMAYDI. Shu
 * tufayli 1.0.0 xona modullari (turini aytmaydi) birinchi signalidayoq
 * `room` bo'ladi va qozonxona proshivkasi ularga taklif qilinmaydi.
 *
 * ⚠️⚠️ KOTYOLGA BIRIKTIRILGAN qurilmada xulosa CHIQARILMAYDI — faqat plata
 * o'zi aytgan tur qo'llanadi. Quvur datchiklari uzilib, faqat xona datchigi
 * ishlab qolgan qozonxona platasi «xona moduli» bo'lib qolmasligi kerak:
 * aks holda u qozonxona proshivkasini olmay qolardi va kotyol modulsiz
 * hisoblanardi. Xona moduli esa kotyolga ulanishidan OLDIN signal yuboradi
 * va turi o'shanda aniqlanadi.
 */
export function resolveModuleType(input: {
  declared: ModuleType | null;
  hasBoilerReading: boolean;
  hasRoomReading: boolean;
  isBound: boolean;
}): ModuleType | null {
  if (input.declared) return input.declared;
  if (input.isBound) return null;
  if (input.hasBoilerReading) return ModuleType.BOILER;
  if (input.hasRoomReading) return ModuleType.ROOM;
  return null;
}
