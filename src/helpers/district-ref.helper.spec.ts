import {
  extractDistrictRef,
  matchDistrict,
  matchDistrictName,
  normalizeDistrictRef,
  type DistrictRecord,
} from './district-ref.helper';

/** Prod bazasidagi bilan AYNI (andijon-districts.geojson). */
const DISTRICTS: DistrictRecord[] = [
  {
    id: 'city',
    key: 'andijon-sh',
    code: 'andijon_sh',
    soato: '1703401',
    name: 'Andijon shahri',
  },
  {
    id: 'rayon',
    key: 'andijon',
    code: 'andijon',
    soato: '1703203',
    name: 'Andijon tumani',
  },
  {
    id: 'boston',
    key: 'boz',
    code: 'boz',
    soato: '1703212',
    name: 'Bo‘ston tumani',
  },
  {
    id: 'xonobod',
    key: 'xonobod-sh',
    code: 'xonobod_sh',
    soato: '1703405',
    name: 'Xonobod shahri',
  },
  {
    id: 'qorgon',
    key: 'qorgontepa',
    code: 'qorgontepa',
    soato: '1703227',
    name: 'Qo‘rg‘ontepa tumani',
  },
];

describe('normalizeDistrictRef', () => {
  it.each([
    ['Bo‘ston tumani', 'boston tumani'],
    ["Bo'ston tumani", 'boston tumani'],
    ['Boʻston  tumani', 'boston tumani'],
    ['  ANDIJON_SH ', 'andijon_sh'],
    [1703401, '1703401'],
  ])('%p → %p', (raw, expected) => {
    expect(normalizeDistrictRef(raw)).toBe(expected);
  });

  it.each<[unknown]>([[''], ['   '], [null], [{}], ['x'.repeat(65)]])(
    '%p → null',
    (raw) => {
      expect(normalizeDistrictRef(raw)).toBeNull();
    },
  );
});

describe('matchDistrict', () => {
  it('SOATO kodi (asosiy shakl)', () => {
    expect(matchDistrict('1703401', DISTRICTS)?.id).toBe('city');
    expect(matchDistrict(1703203, DISTRICTS)?.id).toBe('rayon');
  });

  it('tizim kodi', () => {
    expect(matchDistrict('boz', DISTRICTS)?.id).toBe('boston');
  });

  it('⚠️ xona moduli proshivkasining kalitlari (andijon-sh, boston)', () => {
    expect(matchDistrict('andijon-sh', DISTRICTS)?.id).toBe('city');
    expect(matchDistrict('ANDIJON-SH', DISTRICTS)?.id).toBe('city');
    expect(matchDistrict('boston', DISTRICTS)?.id).toBe('boston');
    // Qolgan kalitlar tizim kodi bilan AYNI.
    expect(matchDistrict('andijon', DISTRICTS)?.id).toBe('rayon');
    expect(matchDistrict('qorgontepa', DISTRICTS)?.id).toBe('qorgon');
  });

  it('⚠️ prototip kalitlari tuman bo‘lib qolmaydi', () => {
    expect(matchDistrict('constructor', DISTRICTS)).toBeNull();
    expect(matchDistrict('__proto__', DISTRICTS)).toBeNull();
  });

  it('⚠️ to‘liq nom — tutuq belgisi har xil yozilsa ham', () => {
    expect(matchDistrict("Bo'ston tumani", DISTRICTS)?.id).toBe('boston');
    expect(matchDistrict('Qo‘rg‘ontepa tumani', DISTRICTS)?.id).toBe('qorgon');
    expect(matchDistrict("qo'rg'ontepa tumani", DISTRICTS)?.id).toBe('qorgon');
  });

  it('⚠️ shahar va tuman ADASHMAYDI', () => {
    expect(matchDistrict('Andijon shahri', DISTRICTS)?.id).toBe('city');
    expect(matchDistrict('Andijon tumani', DISTRICTS)?.id).toBe('rayon');
  });

  it('⚠️⚠️ qisqa nom «Andijon» — kod sifatida tumanni beradi, lekin «Asaka» kabi qisqa nom QABUL QILINMAYDI', () => {
    // `andijon` — Andijon tumanining TIZIM KODI, shuning uchun topiladi.
    expect(matchDistrict('andijon', DISTRICTS)?.id).toBe('rayon');
    // `Bo'ston` — qisqa nom: kod ham, to'liq nom ham emas → aniqlanmaydi.
    expect(matchDistrict("Bo'ston", DISTRICTS)).toBeNull();
  });

  it('noma‘lum qiymat — null (taxmin qilinmaydi)', () => {
    expect(matchDistrict('9999999', DISTRICTS)).toBeNull();
    expect(matchDistrict('Toshkent', DISTRICTS)).toBeNull();
    expect(matchDistrict(undefined, DISTRICTS)).toBeNull();
  });

  it('⚠️ noaniq (ikki tuman mos) — null', () => {
    const twins = [
      ...DISTRICTS,
      {
        id: 'twin',
        key: 'twin',
        code: 'twin',
        soato: '1703401',
        name: 'Egizak',
      },
    ];
    expect(matchDistrict('1703401', twins)).toBeNull();
  });
});

describe('matchDistrict — proshivka kalitlari (kotyol v2.1.0, xona v1.1.0)', () => {
  it.each([
    ['andijon-sh', 'city'],
    ['xonobod-sh', 'xonobod'],
    ['boz', 'boston'],
    ['qorgontepa', 'qorgon'],
    ['andijon', 'rayon'],
    // ⚠️ Katta harf yoki bo'shliq — proshivka yubormaydi, lekin zarar ham yo'q.
    [' ASAKA-YOQ ', null],
  ])('%p → %p', (raw, expected) => {
    expect(matchDistrict(raw, DISTRICTS)?.id ?? null).toBe(expected);
  });

  it('⚠️ noma‘lum kalit — null (so‘rov rad etilmaydi, maydon e‘tiborsiz)', () => {
    expect(matchDistrict('toshkent', DISTRICTS)).toBeNull();
    expect(matchDistrict('constructor', DISTRICTS)).toBeNull();
  });
});

describe('extractDistrictRef', () => {
  it('asosiy maydon — `district`', () => {
    expect(extractDistrictRef({ district: '1703401' })).toBe('1703401');
  });

  it('muqobil nomlar', () => {
    expect(extractDistrictRef({ soato: 1703206 })).toBe(1703206);
    expect(extractDistrictRef({ tuman: 'Asaka tumani' })).toBe('Asaka tumani');
  });

  it('⚠️ yo‘q — undefined (eski proshivka)', () => {
    expect(
      extractDistrictRef({ device_id: 'x', temperature_c: 60 }),
    ).toBeUndefined();
  });
});

describe('matchDistrictName — MFY fayli', () => {
  it.each([
    ['Andijon shahri', 'city'],
    ['Andijon sh.', 'city'],
    ['Andijon tumani', 'rayon'],
    ["Bo'ston tumani", 'boston'],
    ["Bo'z tumani", 'boston'],
    ['Xonobod shahri', 'xonobod'],
    ['Qo‘rg‘ontepa tumani', 'qorgon'],
    ['xonobod-sh', 'xonobod'],
  ])('%p → %p', (raw, expected) => {
    expect(matchDistrictName(raw, DISTRICTS)?.id ?? null).toBe(expected);
  });

  it('qo‘shimchasiz «andijon» — proshivka kaliti, ya‘ni Andijon TUMANI', () => {
    expect(matchDistrictName('Andijon', DISTRICTS)?.id ?? null).toBe('rayon');
  });

  it('noma‘lum — null', () => {
    expect(matchDistrictName('Toshkent tumani', DISTRICTS)).toBeNull();
  });
});
