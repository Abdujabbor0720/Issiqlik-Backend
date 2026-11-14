/**
 * SANA — faqat shu yerda formatlanadi.
 *
 * ⚠️ `toLocaleDateString('uz-UZ')` ISHLATILMAYDI: natija kod yozilgan
 * joyga emas, kod ISHLAYOTGAN muhitga bog'liq — Node ICU qurilishi,
 * konteyner locale'i. Shu sababli bitta jadvalda bir ustun «21-may, 2025»,
 * ikkinchisi «21.05.2025» bo'lib qolardi.
 */
const MONTHS_UZ = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

const MONTHS_UZ_CAP = MONTHS_UZ.map(
  (month) => month[0].toUpperCase() + month.slice(1),
);

/** Toshkent (+5, DST yo'q) — tizimning yagona mintaqasi. */
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function toTashkent(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + TASHKENT_OFFSET_MS);
}

/** `21-may, 2025` */
export function formatDateUz(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = toTashkent(value);
  if (!date) return '—';
  return `${date.getUTCDate()}-${MONTHS_UZ[date.getUTCMonth()]}, ${date.getUTCFullYear()}`;
}

/** `21-may, 2025 14:30` */
export function formatDateTimeUz(
  value: Date | string | null | undefined,
): string {
  if (!value) return '—';
  const date = toTashkent(value);
  if (!date) return '—';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${formatDateUz(value)} ${hh}:${mm}`;
}

/** `14:30` */
export function formatTimeUz(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = toTashkent(value);
  if (!date) return '—';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `Yanvar, 2026` */
export function formatMonthUz(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = toTashkent(value);
  if (!date) return '—';
  return `${MONTHS_UZ_CAP[date.getUTCMonth()]}, ${date.getUTCFullYear()}`;
}

/**
 * Toshkent kunining BOSHI — UTC instant sifatida.
 * ⚠️ «Bugungi o'rtacha harorat» aynan shundan hisoblanadi: UTC yarim
 * tunidan hisoblansa, kun soat 05:00 da almashardi.
 */
export function tashkentDayStart(value: Date = new Date()): Date {
  const shifted = new Date(value.getTime() + TASHKENT_OFFSET_MS);
  const midnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(midnight - TASHKENT_OFFSET_MS);
}
