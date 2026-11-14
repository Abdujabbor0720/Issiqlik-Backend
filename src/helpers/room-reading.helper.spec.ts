import {
  AIR_MAX_C,
  MAX_ROOMS_PER_PAYLOAD,
  SINGLE_ROOM_KEY,
  classifyRoomTemperature,
  extractRoomSamples,
  isRoomReadingFresh,
  normalizeRoomKey,
  parseRoomSamples,
  shouldLogRoomReading,
  summarizeRoomTemperatures,
} from './room-reading.helper';

describe('normalizeRoomKey', () => {
  it('⚠️ katta-kichik harf — BITTA datchik', () => {
    expect(normalizeRoomKey('28FF4A2B1C000042')).toBe('28ff4a2b1c000042');
    expect(normalizeRoomKey('28ff4a2b1c000042')).toBe('28ff4a2b1c000042');
  });

  it('bo‘shliq `_` ga almashadi', () => {
    expect(normalizeRoomKey('  xona 1 ')).toBe('xona_1');
  });

  it('son ham kalit bo‘la oladi', () => {
    expect(normalizeRoomKey(3)).toBe('3');
  });

  it.each<[unknown, string]>([
    ['', 'bo‘sh'],
    ['<script>', 'ruxsat etilmagan belgi'],
    ['x'.repeat(65), '64 dan uzun'],
    [null, 'null'],
    [{}, 'obyekt'],
  ])('%p rad etiladi (%s)', (raw, _why) => {
    expect(normalizeRoomKey(raw)).toBeNull();
  });
});

describe('parseRoomSamples', () => {
  it('massiv shakli: turli maydon nomlari', () => {
    const { samples, rejected } = parseRoomSamples([
      { key: '28FF01', t: 21.4 },
      { sensor: 'xona_2', temp: '19.05' },
      { id: 'zal', temperature: 18 },
    ]);
    expect(rejected).toEqual([]);
    expect(samples).toEqual([
      { key: '28ff01', temperature: 21.4 },
      { key: 'xona_2', temperature: 19.05 },
      { key: 'zal', temperature: 18 },
    ]);
  });

  it('obyekt shakli', () => {
    const { samples } = parseRoomSamples({ xona_1: 21.4, Xona_2: '19' });
    expect(samples).toEqual([
      { key: 'xona_1', temperature: 21.4 },
      { key: 'xona_2', temperature: 19 },
    ]);
  });

  it('⚠️⚠️ 85 °C (DS18B20 qayta yoqilgan qiymati) — XONA UCHUN RAD ETILADI', () => {
    const { samples, rejected } = parseRoomSamples([{ key: 'a', t: 85 }]);
    expect(samples).toEqual([]);
    expect(rejected).toEqual([{ key: 'a', value: 85, reason: 'range' }]);
  });

  it('-127 (sim uzilgan) rad etiladi', () => {
    const { rejected } = parseRoomSamples({ a: -127 });
    expect(rejected[0].reason).toBe('range');
  });

  it('chegaraning o‘zi qabul qilinadi', () => {
    expect(parseRoomSamples({ a: AIR_MAX_C }).samples).toHaveLength(1);
  });

  it('⚠️ bo‘sh satr 0 °C BO‘LMAYDI', () => {
    const { samples, rejected } = parseRoomSamples({ a: '' });
    expect(samples).toEqual([]);
    expect(rejected[0].reason).toBe('value');
  });

  it('⚠️ takror kalit (harf farqi bilan ham) — birinchisi olinadi', () => {
    const { samples, rejected } = parseRoomSamples([
      { key: 'AB', t: 20 },
      { key: 'ab', t: 25 },
    ]);
    expect(samples).toEqual([{ key: 'ab', temperature: 20 }]);
    expect(rejected).toEqual([{ key: 'ab', value: 25, reason: 'duplicate' }]);
  });

  it('⚠️ chegaradan ortig‘i rad etiladi — plata minglab xona yarata olmaydi', () => {
    const many = Array.from({ length: MAX_ROOMS_PER_PAYLOAD + 5 }, (_, i) => ({
      key: `x${i}`,
      t: 20,
    }));
    const { samples, rejected } = parseRoomSamples(many);
    expect(samples).toHaveLength(MAX_ROOMS_PER_PAYLOAD);
    expect(rejected.filter((r) => r.reason === 'overflow')).toHaveLength(5);
  });

  it('kalitsiz element rad etiladi, qolganlari o‘tadi', () => {
    const { samples, rejected } = parseRoomSamples([
      { t: 20 },
      21,
      { key: 'ok', t: 22 },
    ]);
    expect(samples).toEqual([{ key: 'ok', temperature: 22 }]);
    expect(rejected.map((r) => r.reason)).toEqual(['key', 'key']);
  });

  it.each([undefined, null, 'matn', 42, true])(
    '⚠️ %p — XATO TASHLAMAYDI, bo‘sh natija',
    (raw) => {
      expect(parseRoomSamples(raw)).toEqual({ samples: [], rejected: [] });
    },
  );
});

describe('extractRoomSamples', () => {
  it('asosiy shakl — `rooms` massivi', () => {
    expect(
      extractRoomSamples({ device_id: 'x', rooms: [{ key: 'a', t: 20 }] })
        .samples,
    ).toEqual([{ key: 'a', temperature: 20 }]);
  });

  it('yakka havo datchigi — `xona` kaliti bilan bitta xona', () => {
    expect(extractRoomSamples({ room_temperature_c: '21.4' }).samples).toEqual([
      { key: SINGLE_ROOM_KEY, temperature: 21.4 },
    ]);
  });

  it('⚠️ massiv BOR bo‘lsa yakka maydon e‘tiborsiz — bitta datchik ikki xona bo‘lmaydi', () => {
    const { samples } = extractRoomSamples({
      rooms: [{ key: 'a', t: 20 }],
      room_temperature_c: 20,
    });
    expect(samples).toHaveLength(1);
  });

  it('⚠️ xona yo‘q — eski proshivka yuki o‘zgarishsiz ishlaydi', () => {
    expect(
      extractRoomSamples({
        device_id: 'esp32-1',
        inlet_temperature_c: 45,
        outlet_temperature_c: 60,
      }),
    ).toEqual({ samples: [], rejected: [] });
  });

  it('⚠️ kotyol harorati `temperature` XONA deb O‘QILMAYDI', () => {
    expect(extractRoomSamples({ temperature: 60 }).samples).toEqual([]);
  });
});

describe('classifyRoomTemperature', () => {
  const thresholds = { minC: 15, normC: 25 };

  it.each([
    [-5, 'cold'],
    [14.99, 'cold'],
    [15, 'cool'],
    [20, 'cool'],
    [24.99, 'cool'],
    [25, 'normal'],
    [32, 'normal'],
  ])('%p °C → %s', (value, expected) => {
    expect(classifyRoomTemperature(value, thresholds)).toBe(expected);
  });
});

describe('isRoomReadingFresh', () => {
  const now = new Date('2026-11-14T12:00:00Z');

  it('o‘lchov yo‘q — eskirgan', () => {
    expect(isRoomReadingFresh(null, now, 15)).toBe(false);
  });

  it('chegara ichida — dolzarb', () => {
    expect(isRoomReadingFresh(new Date('2026-11-14T11:45:00Z'), now, 15)).toBe(
      true,
    );
  });

  it('⚠️ chegaradan eski — o‘rtachaga KIRMAYDI', () => {
    expect(isRoomReadingFresh(new Date('2026-11-14T11:44:59Z'), now, 15)).toBe(
      false,
    );
  });
});

describe('shouldLogRoomReading', () => {
  const at = new Date('2026-11-14T12:00:00Z');

  it('birinchi o‘lchov — yoziladi', () => {
    expect(shouldLogRoomReading(null, at, 10)).toBe(true);
  });

  it('⚠️ 10 daqiqa o‘tmagan — TARIXGA yozilmaydi', () => {
    expect(shouldLogRoomReading(new Date('2026-11-14T11:51:00Z'), at, 10)).toBe(
      false,
    );
  });

  it('aynan 10 daqiqa — yoziladi', () => {
    expect(shouldLogRoomReading(new Date('2026-11-14T11:50:00Z'), at, 10)).toBe(
      true,
    );
  });
});

describe('summarizeRoomTemperatures', () => {
  it('bo‘sh — null', () => {
    expect(summarizeRoomTemperatures([])).toEqual({
      count: 0,
      avg: null,
      min: null,
      max: null,
    });
  });

  it('o‘rtacha / eng past / eng yuqori, 0.1 aniqlikda', () => {
    expect(summarizeRoomTemperatures([25, 15, 21.33])).toEqual({
      count: 3,
      avg: 20.4,
      min: 15,
      max: 25,
    });
  });
});
