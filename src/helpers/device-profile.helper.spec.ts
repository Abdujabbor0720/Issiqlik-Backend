import { DeviceType } from '../common/constants/enums';
import {
  extractReportedProfile,
  normalizeObjectTypeKey,
  parseHumidity,
  parseDeviceType,
  decideDeviceType,
  inferDeviceType,
  sanitizeReportedText,
} from './device-profile.helper';
import { extractRoomSamples } from './room-reading.helper';

/** Xona moduli yuboradigan yuk — proshivka hujjatidagi bilan AYNI. */
const ROOM_MODULE_PAYLOAD = {
  device_id: 'esp32-0070077c641c',
  district: 'asaka',
  mfy: 'Baraka',
  institution_name: '12-maktab',
  object_type: 'school',
  room_temperature_c: 24.4,
};

describe('parseDeviceType', () => {
  it.each([
    ['room', DeviceType.XONA],
    [' ROOM ', DeviceType.XONA],
    ['xona', DeviceType.XONA],
    ['boiler', DeviceType.KOTYOL],
    ['qozonxona', DeviceType.KOTYOL],
  ])('%p → %p', (raw, expected) => {
    expect(parseDeviceType(raw)).toBe(expected);
  });

  it.each<[unknown]>([[''], ['sensor'], [1], [null], [undefined], [{}]])(
    '⚠️ noma‘lum %p → null (tur o‘zgarmaydi)',
    (raw) => {
      expect(parseDeviceType(raw)).toBeNull();
    },
  );
});

describe('sanitizeReportedText', () => {
  it('⚠️ UTF-8 o‘zbekcha harflar saqlanadi', () => {
    expect(sanitizeReportedText('Bogʻishamol')).toBe('Bogʻishamol');
    expect(sanitizeReportedText('  12-maktab  ')).toBe('12-maktab');
  });

  it('⚠️ NFC — birikuvchi belgili yozuv tayyor harfga keltiriladi', () => {
    const decomposed = 'Me\u0301';
    expect(sanitizeReportedText(decomposed)).toBe('M\u00e9');
  });

  it('⚠️ boshqaruv va yo‘nalish belgilari olib tashlanadi', () => {
    expect(sanitizeReportedText('12\n-maktab\u202e')).toBe('12-maktab');
  });

  it('⚠️ chegara BELGI bo‘yicha — ko‘p baytli harf o‘rtasidan kesilmaydi', () => {
    const text = 'ʻ'.repeat(200);
    const out = sanitizeReportedText(text, 120);
    expect(Array.from(out ?? '')).toHaveLength(120);
  });

  it.each<[unknown]>([[''], ['   '], [null], [{}], [Number.NaN]])(
    '%p → null',
    (raw) => {
      expect(sanitizeReportedText(raw)).toBeNull();
    },
  );
});

describe('normalizeObjectTypeKey', () => {
  it('katalog kalitlari', () => {
    for (const key of [
      'school',
      'kindergarten',
      'college',
      'clinic',
      'hospital',
      'admin',
      'residential',
      'other',
    ]) {
      expect(normalizeObjectTypeKey(key)).toBe(key);
    }
    expect(normalizeObjectTypeKey(' School ')).toBe('school');
  });

  it.each<[unknown]>([['maktab 1'], ['<b>'], [''], [5], ['x'.repeat(33)]])(
    '⚠️ yaroqsiz %p → null',
    (raw) => {
      expect(normalizeObjectTypeKey(raw)).toBeNull();
    },
  );
});

describe('parseHumidity', () => {
  it('0…100 oralig‘i', () => {
    expect(parseHumidity(45.2)).toBe(45.2);
    expect(parseHumidity('45.234')).toBe(45.23);
    expect(parseHumidity(0)).toBe(0);
    expect(parseHumidity(100)).toBe(100);
  });

  it.each<[unknown]>([[''], ['nan'], [Number.NaN], [-1], [100.1], [null]])(
    '⚠️ %p → null (bo‘sh qiymat «quruq havo» bo‘lmaydi)',
    (raw) => {
      expect(parseHumidity(raw)).toBeNull();
    },
  );
});

describe('extractReportedProfile', () => {
  it('xona moduli yukidan joylashuv o‘qiladi', () => {
    const profile = extractReportedProfile(ROOM_MODULE_PAYLOAD, null);
    expect(profile).toEqual({
      declaredType: null,
      mfy: 'Baraka',
      institution: '12-maktab',
      objectType: 'school',
      humidity: undefined,
      rejected: [],
    });
  });

  it('⚠️ kelmagan maydon `undefined` — bazadagi qiymat O‘CHIRILMAYDI', () => {
    const profile = extractReportedProfile(
      { device_id: 'esp32-0070077c641c', room_temperature_c: 24.4 },
      null,
    );
    expect(profile.mfy).toBeUndefined();
    expect(profile.institution).toBeUndefined();
    expect(profile.objectType).toBeUndefined();
    expect(profile.rejected).toEqual([]);
  });

  it('⚠️ yaroqsiz qiymat ham `undefined` + rejected — yaxshi qiymatni bosmaydi', () => {
    const profile = extractReportedProfile(
      { object_type: '<script>', humidity: 'NaN', device_type: 'sensor' },
      null,
    );
    expect(profile.objectType).toBeUndefined();
    expect(profile.humidity).toBeUndefined();
    expect(profile.declaredType).toBeNull();
    expect(profile.rejected.map((item) => item.field).sort()).toEqual([
      'device_type',
      'humidity',
      'object_type',
    ]);
  });

  it('⚠️ X-Module-Type sarlavhasi tanadan USTUN', () => {
    expect(
      extractReportedProfile({ device_type: 'boiler' }, 'room').declaredType,
    ).toBe(DeviceType.XONA);
    expect(
      extractReportedProfile({ device_type: 'room' }, null).declaredType,
    ).toBe(DeviceType.XONA);
  });

  it('namlik', () => {
    expect(extractReportedProfile({ humidity: 45.2 }, null).humidity).toBe(
      45.2,
    );
  });
});

describe('inferDeviceType', () => {
  it('room_temperature_c bor — xona', () => {
    expect(inferDeviceType({ hasRoomTemperatureField: true })).toBe(
      DeviceType.XONA,
    );
  });
  it('aks holda — kotyol', () => {
    expect(inferDeviceType({ hasRoomTemperatureField: false })).toBe(
      DeviceType.KOTYOL,
    );
  });
});

describe('decideDeviceType', () => {
  it('aytilgan tur saqlangandan farq qilsa — yoziladi va ogohlantiriladi', () => {
    const decision = decideDeviceType({
      declared: DeviceType.XONA,
      inferred: DeviceType.KOTYOL,
      stored: DeviceType.KOTYOL,
    });
    expect(decision.next).toBe(DeviceType.XONA);
    expect(decision.warning).toMatch(/kotyol → xona/);
  });

  it('aytilgan tur bir xil — jim', () => {
    expect(
      decideDeviceType({
        declared: DeviceType.KOTYOL,
        inferred: null,
        stored: DeviceType.KOTYOL,
      }),
    ).toEqual({ next: null, warning: null });
  });

  it('⚠️⚠️ tanadan xulosa saqlangan turni O‘ZGARTIRMAYDI (faqat ogohlantirish)', () => {
    const decision = decideDeviceType({
      declared: null,
      inferred: DeviceType.KOTYOL,
      stored: DeviceType.XONA,
    });
    expect(decision.next).toBeNull();
    expect(decision.warning).toMatch(/O‘ZGARTIRILMADI/);
  });
});

describe('extractRoomSamples — xona moduli', () => {
  it('⚠️ yakka `room_temperature_c` — `single` manba', () => {
    const parsed = extractRoomSamples(ROOM_MODULE_PAYLOAD);
    expect(parsed.source).toBe('single');
    expect(parsed.samples).toEqual([{ key: 'xona', temperature: 24.4 }]);
  });

  it('`rooms` massivi — `collection` manba', () => {
    expect(extractRoomSamples({ rooms: [{ key: 'a', t: 20 }] }).source).toBe(
      'collection',
    );
  });

  it('xona ma‘lumoti yo‘q — manba yo‘q', () => {
    expect(extractRoomSamples({ temperature_c: 60 }).source).toBeUndefined();
  });
});
