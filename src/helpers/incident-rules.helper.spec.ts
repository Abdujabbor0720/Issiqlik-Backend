import {
  AlertSeverity,
  AlertType,
  EscalationCondition,
  IncidentKind,
  IncidentStatus,
  NotifyAudience,
} from '../common/constants/enums';
import {
  bypassesGate,
  decideRecurrence,
  dueEscalation,
  effectiveRules,
  gateFor,
  incidentKey,
  incidentKindForAlert,
  isRoomCold,
  isRoomRecovered,
  maskEmail,
  maskPhone,
  maxSeverity,
  nextStatus,
  type EscalationRuleLike,
} from './incident-rules.helper';

const T0 = new Date('2026-11-23T03:00:00Z');
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('incidentKindForAlert — texnik signal → XAVF turi', () => {
  it('past / kritik harorat — kotyol sovuq', () => {
    for (const type of [
      AlertType.LOW_TEMPERATURE,
      AlertType.CRITICAL_TEMPERATURE,
    ]) {
      expect(
        incidentKindForAlert({ type, boilerFresh: true, temperature: 30 }),
      ).toBe(IncidentKind.BOILER_LOW_TEMPERATURE);
    }
  });

  it('offline + yangi o‘lchov + harorat — kotyol sovuq (aloqa bor)', () => {
    expect(
      incidentKindForAlert({
        type: AlertType.OFFLINE,
        boilerFresh: true,
        temperature: 12,
      }),
    ).toBe(IncidentKind.BOILER_LOW_TEMPERATURE);
  });

  it('offline + yangi o‘lchov + haroratsiz — datchik nosoz', () => {
    expect(
      incidentKindForAlert({
        type: AlertType.OFFLINE,
        boilerFresh: true,
        temperature: null,
      }),
    ).toBe(IncidentKind.SENSOR_FAULT);
  });

  it('offline + eskirgan o‘lchov — null (qurilma darajasida aytiladi)', () => {
    expect(
      incidentKindForAlert({
        type: AlertType.OFFLINE,
        boilerFresh: false,
        temperature: 55,
      }),
    ).toBeNull();
  });

  it('xona sovuq ogohlantirishi — null (xona holatidan hisoblanadi)', () => {
    expect(
      incidentKindForAlert({
        type: AlertType.ROOM_COLD,
        boilerFresh: true,
        temperature: 10,
      }),
    ).toBeNull();
  });

  it('xavfsizlik turlari o‘z nomi bilan', () => {
    expect(
      incidentKindForAlert({
        type: AlertType.OVERHEAT,
        boilerFresh: true,
        temperature: 97,
      }),
    ).toBe(IncidentKind.OVERHEAT);
    expect(
      incidentKindForAlert({
        type: AlertType.NO_CIRCULATION,
        boilerFresh: true,
        temperature: 60,
      }),
    ).toBe(IncidentKind.NO_CIRCULATION);
  });
});

describe('gateFor — jadvalga bo‘ysunish', () => {
  it('faqat xona va kotyol sovuqligi jadvalga bo‘ysunadi', () => {
    expect(gateFor(IncidentKind.ROOM_LOW_TEMPERATURE)).toBe('monitor');
    expect(gateFor(IncidentKind.BOILER_LOW_TEMPERATURE)).toBe('heating');
  });

  it('offline, datchik, qizish, sirkulyatsiya — hech qachon yashirilmaydi', () => {
    for (const kind of [
      IncidentKind.DEVICE_OFFLINE,
      IncidentKind.SENSOR_FAULT,
      IncidentKind.OVERHEAT,
      IncidentKind.NO_CIRCULATION,
    ]) {
      expect(gateFor(kind)).toBeNull();
    }
  });
});

describe('bypassesGate — muzlash xavfi jadvalni chetlab o‘tadi', () => {
  it('xona yoki kotyol ≤ 5 °C — har qanday jadvalda XAVF', () => {
    expect(bypassesGate(IncidentKind.ROOM_LOW_TEMPERATURE, 3)).toBe(true);
    expect(bypassesGate(IncidentKind.BOILER_LOW_TEMPERATURE, 5)).toBe(true);
  });

  it('odatiy past harorat (rejali o‘chirilgan kotyol 18 °C) — jadvalga bo‘ysunadi', () => {
    expect(bypassesGate(IncidentKind.ROOM_LOW_TEMPERATURE, 12)).toBe(false);
    expect(bypassesGate(IncidentKind.BOILER_LOW_TEMPERATURE, 18)).toBe(false);
    expect(bypassesGate(IncidentKind.BOILER_LOW_TEMPERATURE, null)).toBe(false);
  });

  it('boshqa turlarga ahamiyatsiz (ular baribir jadvalga bo‘ysunmaydi)', () => {
    expect(bypassesGate(IncidentKind.OVERHEAT, 2)).toBe(false);
  });
});

describe('incidentKey', () => {
  it('qurilma va xona kalitlari bir-biriga to‘qnashmaydi', () => {
    expect(incidentKey(IncidentKind.SENSOR_FAULT, 'b1')).toBe(
      'sensor_fault:b1',
    );
    expect(
      incidentKey(IncidentKind.ROOM_LOW_TEMPERATURE, 'b1', { roomId: 'r1' }),
    ).toBe('room_low_temperature:b1:r=r1');
    expect(
      incidentKey(IncidentKind.DEVICE_OFFLINE, 'b1', { deviceId: 'd1' }),
    ).toBe('device_offline:b1:d=d1');
  });
});

describe('xona harorati gisterezisi', () => {
  it('18 °C minimumda 17.9 — sovuq, 18.2 — hali tiklanmagan, 18.5 — tiklandi', () => {
    expect(isRoomCold(17.9, 18)).toBe(true);
    expect(isRoomCold(18, 18)).toBe(false);
    expect(isRoomRecovered(18.2, 18)).toBe(false);
    expect(isRoomRecovered(18.5, 18)).toBe(true);
  });
});

describe('nextStatus — holat mashinasi', () => {
  it('to‘g‘ri yo‘l: new → acknowledged → in_progress → resolved → closed', () => {
    expect(nextStatus('acknowledge', IncidentStatus.NEW)).toBe(
      IncidentStatus.ACKNOWLEDGED,
    );
    expect(nextStatus('start', IncidentStatus.ACKNOWLEDGED)).toBe(
      IncidentStatus.IN_PROGRESS,
    );
    expect(nextStatus('resolve', IncidentStatus.IN_PROGRESS)).toBe(
      IncidentStatus.RESOLVED,
    );
    expect(nextStatus('close', IncidentStatus.RESOLVED)).toBe(
      IncidentStatus.CLOSED,
    );
  });

  it('oldinga sakrash mumkin: new → in_progress, new → resolved', () => {
    expect(nextStatus('start', IncidentStatus.NEW)).toBe(
      IncidentStatus.IN_PROGRESS,
    );
    expect(nextStatus('resolve', IncidentStatus.NEW)).toBe(
      IncidentStatus.RESOLVED,
    );
  });

  it('bartaraf etilmagan hodisani yopib bo‘lmaydi', () => {
    for (const status of [
      IncidentStatus.NEW,
      IncidentStatus.ACKNOWLEDGED,
      IncidentStatus.IN_PROGRESS,
    ]) {
      expect(nextStatus('close', status)).toBeNull();
    }
  });

  it('yopilgan hodisa — yakuniy: hech qanday amal o‘tmaydi', () => {
    for (const action of [
      'acknowledge',
      'start',
      'resolve',
      'close',
      'reopen',
    ] as const) {
      expect(nextStatus(action, IncidentStatus.CLOSED)).toBeNull();
    }
  });

  it('qayta ochish faqat bartaraf etilgandan', () => {
    expect(nextStatus('reopen', IncidentStatus.RESOLVED)).toBe(
      IncidentStatus.IN_PROGRESS,
    );
    expect(nextStatus('reopen', IncidentStatus.IN_PROGRESS)).toBeNull();
  });

  it('qayta qabul qilish yo‘q (acknowledged → acknowledged)', () => {
    expect(nextStatus('acknowledge', IncidentStatus.ACKNOWLEDGED)).toBeNull();
  });
});

describe('decideRecurrence — cheksiz takroriy ogohlantirish yo‘q', () => {
  it('oldingi hodisa yo‘q yoki yopilgan — yangi', () => {
    expect(decideRecurrence(null, T0)).toBe('create');
    expect(
      decideRecurrence(
        {
          status: IncidentStatus.CLOSED,
          resolution: 'auto',
          resolvedAt: plus(-5),
        },
        T0,
      ),
    ).toBe('create');
  });

  it('avtomatik bartaraf etilgan, 60 daqiqa ichida qaytdi — qayta ochiladi', () => {
    expect(
      decideRecurrence(
        {
          status: IncidentStatus.RESOLVED,
          resolution: 'auto',
          resolvedAt: plus(-10),
        },
        T0,
      ),
    ).toBe('reopen');
  });

  it('avtomatik bartaraf etilganiga 2 soat — yangi hodisa', () => {
    expect(
      decideRecurrence(
        {
          status: IncidentStatus.RESOLVED,
          resolution: 'auto',
          resolvedAt: plus(-120),
        },
        T0,
      ),
    ).toBe('create');
  });

  it('qo‘lda bartaraf etilgan: 30 daqiqa kutiladi, keyin qayta ochiladi', () => {
    const manual = (ago: number) => ({
      status: IncidentStatus.RESOLVED,
      resolution: 'manual' as const,
      resolvedAt: plus(-ago),
    });
    expect(decideRecurrence(manual(10), T0)).toBe('wait');
    expect(decideRecurrence(manual(45), T0)).toBe('reopen');
    expect(decideRecurrence(manual(200), T0)).toBe('create');
  });
});

describe('eskalatsiya', () => {
  const rule = (
    partial: Partial<EscalationRuleLike> & Pick<EscalationRuleLike, 'level'>,
  ): EscalationRuleLike => ({
    id: `r${partial.level}${partial.severity ?? ''}`,
    severity: null,
    condition: EscalationCondition.NOT_ACKNOWLEDGED,
    afterMinutes: 30,
    target: NotifyAudience.REGION,
    isActive: true,
    ...partial,
  });

  const RULES = [
    rule({ level: 1, afterMinutes: 30 }),
    rule({
      level: 2,
      condition: EscalationCondition.NOT_RESOLVED,
      afterMinutes: 240,
    }),
    rule({ level: 1, severity: AlertSeverity.CRITICAL, afterMinutes: 15 }),
    rule({
      level: 2,
      severity: AlertSeverity.CRITICAL,
      condition: EscalationCondition.NOT_RESOLVED,
      afterMinutes: 120,
    }),
  ];

  const incident = (
    over: Partial<Parameters<typeof dueEscalation>[0]> = {},
  ) => ({
    severity: AlertSeverity.WARNING,
    status: IncidentStatus.NEW,
    escalationLevel: 0,
    openedAt: T0,
    ...over,
  });

  it('aniq og‘irlik qoidasi umumiysini almashtiradi', () => {
    const critical = effectiveRules(RULES, AlertSeverity.CRITICAL);
    expect(critical.map((r) => r.afterMinutes)).toEqual([15, 120]);
    const warning = effectiveRules(RULES, AlertSeverity.WARNING);
    expect(warning.map((r) => r.afterMinutes)).toEqual([30, 240]);
  });

  it('faolsiz aniq qoida shu daraja uchun umumiyni ham o‘chiradi', () => {
    const rules = [
      ...RULES,
      rule({ level: 1, severity: AlertSeverity.WARNING, isActive: false }),
    ];
    expect(
      effectiveRules(rules, AlertSeverity.WARNING).map((r) => r.level),
    ).toEqual([2]);
  });

  it('muddat kelmaguncha — null, kelgach — 1-daraja', () => {
    expect(dueEscalation(incident(), RULES, plus(29))).toBeNull();
    expect(dueEscalation(incident(), RULES, plus(30))?.level).toBe(1);
  });

  it('kritik — 15 daqiqada', () => {
    expect(
      dueEscalation(
        incident({ severity: AlertSeverity.CRITICAL }),
        RULES,
        plus(15),
      )?.level,
    ).toBe(1);
  });

  it('har daraja bir marta: 1-darajadan keyin faqat 2-daraja kutiladi', () => {
    expect(
      dueEscalation(incident({ escalationLevel: 1 }), RULES, plus(100)),
    ).toBeNull();
    expect(
      dueEscalation(incident({ escalationLevel: 1 }), RULES, plus(240))?.level,
    ).toBe(2);
    expect(
      dueEscalation(incident({ escalationLevel: 2 }), RULES, plus(10_000)),
    ).toBeNull();
  });

  it('qabul qilingan hodisa «qabul qilinmadi» qoidasidan o‘tib ketadi', () => {
    const acked = incident({ status: IncidentStatus.ACKNOWLEDGED });
    expect(dueEscalation(acked, RULES, plus(60))).toBeNull();
    expect(dueEscalation(acked, RULES, plus(240))?.level).toBe(2);
  });

  it('bartaraf etilgan / yopilgan hodisa eskalatsiya qilinmaydi', () => {
    for (const status of [IncidentStatus.RESOLVED, IncidentStatus.CLOSED]) {
      expect(
        dueEscalation(incident({ status }), RULES, plus(10_000)),
      ).toBeNull();
    }
  });
});

describe('shaxsiy ma‘lumot niqobi', () => {
  it('telefon: mamlakat kodi va oxirgi 2 raqam qoladi, shakl saqlanadi', () => {
    expect(maskPhone('+998 90 123 45 67')).toBe('+998 ** *** ** 67');
    expect(maskPhone('+998901234567')).toBe('+998*******67');
    expect(maskPhone(null)).toBeNull();
  });

  it('email: birinchi harf va domen', () => {
    expect(maskEmail('ali.valiyev@maktab.uz')).toBe('a***@maktab.uz');
    expect(maskEmail('nomail')).toBe('***');
  });
});

describe('maxSeverity', () => {
  it('og‘irroq yutadi', () => {
    expect(maxSeverity(AlertSeverity.WARNING, AlertSeverity.CRITICAL)).toBe(
      AlertSeverity.CRITICAL,
    );
    expect(maxSeverity(AlertSeverity.CRITICAL, AlertSeverity.INFO)).toBe(
      AlertSeverity.CRITICAL,
    );
  });
});
