import { ProbeKind } from '../common/constants/enums';

/**
 * DS18B20 ning FIZIK o'lchov diapazoni, °C (datchik dalolatnomasi).
 *
 * ⚠️⚠️ Bundan tashqaridagi qiymat — O'LCHOV EMAS, NOSOZLIK KODI.
 * Klassik qiymatlar: `-127` (sim uzilgan, shina bo'sh) va `85`
 * (quvvat berilgandan keyin hali o'lchamagan — lekin 85 diapazon
 * ICHIDA va uni proshivkaning o'zi filtrlaydi, `main.cpp` dagi
 * `lastGood` tekshiruvi).
 *
 * ⚠️ Texnik topshiriq (§3) aynan shu chegarani talab qiladi:
 * «Harorat oralig'i: -55..125 °C. Undan tashqarisi 422».
 */
export const DS18B20_MIN_C = -55;
export const DS18B20_MAX_C = 125;

/** Qurilmadan kelgan XOM haroratlar (hali tasniflanmagan). */
export interface RawProbeInput {
  /** `inlet_temperature_c` — juftlik kelganda. */
  inlet?: number | null;
  /** `outlet_temperature_c` — juftlik kelganda. */
  outlet?: number | null;
  /** `temperature_c` yoki eski `temperature` — YAKKA qiymat. */
  single?: number | null;
  /** `probe` maydoni: yakka qiymat qaysi quvurdan ekani. */
  probeHint?: string | null;
}

/** Diapazondan tashqarida bo'lgani uchun tashlangan qiymat. */
export interface RejectedProbe {
  probe: 'inlet' | 'outlet' | 'single';
  value: number;
}

export interface ClassifiedReading {
  /** Kirish (obratka) harorati yoki `null`. */
  inlet: number | null;
  /**
   * CHIQISH harorati yoki `null`.
   *
   * ⚠️⚠️ `null` bo'lsa, kotyol holatini BILMAYMIZ. Bu yerga kirish
   * qiymatini «hech bo'lmasa biror son bo'lsin» deb qo'yish — butun
   * tizimdagi eng xavfli xato bo'lardi (obratka doim sovuqroq).
   */
  outlet: number | null;
  probe: ProbeKind;
  /** Nosozlik dalili — jurnalga yoziladi, yo'qolmaydi. */
  rejected: RejectedProbe[];
}

/** Diapazonda bo'lsa — qiymat, aks holda `null`. */
function usable(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  if (value < DS18B20_MIN_C || value > DS18B20_MAX_C) return null;
  return value;
}

/**
 * HARORATLARNI TASNIFLASH — qaysi son qaysi quvurga tegishli.
 *
 * ⚠️⚠️ BU FUNKSIYA TIZIMNING ENG XAVFLI JOYI va shu sababli
 * ALOHIDA, SOF funksiya: bazaga ham, so'rovga ham, vaqtga ham
 * bog'liq emas va to'liq test bilan qoplangan. Mantiq servis
 * ichiga yoyilsa, bir kuni kimdir «yakka qiymatni haroratga
 * yozaveramiz» deb yozib qo'yardi va butun viloyat holati
 * ~20 °C pastga siljirdi.
 *
 * ⚠️⚠️ ESKI PANELDAGI XATONI TAKRORLAMAYDI. U yerda
 * (`worker.js:218`) juftlik kelganda KIRISH harorati asosiy ustunga
 * yoziladi:
 *     paired ? inlet_temperature_c : temperature_c
 * Natijada obratka qiymati «chiqish harorati» bo'lib hisobga olinadi.
 *
 * QOIDALAR (ketma-ketlik muhim):
 *   1) Ikkala quvur ham yaroqli        → `BOTH`, ikkisi ham yoziladi;
 *   2) Yakka qiymat + `probe:"inlet"`  → `INLET`, chiqish `null`;
 *   3) Yakka qiymat + `probe:"outlet"` → `OUTLET`;
 *   4) Yakka qiymat, ishora YO'Q       → `UNKNOWN`, CHIQISH deb olinadi
 *      (eski proshivkalar aynan chiqish haroratini yuboradi);
 *   5) Faqat bittasi yaroqli (juftlikdan biri diapazondan chiqqan)
 *      → o'sha quvur bo'yicha `INLET`/`OUTLET`;
 *   6) Hech biri yaroqli emas          → `null` (chaqiruvchi 422 beradi).
 *
 * @returns Tasniflangan o'lchov yoki `null` — birorta yaroqli harorat yo'q.
 */
export function classifyProbeReading(
  input: RawProbeInput,
): ClassifiedReading | null {
  const rejected: RejectedProbe[] = [];

  const note = (probe: RejectedProbe['probe'], raw: unknown): void => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      rejected.push({ probe, value: raw });
    }
  };

  const inlet = usable(input.inlet);
  const outlet = usable(input.outlet);
  const single = usable(input.single);

  if (inlet === null) note('inlet', input.inlet);
  if (outlet === null) note('outlet', input.outlet);
  if (single === null) note('single', input.single);

  /*
   * ⚠️ ANIQ ATALGAN JUFTLIK — ENG ISHONCHLI ma'lumot, shuning uchun
   * birinchi tekshiriladi. Qurilma juftlik yuborganda `probe`
   * maydonini YUBORMAYDI (`main.cpp` dagi `buildJson`), demak bu
   * yerda ishoraga qarashning ma'nosi yo'q.
   */
  if (inlet !== null && outlet !== null) {
    return { inlet, outlet, probe: ProbeKind.BOTH, rejected };
  }

  /*
   * ⚠️ YAKKA QIYMAT. `probe` ishorasi — qurilma bizga aytgan
   * YAGONA narsa, qaysi datchik tirik qolgani haqida. Unga
   * ishonmasdan «chiqish» deb olish — 50% hollarda sovuq obratkani
   * chiqish harorati o'rniga qo'yish demak.
   */
  if (single !== null) {
    const hint = (input.probeHint ?? '').trim().toLowerCase();

    if (hint === 'inlet') {
      /*
       * ⚠️⚠️ CHIQISH `null` QOLADI va bu ATAYLAB. Chiqish datchigi
       * nosoz, demak kotyol harorati NOMA'LUM. Shu yerga `single`
       * qiymatini qo'yish eng xatarli «yaxshilik» bo'lardi: obratka
       * 45 °C bo'lsa, kotyol «o'rta ishlayotgan» bo'lib ko'rinardi —
       * holbuki u 90 °C da ham, 30 °C da ham bo'lishi mumkin.
       * Buning o'rniga «datchik nosoz» ogohlantirishi ochiladi.
       */
      return { inlet: single, outlet: null, probe: ProbeKind.INLET, rejected };
    }

    if (hint === 'outlet') {
      return {
        inlet: null,
        outlet: single,
        probe: ProbeKind.OUTLET,
        rejected,
      };
    }

    /*
     * ⚠️ ISHORA YO'Q — `UNKNOWN`. Qiymat CHIQISH deb olinadi, chunki
     * eski proshivkalar (`modul1` va birinchi avlod v1.x) aynan chiqish
     * haroratini yuboradi (§3: «probe'siz temperature_c ni
     * "noma'lum datchik" deb saqla»). Lekin bu TAXMIN va `UNKNOWN`
     * holati uni belgilab turadi: grafikda ham, kotyol kartasida
     * ham «aniqlanmagan datchik» deb ko'rsatiladi.
     */
    return {
      inlet: null,
      outlet: single,
      probe: ProbeKind.UNKNOWN,
      rejected,
    };
  }

  /*
   * ⚠️ JUFTLIKNING FAQAT BITTASI YAROQLI. Masalan kirish datchigi
   * uzilib, `-127` yuborgan. Butun o'lchovni 422 bilan rad etish
   * ma'lumotni behuda yo'qotardi: chiqish harorati YAROQLI va
   * kotyol holatini aniqlash uchun aynan u kerak.
   */
  if (outlet !== null) {
    return { inlet: null, outlet, probe: ProbeKind.OUTLET, rejected };
  }
  if (inlet !== null) {
    return { inlet, outlet: null, probe: ProbeKind.INLET, rejected };
  }

  // Birorta yaroqli harorat yo'q — chaqiruvchi 422 qaytaradi.
  return null;
}

/**
 * KIRISH-CHIQISH AYIRMASI («delta»), °C.
 *
 * ⚠️⚠️ ENG AYYOR NOSOZLIKNI AYNAN SHU KO'RSATADI: kotyol issiq,
 * chiqish harorati me'yorda, holat «faol» — lekin nasos to'xtagan
 * yoki ventil yopiq va issiqlik BINOGA BORMAYAPTI. Bitta datchik
 * bilan bu holatni umuman ko'rib bo'lmasdi: hamma ko'rsatkich
 * yashil turardi, bino esa sovuq bo'lardi.
 *
 * @returns Ayirma yoki `null` — ikki qiymatdan biri yo'q.
 */
export function temperatureDelta(
  inlet: number | null,
  outlet: number | null,
): number | null {
  if (inlet === null || outlet === null) return null;
  return Number((outlet - inlet).toFixed(2));
}
