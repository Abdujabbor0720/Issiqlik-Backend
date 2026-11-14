import { ProbeKind } from '../common/constants/enums';
import {
  DS18B20_MAX_C,
  DS18B20_MIN_C,
  classifyProbeReading,
  temperatureDelta,
} from './probe-reading.helper';

/**
 * ⚠️⚠️ BU TEST TIZIMNING ENG XAVFLI QOIDASINI QO'RIQLAYDI:
 * «asosiy harorat — DOIM CHIQISH». Agar kelajakda kimdir
 * tasniflashni «soddalashtirsa» va kirish qiymati chiqish o'rniga
 * tushib qolsa, butun viloyat holati ~20 °C pastga siljib, yolg'on
 * «ishlamayotgan» ogohlantirishlari boshlanardi. Shu xato aynan
 * mavjud Xonobod panelida bor (`worker.js:218`) — pastdagi
 * «XONOBOD XATOSI» testi uni takrorlanmasligini kafolatlaydi.
 */
describe('classifyProbeReading', () => {
  describe('juftlik (ikkala datchik ishlayapti)', () => {
    it('ikkisini ham to‘g‘ri quvurga qo‘yadi', () => {
      const result = classifyProbeReading({ inlet: 45.12, outlet: 60.5 });

      expect(result).toEqual({
        inlet: 45.12,
        outlet: 60.5,
        probe: ProbeKind.BOTH,
        rejected: [],
      });
    });

    it('XONOBOD XATOSI: kirish haroratini chiqish o‘rniga QO‘YMAYDI', () => {
      // Obratka 30 °C, podacha 70 °C — real qish holati.
      const result = classifyProbeReading({ inlet: 30, outlet: 70 });

      // ⚠️ Chiqish 70 bo'lishi SHART. 30 bo'lsa, kotyol «ishlamayotgan»
      //    (20–40 oralig'i) bo'lib ko'rinardi — holbuki u faol ishlayapti.
      expect(result?.outlet).toBe(70);
      expect(result?.inlet).toBe(30);
    });

    it('juftlik kelganda `probe` ishorasiga QARAMAYDI', () => {
      // Qurilma juftlik bilan `probe` yubormaydi, lekin kimdir
      // qo'lda yuborsa ham, aniq atalgan maydonlar ustun turadi.
      const result = classifyProbeReading({
        inlet: 40,
        outlet: 65,
        probeHint: 'inlet',
      });

      expect(result?.probe).toBe(ProbeKind.BOTH);
      expect(result?.outlet).toBe(65);
    });
  });

  describe('yakka datchik', () => {
    it('`probe: "outlet"` — chiqish chizig‘iga tushadi', () => {
      const result = classifyProbeReading({
        single: 60.5,
        probeHint: 'outlet',
      });

      expect(result).toEqual({
        inlet: null,
        outlet: 60.5,
        probe: ProbeKind.OUTLET,
        rejected: [],
      });
    });

    it('⚠️ `probe: "inlet"` — CHIQISH `null` qoladi, taxmin qilinmaydi', () => {
      const result = classifyProbeReading({ single: 45, probeHint: 'inlet' });

      expect(result?.inlet).toBe(45);
      // ⚠️⚠️ ENG MUHIM TASDIQ: 45 ni chiqishga ko'chirish mumkin EMAS.
      //    Chiqish datchigi nosoz — harorat NOMA'LUM va holat ham noma'lum.
      expect(result?.outlet).toBeNull();
      expect(result?.probe).toBe(ProbeKind.INLET);
    });

    it('ishora yo‘q (eski proshivka) — chiqish deb olinadi, `UNKNOWN`', () => {
      const result = classifyProbeReading({ single: 54.5 });

      expect(result).toEqual({
        inlet: null,
        outlet: 54.5,
        probe: ProbeKind.UNKNOWN,
        rejected: [],
      });
    });

    it('notanish ishora — ishora yo‘q deb qaraladi', () => {
      // Buzuq yoki soxta mijoz `probe: "both"` yuborsa ham, yakka
      // qiymat juftlikka aylanib qolmaydi.
      const result = classifyProbeReading({ single: 54.5, probeHint: 'both' });

      expect(result?.probe).toBe(ProbeKind.UNKNOWN);
      expect(result?.outlet).toBe(54.5);
    });

    it('ishora katta harf yoki bo‘sh joy bilan kelsa ham tushunadi', () => {
      const result = classifyProbeReading({
        single: 45,
        probeHint: '  INLET ',
      });

      expect(result?.probe).toBe(ProbeKind.INLET);
      expect(result?.outlet).toBeNull();
    });
  });

  describe('diapazon: -55…125 °C', () => {
    it('chegaradagi qiymatlarni QABUL qiladi', () => {
      expect(classifyProbeReading({ single: DS18B20_MIN_C })?.outlet).toBe(-55);
      expect(classifyProbeReading({ single: DS18B20_MAX_C })?.outlet).toBe(125);
    });

    it('-127 (sim uzilgan) — yaroqsiz', () => {
      expect(classifyProbeReading({ single: -127 })).toBeNull();
    });

    it('126 °C — yaroqsiz', () => {
      expect(classifyProbeReading({ single: 126 })).toBeNull();
    });

    it('⚠️ juftlikning bittasi buzuq bo‘lsa, BUTUN o‘lchov tashlanmaydi', () => {
      // Kirish datchigi uzilgan (-127), chiqish esa YAROQLI.
      const result = classifyProbeReading({ inlet: -127, outlet: 62 });

      expect(result?.outlet).toBe(62);
      expect(result?.inlet).toBeNull();
      expect(result?.probe).toBe(ProbeKind.OUTLET);
      // ⚠️ Nosozlik DALILI yo'qolmaydi — jurnalga tushadi.
      expect(result?.rejected).toEqual([{ probe: 'inlet', value: -127 }]);
    });

    it('chiqish buzuq, kirish yaroqli — `INLET` bo‘ladi', () => {
      const result = classifyProbeReading({ inlet: 44, outlet: -127 });

      expect(result?.probe).toBe(ProbeKind.INLET);
      expect(result?.outlet).toBeNull();
      expect(result?.inlet).toBe(44);
    });

    it('ikkisi ham buzuq — `null` (chaqiruvchi 422 beradi)', () => {
      expect(classifyProbeReading({ inlet: -127, outlet: -127 })).toBeNull();
    });
  });

  describe('bo‘sh va buzuq yuk', () => {
    it('hech qanday harorat yo‘q — `null`', () => {
      expect(classifyProbeReading({})).toBeNull();
    });

    it('`null` va `undefined` qiymatlar — `null`', () => {
      expect(
        classifyProbeReading({ inlet: null, outlet: undefined, single: null }),
      ).toBeNull();
    });

    it('`NaN` — `null` (`Number("abc")` natijasi)', () => {
      expect(classifyProbeReading({ single: Number.NaN })).toBeNull();
    });

    it('`Infinity` — `null`', () => {
      expect(
        classifyProbeReading({ single: Number.POSITIVE_INFINITY }),
      ).toBeNull();
    });

    it('⚠️ 0 °C — YAROQLI qiymat, `null` bilan aralashtirilmaydi', () => {
      // `if (!value)` deb yozilsa, 0 °C «qiymat yo'q» bo'lib ketardi —
      // qishda esa 0 °C aynan eng muhim o'lchov.
      const result = classifyProbeReading({ single: 0, probeHint: 'outlet' });

      expect(result?.outlet).toBe(0);
      expect(result?.probe).toBe(ProbeKind.OUTLET);
    });

    it('⚠️ manfiy harorat (-10 °C) YAROQLI', () => {
      expect(classifyProbeReading({ single: -10 })?.outlet).toBe(-10);
    });
  });
});

describe('temperatureDelta', () => {
  it('chiqish minus kirish', () => {
    expect(temperatureDelta(45, 60)).toBe(15);
  });

  it('kasr qiymatlarni 2 xonaga yumaloqlaydi', () => {
    // 60.5 - 45.12 = 15.379999999999995 (suzuvchi nuqta xatosi)
    expect(temperatureDelta(45.12, 60.5)).toBe(15.38);
  });

  it('nasos to‘xtagan: delta ≈ 0', () => {
    expect(temperatureDelta(58.2, 58.4)).toBe(0.2);
  });

  it('⚠️ teskari ulangan datchiklar: delta MANFIY bo‘ladi', () => {
    // Bu montaj xatosining aniq belgisi: obratka chiqishdan issiq
    // bo'lishi mumkin emas. Qiymat yashirilmaydi, ko'rsatiladi.
    expect(temperatureDelta(70, 50)).toBe(-20);
  });

  it('bittasi yo‘q bo‘lsa — `null`', () => {
    expect(temperatureDelta(null, 60)).toBeNull();
    expect(temperatureDelta(45, null)).toBeNull();
    expect(temperatureDelta(null, null)).toBeNull();
  });

  it('⚠️ delta 0 bo‘lsa, `null` QAYTARMAYDI', () => {
    // `return delta || null` deb yozilsa, eng muhim nosozlik
    // («suv aylanmayapti») jimgina «ma'lumot yo'q» bo'lib ketardi.
    expect(temperatureDelta(55, 55)).toBe(0);
  });
});
