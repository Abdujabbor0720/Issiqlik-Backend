/**
 * XONA (HAVO) HARORATI — qurilma yukidan o'qish va baholash.
 *
 * ⚠️⚠️ NIMA UCHUN ALOHIDA, SOF FUNKSIYALAR. Xona yuki proshivkadan
 * keladi va uni BOSHQA odam yozadi. Shakl bir necha xil bo'lishi
 * mumkin (massiv / obyekt / yakka qiymat), kalitlar katta-kichik
 * harfda, qiymatlar satr bo'lib. Bu mantiq servis ichiga yoyilsa,
 * test qilib bo'lmasdi — xato esa dalada, qishda bilinardi.
 */

/**
 * HAVO HARORATINING ISHONCHLI DIAPAZONI, °C.
 *
 * ⚠️⚠️ DS18B20 diapazoni (-55…125) EMAS. Datchik 125 °C ni o'lchay
 * oladi, lekin XONADAGI HAVO hech qachon bunday bo'lmaydi. Eng
 * muhimi — `85` qiymati: bu DS18B20 ning quvvat berilgandagi
 * (hali o'lchamagan) qiymati va u dalada eng ko'p uchraydigan
 * nosozlik. Suv uchun 85 °C haqiqiy bo'lishi mumkin, havo uchun —
 * yo'q. Bu chegara uni o'z-o'zidan rad etadi; aks holda bitta
 * qayta yoqilgan plata viloyat bo'yicha «o'rtacha xona harorati»ni
 * ko'tarib, yolg'on «xona issiq» ogohlantirishini ochardi.
 *
 * 70 °C — qozonxona xonasidagi havo uchun ham yetarli zaxira.
 */
export const AIR_MIN_C = -40;
export const AIR_MAX_C = 70;

/**
 * BITTA YUKDAGI XONALAR CHEGARASI.
 *
 * ⚠️ Nosoz yoki buzilgan proshivka har safar YANGI kalitlar bilan
 * yuborsa, har kalit uchun xona AVTOMATIK yaratiladi. Chegara
 * bo'lmasa, bitta plata bir kechada minglab «xona» yaratib, kotyol
 * sahifasini ishlatib bo'lmaydigan qilardi.
 */
export const MAX_ROOMS_PER_PAYLOAD = 32;

/** Xona kaliti — datchikning doimiy identifikatori. */
export const ROOM_KEY_MAX_LEN = 64;

/** Yaroqli xona o'lchovi. */
export interface RoomSample {
  /** Normallashtirilgan kalit (kichik harf). */
  key: string;
  temperature: number;
}

/** Rad etilgan qiymat — DALIL sifatida jurnalga yoziladi. */
export interface RejectedRoomSample {
  key: string | null;
  value: unknown;
  reason: 'key' | 'value' | 'range' | 'duplicate' | 'overflow';
}

export interface ParsedRoomSamples {
  samples: RoomSample[];
  rejected: RejectedRoomSample[];
  /**
   * Xona qiymati QAYSI shaklda kelgan (`extractRoomSamples` to'ldiradi):
   * `collection` — `rooms` massivi/obyekti, `single` — yakka maydon
   * (`room_temperature_c`), `undefined` — xona ma'lumoti umuman yo'q.
   *
   * ⚠️ Xona moduli yakka qiymatni o'z identifikatori bilan xonaga
   * yozadi: bitta binoda bir nechta xona moduli bo'ladi va hammasi
   * `xona` kalitiga tushsa, BITTA xona bo'lib bir-birini bosib ketardi.
   */
  source?: 'collection' | 'single';
}

/** Massiv elementidagi kalit nomlari — proshivka qaysi birini tanlasa ham. */
const KEY_FIELDS = ['key', 'sensor', 'id', 'addr', 'address', 'rom', 'name'];
/** Massiv elementidagi qiymat nomlari. */
const VALUE_FIELDS = [
  't',
  'temp',
  'temperature',
  'temperature_c',
  'c',
  'value',
];

const KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * KALITNI NORMALLASHTIRISH.
 *
 * ⚠️⚠️ KICHIK HARFGA o'tkaziladi. DS18B20 manzili proshivkada
 * `28FF4A…` ham, `28ff4a…` ham bo'lib chiqishi mumkin (kutubxona va
 * formatlashga qarab). Katta-kichik harf farq qilsa, AYNI datchik
 * ikkita xona bo'lib yaratilardi va tarix ikkiga bo'linardi.
 *
 * ⚠️ Bo'shliqlar `_` ga almashtiriladi: «xona 1» va «xona_1» bitta
 * kalit. Ruxsat etilmagan belgi bo'lsa — `null` (rad etiladi):
 * kalit URL va jurnalga tushadi, unga istalgan matnni qo'yib bo'lmaydi.
 */
export function normalizeRoomKey(raw: unknown): string | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
  else return null;

  const key = text.trim().toLowerCase().replace(/\s+/g, '_');
  if (!key || key.length > ROOM_KEY_MAX_LEN) return null;
  if (!KEY_PATTERN.test(key)) return null;
  return key;
}

/**
 * QIYMATNI SONGA AYLANTIRISH.
 *
 * ⚠️ `""` → `0` bo'lishiga YO'L QO'YILMAYDI (`Number("") === 0`):
 * bo'sh qiymat 0 °C bo'lib yozilsa, xona «muzlab qolgan» bo'lib
 * ko'rinardi va yolg'on ogohlantirish ochilardi.
 */
function toTemperature(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function pickField(item: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    if (item[field] !== undefined && item[field] !== null) return item[field];
  }
  return undefined;
}

/**
 * QURILMA YUKIDAN XONA O'LCHOVLARINI O'QISH.
 *
 * Qabul qilinadigan shakllar:
 *   • massiv:  `[{"key":"28ff4a…","t":21.4}, {"sensor":"xona_2","temp":"19.0"}]`
 *   • obyekt:  `{"xona_1": 21.4, "28ff4a…": 19.0}`
 *
 * ⚠️⚠️ HECH QACHON XATO TASHLAMAYDI. Xona yuki — QO'SHIMCHA ma'lumot:
 * kotyol harorati (asosiy maqsad) unga bog'liq emas. Xona qismi
 * buzuq bo'lgani uchun butun so'rovni rad etish — qurilmani o'lchovni
 * qayta-qayta yuborishga majburlab, KOTYOL ma'lumotini ham yo'qotardi.
 * Buzuq qismlar `rejected` ga tushadi va jurnalga yoziladi.
 */
export function parseRoomSamples(raw: unknown): ParsedRoomSamples {
  const samples: RoomSample[] = [];
  const rejected: RejectedRoomSample[] = [];
  const seen = new Set<string>();

  let entries: Array<{ rawKey: unknown; rawValue: unknown }> = [];

  if (Array.isArray(raw)) {
    entries = raw.map((item: unknown) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        return {
          rawKey: pickField(record, KEY_FIELDS),
          rawValue: pickField(record, VALUE_FIELDS),
        };
      }
      return { rawKey: undefined, rawValue: item };
    });
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw as Record<string, unknown>).map(
      ([rawKey, rawValue]) => ({ rawKey, rawValue }),
    );
  } else {
    return { samples, rejected };
  }

  for (const { rawKey, rawValue } of entries) {
    const key = normalizeRoomKey(rawKey);
    if (!key) {
      rejected.push({ key: null, value: rawValue, reason: 'key' });
      continue;
    }

    /*
     * ⚠️ Takror kalit — BIRINCHISI olinadi. Ikkala qiymatni o'rtacha
     * qilish yoki oxirgisini olish ham «to'g'ri» bo'lishi mumkin edi,
     * lekin muhimi — natija BARQAROR bo'lsin va dalil saqlansin.
     */
    if (seen.has(key)) {
      rejected.push({ key, value: rawValue, reason: 'duplicate' });
      continue;
    }

    const temperature = toTemperature(rawValue);
    if (temperature === null) {
      rejected.push({ key, value: rawValue, reason: 'value' });
      continue;
    }
    if (temperature < AIR_MIN_C || temperature > AIR_MAX_C) {
      rejected.push({ key, value: rawValue, reason: 'range' });
      continue;
    }

    if (samples.length >= MAX_ROOMS_PER_PAYLOAD) {
      rejected.push({ key, value: rawValue, reason: 'overflow' });
      continue;
    }

    seen.add(key);
    samples.push({ key, temperature: Math.round(temperature * 100) / 100 });
  }

  return { samples, rejected };
}

/**
 * QURILMA YUKIDA XONALAR QAYERDA.
 *
 * ⚠️ Proshivkani BOSHQA odam yozadi va kontrakt hali qotirilmagan.
 * Shuning uchun bir nechta nom qabul qilinadi; ASOSIY (hujjatdagi)
 * shakl — `rooms` massivi. Qolganlari — inson adashishiga zaxira.
 */
const ROOM_COLLECTION_FIELDS = ['rooms', 'xonalar', 'room_temperatures'];

/**
 * YAKKA HAVO DATCHIGI — massivsiz, bitta son.
 *
 * ⚠️ Eng oddiy holat: platada bitta havo datchigi. Montajchi massiv
 * yasashni bilmasligi mumkin va `"room_temperature_c": 21.4` deb
 * yuboradi. Bu qiymat BITTA xona bo'lib qabul qilinadi: bu yerda
 * vaqtinchalik `xona` kaliti bilan, telemetriya servisi esa uni QURILMA
 * identifikatoriga almashtiradi (bitta binodagi har bir modul — alohida
 * xona, `TelemetryService.roomSamplesFor`).
 */
const SINGLE_ROOM_FIELDS = [
  'room_temperature_c',
  'air_temperature_c',
  'room_temperature',
  'air_temperature',
];
export const SINGLE_ROOM_KEY = 'xona';

/**
 * XOM YUKDAN XONALARNI AJRATIB OLISH.
 *
 * ⚠️ Massiv/obyekt topilsa — YAKKA maydonlar e'tiborsiz qoldiriladi:
 * ikkalasi birga kelsa, bitta datchik ikki xona bo'lib yozilardi.
 *
 * ⚠️ Kotyolning `temperature` / `t` maydonlari bu yerda O'QILMAYDI —
 * ular suv harorati. Xona faqat ANIQ nomlangan maydondan olinadi.
 */
export function extractRoomSamples(
  raw: Record<string, unknown>,
): ParsedRoomSamples {
  for (const field of ROOM_COLLECTION_FIELDS) {
    const value = raw[field];
    if (value !== undefined && value !== null) {
      return { ...parseRoomSamples(value), source: 'collection' };
    }
  }
  for (const field of SINGLE_ROOM_FIELDS) {
    const value = raw[field];
    if (value !== undefined && value !== null && value !== '') {
      return {
        ...parseRoomSamples({ [SINGLE_ROOM_KEY]: value }),
        source: 'single',
      };
    }
  }
  return { samples: [], rejected: [] };
}

/**
 * Xona holati — sozlamadagi IKKI chegaraga nisbatan.
 *
 *   • `cold`   — minimumdan past: OGOHLANTIRISH ochiladi (qizil);
 *   • `cool`   — minimum bilan me'yor orasida: ogohlantirish YO'Q,
 *                lekin xaritada sariq — «kuzatib turing»;
 *   • `normal` — me'yorda yoki undan yuqori (yashil).
 */
export type RoomCondition = 'cold' | 'cool' | 'normal';

export interface RoomThresholds {
  /** MINIMUM: bundan PAST — sovuq, ogohlantirish (sukut: 15 °C). */
  minC: number;
  /** ME'YOR: shundan boshlab — yashil (sukut: 25 °C). */
  normC: number;
}

/**
 * XONA HOLATINI BAHOLASH.
 *
 * ⚠️ Chegaraning O'ZI yuqori holatga tegishli: aynan 15 °C da xona
 * «sovuq» EMAS, aynan 25 °C da — «me'yorda». Talab «eng past 15»
 * deb qo'yilgan, ya'ni 15 ruxsat etilgan qiymat.
 */
export function classifyRoomTemperature(
  temperature: number,
  thresholds: RoomThresholds,
): RoomCondition {
  if (temperature < thresholds.minC) return 'cold';
  if (temperature < thresholds.normC) return 'cool';
  return 'normal';
}

/**
 * XONA O'LCHOVI HALI DOLZARBMI.
 *
 * ⚠️⚠️ ESKIRGAN XONA O'RTACHAGA KIRMAYDI. Datchigi bir hafta oldin
 * uzilgan xona bazada oxirgi qiymati (masalan 22 °C) bilan turadi.
 * U o'rtacha va eng past haroratga qo'shilsa, «hamma xona iliq»
 * degan yolg'on manzara chiqardi — holbuki o'sha xona haqida hech
 * narsa bilmaymiz.
 */
export function isRoomReadingFresh(
  lastReadingAt: Date | null,
  now: Date,
  offlineAfterMinutes: number,
): boolean {
  if (!lastReadingAt) return false;
  return (
    now.getTime() - lastReadingAt.getTime() <= offlineAfterMinutes * 60_000
  );
}

/**
 * TARIXGA YOZISH VAQTI KELDIMI.
 *
 * ⚠️⚠️ HAR SIGNAL TARIXGA YOZILMAYDI. Qurilma har daqiqada yuboradi;
 * 2000 kotyol × 10 xona × 1440 daqiqa = kuniga 28 mln qator —
 * PostgreSQL buni qish davomida ko'tarolmasdi. Havo harorati esa
 * sekin o'zgaradi va 10 daqiqalik qadam grafik uchun yetarli.
 *
 * ⚠️ JORIY qiymat (`rooms.last_temperature`) baribir HAR signalda
 * yangilanadi — xarita va ogohlantirish kechikmaydi. Faqat TARIX
 * siyraklashtiriladi.
 */
export function shouldLogRoomReading(
  lastLoggedAt: Date | null,
  recordedAt: Date,
  sampleMinutes: number,
): boolean {
  if (!lastLoggedAt) return true;
  return (
    recordedAt.getTime() - lastLoggedAt.getTime() >= sampleMinutes * 60_000
  );
}

/** Xonalar bo'yicha qisqa statistika. */
export interface RoomSummary {
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

/** O'rtacha / eng past / eng yuqori — 0.1 °C aniqlikda. */
export function summarizeRoomTemperatures(values: number[]): RoomSummary {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { count: 0, avg: null, min: null, max: null };
  }

  const round1 = (value: number): number => Math.round(value * 10) / 10;
  const sum = finite.reduce((acc, value) => acc + value, 0);

  return {
    count: finite.length,
    avg: round1(sum / finite.length),
    min: round1(Math.min(...finite)),
    max: round1(Math.max(...finite)),
  };
}
