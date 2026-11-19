import { DeviceType } from '../common/constants/enums';

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
const DEVICE_TYPE_ALIASES: Record<string, DeviceType> = {
  boiler: DeviceType.KOTYOL,
  kotyol: DeviceType.KOTYOL,
  qozonxona: DeviceType.KOTYOL,
  room: DeviceType.XONA,
  xona: DeviceType.XONA,
};

const FIELDS = {
  deviceType: ['device_type', 'deviceType', 'module_type', 'moduleType'],
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
export function parseDeviceType(raw: unknown): DeviceType | null {
  if (typeof raw !== 'string') return null;
  return DEVICE_TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
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
 * MUASSASA NOMINI SOLISHTIRISH UCHUN NORMALLASHTIRISH.
 *
 * ⚠️ Faqat SOLISHTIRISH uchun (ko'rsatish uchun emas): «12-Maktab»,
 * «12-maktab » va «12‑maktab» (boshqa defis) bitta muassasa. Tutuq belgisining
 * har xil yozilishi ham olib tashlanadi (`Bo'ston` = `Bo‘ston`).
 */
export function normalizeInstitutionName(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʻʼ'`´]/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
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
    'device_type' | 'mfy' | 'institution_name' | 'object_type' | 'humidity';
  value: unknown;
}

export interface ReportedProfile {
  /**
   * Plata AYTGAN tur (sarlavha yoki tana). `null` — aytmagan: eski
   * proshivka yoki xona modulining 1.0.0 versiyasi.
   */
  declaredType: DeviceType | null;
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
  headerDeviceType: unknown,
): ReportedProfile {
  const rejected: RejectedProfileField[] = [];

  const declaredRaw =
    typeof headerDeviceType === 'string' && headerDeviceType.trim()
      ? headerDeviceType
      : pick(raw, FIELDS.deviceType);
  const declaredType = parseDeviceType(declaredRaw);
  if (declaredRaw !== undefined && declaredType === null) {
    rejected.push({ field: 'device_type', value: declaredRaw });
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
 * TANADAN TURNI ANIQLASH — `X-Device-Type` sarlavhasi bo'lmaganda.
 *
 * Spetsifikatsiya (§2): `room_temperature_c` bor → `xona`, aks holda
 * `kotyol`. Eski kotyol proshivkasi (v2.0.0) sarlavha yubormaydi va
 * `room_temperature_c` ni hech qachon yubormaydi; xona moduli v1.0.0 ham
 * sarlavhasiz, lekin `room_temperature_c` yuboradi.
 *
 * ⚠️ `rooms[]` massivi xona moduli EMAS — u kotyol modulining qo'shimcha
 * xona datchiklari; shuning uchun faqat YAKKA `room_temperature_c` hisobga
 * olinadi.
 */
export function inferDeviceType(input: {
  hasRoomTemperatureField: boolean;
}): DeviceType {
  return input.hasRoomTemperatureField ? DeviceType.XONA : DeviceType.KOTYOL;
}

export interface DeviceTypeDecision {
  /** Bazaga yoziladigan yangi tur; `null` — o'zgarmaydi. */
  next: DeviceType | null;
  /** Jurnalga yoziladigan ogohlantirish; `null` — hammasi joyida. */
  warning: string | null;
}

/**
 * TURNI SAQLASH QARORI.
 *
 * ⚠️⚠️ AYTILGAN tur (sarlavha / OTA `type=`) bazaga yoziladi va avvalgisidan
 * farq qilsa — ogohlantirish. Proshivka o'zi qaysi plata ekanini biladi.
 *
 * ⚠️⚠️ TANADAN XULOSA qilingan tur saqlanganini O'ZGARTIRMAYDI — faqat
 * ogohlantiradi. Sabab: DHT22 datchigi uzilgan eski xona moduli
 * `room_temperature_c` ni yubormay qoladi va qoida uni «kotyol» deb
 * hisoblaydi. Shu xulosa yozilsa, keyingi OTA tekshiruvida (eski proshivka
 * `type=` yubormaydi) xona platasiga KOTYOL `.bin` taklif qilinardi va plata
 * datchiksiz qolib, faqat qo'lda tiklanardi. Yangi qurilmaning turi esa
 * ro'yxatga olishda shu xulosadan olinadi (`pending_devices.device_type`).
 */
export function decideDeviceType(input: {
  declared: DeviceType | null;
  inferred: DeviceType | null;
  stored: DeviceType;
}): DeviceTypeDecision {
  if (input.declared) {
    if (input.declared === input.stored) return { next: null, warning: null };
    return {
      next: input.declared,
      warning:
        `qurilma turi o‘zgardi: ${input.stored} → ${input.declared} ` +
        '(qurilma o‘zi aytdi)',
    };
  }
  if (input.inferred && input.inferred !== input.stored) {
    return {
      next: null,
      warning:
        `tanadan aniqlangan tur (${input.inferred}) saqlangan turdan ` +
        `(${input.stored}) farq qiladi — tur O‘ZGARTIRILMADI ` +
        '(datchik nosozligini tekshiring)',
    };
  }
  return { next: null, warning: null };
}
