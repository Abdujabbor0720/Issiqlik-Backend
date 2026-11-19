import { DeviceType } from '../common/constants/enums';

/**
 * `.bin` ICHIDAGI BELGILARNI O'QISH — versiya va modul turi.
 *
 * ⚠️⚠️ BELGILAR PROSHIVKADA QOTIRILGAN (kotyol v2.1.0, xona v1.1.0):
 *   const char FW_VERSION_MARK[] = "ANDIJON_FW_VERSION=" FW_VERSION ";";
 *   const char FW_MODULE_MARK[]  = "ANDIJON_FW_MODULE=" "kotyol" ";";
 *
 * Eski binarlarda prefiks boshqa (`XONOBOD_FW_VERSION=` — kotyol v2.0.0,
 * `XONA_FW_VERSION=` — xona v1.0.0) va MODUL BELGISI YO'Q. Shuning uchun
 * versiya UMUMIY ifoda bilan izlanadi va `ANDIJON` prefiksi ustun turadi.
 *
 * ⚠️ Sof funksiya: `FirmwareService` yuklashda, `inspect` endpoint esa
 * yuklashdan oldin ko'rsatish uchun chaqiradi — ikkalasida AYNI qoida.
 */

export const PRIMARY_MARKER_PREFIX = 'ANDIJON';

/** `ANDIJON_FW_VERSION=2.1.0;`, `XONOBOD_FW_VERSION=2.0.0;`, … */
const VERSION_MARK = /([A-Z]+)_FW_VERSION=(\d{1,4}\.\d{1,4}\.\d{1,4});/g;

/** `ANDIJON_FW_MODULE=kotyol;` — qiymatni keyin tekshiramiz (noma'lum so'z = xato). */
const MODULE_MARK = /ANDIJON_FW_MODULE=([A-Za-z0-9_-]{1,16});/g;

/**
 * Eski prefiks QAYSI turga ishora qiladi — faqat ziddiyatni ushlash uchun.
 * ⚠️ Turni AVTOMATIK belgilamaydi: spetsifikatsiya bo'yicha belgisiz eski
 * faylda turni yuklovchi qo'lda tanlaydi.
 */
const LEGACY_PREFIX_TYPE: ReadonlyMap<string, DeviceType> = new Map([
  ['XONOBOD', DeviceType.KOTYOL],
  ['XONA', DeviceType.XONA],
]);

export interface FirmwareMarkers {
  /** Topilgan barcha versiya belgilari (takrorlarsiz). */
  versions: Array<{ prefix: string; version: string }>;
  /** `ANDIJON_FW_MODULE=` qiymatlari (takrorlarsiz, xom). */
  modules: string[];
}

export function readFirmwareMarkers(buffer: Buffer): FirmwareMarkers {
  // ⚠️ latin1 — har bayt bitta belgi: ikkilik fayl UTF-8 sifatida o'qilsa,
  //    buzuq ketma-ketliklar belgini «yutib», belgi topilmay qolardi.
  const text = buffer.toString('latin1');
  const versions = new Map<string, { prefix: string; version: string }>();
  for (const match of text.matchAll(VERSION_MARK)) {
    const item = { prefix: match[1], version: match[2] };
    versions.set(`${item.prefix}=${item.version}`, item);
  }
  const modules = new Set<string>();
  for (const match of text.matchAll(MODULE_MARK)) modules.add(match[1]);
  return { versions: [...versions.values()], modules: [...modules] };
}

export interface FirmwareIdentity {
  version: string;
  deviceType: DeviceType;
  /** `marker` — tur `.bin` ichidan; `manual` — yuklovchi tanlagan. */
  typeSource: 'marker' | 'manual';
  /** Versiya qaysi prefiksdan olingani (`ANDIJON`, `XONOBOD`, …). */
  prefix: string;
}

export interface FirmwareInspection {
  /** Aniqlangan versiya; topilmasa yoki ziddiyatli bo'lsa `null`. */
  version: string | null;
  prefix: string | null;
  /** `.bin` ichidagi modul belgisi bo'yicha tur. */
  markedType: DeviceType | null;
  /** Belgisiz fayl uchun TAKLIF: 1.x → xona, 2.x+ → kotyol (eski prefiks ustun). */
  suggestedType: DeviceType | null;
  /** Yuklovchi turni tanlashi SHARTMI (modul belgisi yo'q). */
  needsManualType: boolean;
  /** Fayl qabul qilinmasa — sababi (o'zbekcha). */
  error: string | null;
}

const MODULE_WORDS: ReadonlyMap<string, DeviceType> = new Map([
  ['kotyol', DeviceType.KOTYOL],
  ['xona', DeviceType.XONA],
]);

/** ⚠️ Faqat kontraktdagi ikki so'z; `boiler`/`room` kabi boshqa so'z — xato. */
function parseModuleWord(raw: string): DeviceType | null {
  return MODULE_WORDS.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * BELGILARNI BAHOLASH — yuklashdan OLDIN ham ko'rsatish uchun.
 *
 * Qoidalar:
 *   1) `ANDIJON_FW_VERSION` bo'lsa — versiya undan; bir nechta TURLI
 *      `ANDIJON` versiyasi bo'lsa — xato (qaysi biri haqiqiy, noma'lum).
 *   2) `ANDIJON` yo'q bo'lsa — eski prefikslardan; ular ham YAGONA
 *      versiyaga ishora qilishi shart.
 *   3) `ANDIJON_FW_MODULE` — `kotyol` yoki `xona`; boshqa so'z yoki ikki
 *      xil qiymat — xato (faylni taxmin bilan tarqatib bo'lmaydi).
 */
export function inspectFirmwareMarkers(
  markers: FirmwareMarkers,
): FirmwareInspection {
  const result: FirmwareInspection = {
    version: null,
    prefix: null,
    markedType: null,
    suggestedType: null,
    needsManualType: true,
    error: null,
  };

  const primary = markers.versions.filter(
    (item) => item.prefix === PRIMARY_MARKER_PREFIX,
  );
  const pool = primary.length > 0 ? primary : markers.versions;
  const distinct = [...new Set(pool.map((item) => item.version))];

  if (distinct.length === 0) {
    result.error =
      'Fayl ichida versiya belgisi topilmadi (ANDIJON_FW_VERSION=x.y.z;) — ' +
      'bu bizning proshivkamiz emas yoki yig‘ishda belgi tushib qolgan';
    return result;
  }
  if (distinct.length > 1) {
    result.error = `Fayl ichida bir nechta versiya belgisi bor (${distinct.join(', ')})`;
    return result;
  }
  result.version = distinct[0];
  result.prefix = pool[0].prefix;

  if (markers.modules.length > 1) {
    result.error = `Fayl ichida bir nechta modul belgisi bor (${markers.modules.join(', ')})`;
    return result;
  }
  if (markers.modules.length === 1) {
    const type = parseModuleWord(markers.modules[0]);
    if (!type) {
      result.error = `Noma‘lum modul belgisi: ANDIJON_FW_MODULE=${markers.modules[0]}`;
      return result;
    }
    result.markedType = type;
    result.suggestedType = type;
    result.needsManualType = false;
    return result;
  }

  const legacyHint = LEGACY_PREFIX_TYPE.get(result.prefix) ?? null;
  const major = Number(result.version.split('.')[0]);
  result.suggestedType =
    legacyHint ?? (major <= 1 ? DeviceType.XONA : DeviceType.KOTYOL);
  return result;
}

/**
 * YAKUNIY QAROR — yuklash paytida.
 *
 * ⚠️⚠️ Modul belgisi bor faylda yuklovchining tanlovi faqat TASDIQ: u
 * belgiga zid bo'lsa — xato (kimdir xona `.bin` ini kotyol deb yuklamoqchi).
 * Belgisiz faylda tanlov MAJBURIY; eski prefiksga zid tanlov ham xato
 * (`XONA_FW_VERSION` li faylni kotyol deb bo'lmaydi).
 *
 * @throws Error — xabar foydalanuvchiga ko'rsatiladi.
 */
export function resolveFirmwareIdentity(
  markers: FirmwareMarkers,
  declaredType: DeviceType | null | undefined,
  declaredVersion?: string | null,
): FirmwareIdentity {
  const inspected = inspectFirmwareMarkers(markers);
  if (inspected.error || !inspected.version || !inspected.prefix) {
    throw new Error(inspected.error ?? 'Versiya aniqlanmadi');
  }

  if (declaredVersion && declaredVersion !== inspected.version) {
    throw new Error(
      `Kiritilgan versiya (${declaredVersion}) fayl ichidagi belgiga ` +
        `(${inspected.version}) mos emas`,
    );
  }

  if (inspected.markedType) {
    if (declaredType && declaredType !== inspected.markedType) {
      throw new Error(
        `Fayl ichidagi belgi bo‘yicha bu «${inspected.markedType}» proshivkasi, ` +
          `siz esa «${declaredType}» ni tanladingiz — tekshiring`,
      );
    }
    return {
      version: inspected.version,
      deviceType: inspected.markedType,
      typeSource: 'marker',
      prefix: inspected.prefix,
    };
  }

  if (!declaredType) {
    throw new Error(
      'Faylda modul belgisi (ANDIJON_FW_MODULE) yo‘q — turini qo‘lda tanlang ' +
        `(taklif: ${inspected.suggestedType ?? 'kotyol'})`,
    );
  }

  const legacyHint = LEGACY_PREFIX_TYPE.get(inspected.prefix) ?? null;
  if (legacyHint && legacyHint !== declaredType) {
    throw new Error(
      `Eski belgi ${inspected.prefix}_FW_VERSION «${legacyHint}» moduliga tegishli, ` +
        `siz esa «${declaredType}» ni tanladingiz`,
    );
  }

  return {
    version: inspected.version,
    deviceType: declaredType,
    typeSource: 'manual',
    prefix: inspected.prefix,
  };
}
