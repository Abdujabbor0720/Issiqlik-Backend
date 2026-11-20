import { ScheduleMode, ScheduleScope } from '../common/constants/enums';
import {
  formatHm,
  formatWindow,
  isWithinWindow,
  parseHm,
  pickEffectiveSchedule,
  shiftDateKey,
  toTashkentMoment,
  weekdayOf,
} from './monitoring-window.helper';

/** Toshkent vaqti bo'yicha lahza: `tk('2026-11-23 08:23')` (dushanba). */
function tk(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+05:00`);
}

const SCHOOL = {
  mode: ScheduleMode.SCHEDULE,
  activeDays: [1, 2, 3, 4, 5, 6],
  observeHolidays: true,
};
const MONITOR = { startMin: 7 * 60, endMin: 18 * 60 };
const NO_HOLIDAYS = new Set<string>();

describe('toTashkentMoment', () => {
  it('UTC lahzani Toshkent kuni va daqiqasiga o‘tkazadi (+5, DST yo‘q)', () => {
    // 2026-11-22T20:30Z = Toshkentda 23-noyabr (dushanba) 01:30
    expect(toTashkentMoment(new Date('2026-11-22T20:30:00Z'))).toEqual({
      dateKey: '2026-11-23',
      weekday: 1,
      minuteOfDay: 90,
    });
  });

  it('yakshanba — 7 (ISO), 0 emas', () => {
    expect(toTashkentMoment(tk('2026-11-22 12:00')).weekday).toBe(7);
    expect(weekdayOf('2026-11-22')).toBe(7);
  });

  it('kun kalitini siljitish oy va yil chegarasidan o‘tadi', () => {
    expect(shiftDateKey('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDateKey('2026-11-30', 1)).toBe('2026-12-01');
  });
});

describe('isWithinWindow', () => {
  it('24/7 — har doim ichida (bayram va yakshanbada ham)', () => {
    const always = {
      mode: ScheduleMode.ALWAYS,
      activeDays: [],
      observeHolidays: true,
    };
    expect(
      isWithinWindow(
        tk('2026-11-22 03:00'),
        always,
        MONITOR,
        new Set(['2026-11-22']),
      ),
    ).toBe(true);
  });

  it('maktab: 07:00 dan boshlanadi, 06:59 da hali tashqarida', () => {
    expect(
      isWithinWindow(tk('2026-11-23 06:59'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(false);
    expect(
      isWithinWindow(tk('2026-11-23 07:00'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(true);
    expect(
      isWithinWindow(tk('2026-11-23 08:23'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(true);
  });

  it('oxiri inklyuziv emas: 18:00 — tashqarida', () => {
    expect(
      isWithinWindow(tk('2026-11-23 17:59'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(true);
    expect(
      isWithinWindow(tk('2026-11-23 18:00'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(false);
  });

  it('faol bo‘lmagan kun (yakshanba) — tashqarida', () => {
    expect(
      isWithinWindow(tk('2026-11-22 09:00'), SCHOOL, MONITOR, NO_HOLIDAYS),
    ).toBe(false);
  });

  it('bayram — tashqarida, lekin observeHolidays=false bo‘lsa ichida', () => {
    const holidays = new Set(['2026-12-08']);
    expect(
      isWithinWindow(tk('2026-12-08 09:00'), SCHOOL, MONITOR, holidays),
    ).toBe(false);
    expect(
      isWithinWindow(
        tk('2026-12-08 09:00'),
        { ...SCHOOL, observeHolidays: false },
        MONITOR,
        holidays,
      ),
    ).toBe(true);
  });

  it('server mintaqasidan qat‘i nazar Toshkent soati: 02:30Z = 07:30 Toshkent', () => {
    expect(
      isWithinWindow(
        new Date('2026-11-23T02:30:00Z'),
        SCHOOL,
        MONITOR,
        NO_HOLIDAYS,
      ),
    ).toBe(true);
    expect(
      isWithinWindow(
        new Date('2026-11-23T01:30:00Z'),
        SCHOOL,
        MONITOR,
        NO_HOLIDAYS,
      ),
    ).toBe(false);
  });

  it('start == end — faol kunda kun bo‘yi', () => {
    const allDay = { startMin: 0, endMin: 0 };
    expect(
      isWithinWindow(tk('2026-11-23 23:59'), SCHOOL, allDay, NO_HOLIDAYS),
    ).toBe(true);
    expect(
      isWithinWindow(tk('2026-11-22 12:00'), SCHOOL, allDay, NO_HOLIDAYS),
    ).toBe(false);
  });

  describe('tun orqali oyna (22:00–06:00)', () => {
    const night = { startMin: 22 * 60, endMin: 6 * 60 };
    // Faqat dushanba faol.
    const mondayOnly = { ...SCHOOL, activeDays: [1] };

    it('dushanba 23:00 — ichida', () => {
      expect(
        isWithinWindow(tk('2026-11-23 23:00'), mondayOnly, night, NO_HOLIDAYS),
      ).toBe(true);
    });

    it('seshanba 05:00 — dushanba oynasining davomi, ichida', () => {
      expect(
        isWithinWindow(tk('2026-11-24 05:00'), mondayOnly, night, NO_HOLIDAYS),
      ).toBe(true);
    });

    it('dushanba 05:00 — yakshanba oynasi (faol emas), tashqarida', () => {
      expect(
        isWithinWindow(tk('2026-11-23 05:00'), mondayOnly, night, NO_HOLIDAYS),
      ).toBe(false);
    });

    it('kunduzi 12:00 — tashqarida', () => {
      expect(
        isWithinWindow(tk('2026-11-23 12:00'), mondayOnly, night, NO_HOLIDAYS),
      ).toBe(false);
    });
  });
});

describe('HH:mm', () => {
  it('parse va format bir-biriga teskari', () => {
    expect(parseHm('07:00')).toBe(420);
    expect(parseHm('23:59')).toBe(1439);
    expect(formatHm(420)).toBe('07:00');
    expect(formatHm(1439)).toBe('23:59');
  });

  it('noto‘g‘ri qiymat — null', () => {
    for (const bad of ['24:00', '7:00', '07:60', 'abc', '']) {
      expect(parseHm(bad)).toBeNull();
    }
  });

  it('oyna yorlig‘i', () => {
    expect(formatWindow(ScheduleMode.ALWAYS, 0, 0)).toBe('24/7');
    expect(formatWindow(ScheduleMode.SCHEDULE, 420, 1080)).toBe('07:00–18:00');
    expect(formatWindow(ScheduleMode.SCHEDULE, 0, 0)).toBe('kun bo‘yi');
  });
});

describe('pickEffectiveSchedule', () => {
  const rows = [
    { id: 'g', scopeType: ScheduleScope.GLOBAL, scopeId: null },
    { id: 't', scopeType: ScheduleScope.OBJECT_TYPE, scopeId: 'type-school' },
    { id: 'o', scopeType: ScheduleScope.ORGANIZATION, scopeId: 'org-4' },
    { id: 'b', scopeType: ScheduleScope.BOILER, scopeId: 'boiler-1' },
  ];

  it('qozonxona → muassasa → tur → global tartibida eng aniqi yutadi', () => {
    expect(
      pickEffectiveSchedule(rows, {
        boilerId: 'boiler-1',
        organizationId: 'org-4',
        objectTypeId: 'type-school',
      })?.id,
    ).toBe('b');
    expect(
      pickEffectiveSchedule(rows, {
        boilerId: 'boiler-2',
        organizationId: 'org-4',
        objectTypeId: 'type-school',
      })?.id,
    ).toBe('o');
    expect(
      pickEffectiveSchedule(rows, {
        boilerId: 'boiler-2',
        organizationId: 'org-5',
        objectTypeId: 'type-school',
      })?.id,
    ).toBe('t');
  });

  it('muassasasiz / tursiz obyekt — global', () => {
    expect(
      pickEffectiveSchedule(rows, {
        boilerId: 'boiler-9',
        organizationId: null,
        objectTypeId: null,
      })?.id,
    ).toBe('g');
  });

  it('jadval umuman yo‘q — null', () => {
    expect(
      pickEffectiveSchedule([], {
        boilerId: 'x',
        organizationId: null,
        objectTypeId: null,
      }),
    ).toBeNull();
  });
});
