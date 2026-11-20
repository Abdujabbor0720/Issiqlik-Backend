import {
  ACTIVE_INCIDENT_STATUSES,
  AlertSeverity,
  AlertType,
  EscalationCondition,
  IncidentKind,
  IncidentStatus,
  NotifyAudience,
} from '../common/constants/enums';

/**
 * XAVF QOIDALARI — SOF FUNKSIYALAR (baza va soat yo'q).
 *
 * ⚠️ Holat mashinasi, eskalatsiya muddati, qayta ochish qarori va telefon
 * niqobi — hammasi shu yerda va birlik testlari bilan qotirilgan
 * (`incident-rules.helper.spec.ts`). Servis faqat ularni chaqiradi: qoida
 * ikki joyda yozilsa, panel bir narsani, cron boshqasini qilardi.
 */

// ════════════════════════ Turlar ════════════════════════

/** Mas'ul o'qiydigan nom — ogohlantirish kartasining sarlavhasi. */
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  [IncidentKind.ROOM_LOW_TEMPERATURE]: 'Harorat me‘yordan past',
  [IncidentKind.BOILER_LOW_TEMPERATURE]: 'Kotyol harorati me‘yordan past',
  [IncidentKind.DEVICE_OFFLINE]: 'Qurilmadan signal kelmayapti',
  [IncidentKind.SENSOR_FAULT]: 'Datchik nosoz',
  [IncidentKind.OVERHEAT]: 'Ortiqcha qizish',
  [IncidentKind.NO_CIRCULATION]: 'Suv aylanmayapti',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  [IncidentStatus.NEW]: 'Yangi xavf',
  [IncidentStatus.ACKNOWLEDGED]: 'Qabul qilindi',
  [IncidentStatus.IN_PROGRESS]: 'Chora ko‘rilmoqda',
  [IncidentStatus.RESOLVED]: 'Bartaraf etildi',
  [IncidentStatus.CLOSED]: 'Yopildi',
};

/**
 * QAYSI TURLAR JADVALGA BO'YSUNADI.
 *
 * ⚠️⚠️ Texnik topshiriq §2: monitoring vaqtidan tashqarida faqat ODATIY
 * past harorat bo'yicha yangi XAVF ochilmaydi. Qurilma uzilishi, datchik
 * nosozligi, ortiqcha qizish va sirkulyatsiya yo'qligi — HAR DOIM: tunda
 * yorilgan quvur yoki qizib ketgan kotyol ertalabgacha kutmaydi.
 *
 *   • xona sovuq    → XAVF monitoringi oynasi;
 *   • kotyol sovuq  → ISITISH oynasi (isitish rejalashtirilmagan vaqtda
 *                     o'chgan kotyol — reja, xavf emas).
 */
export function gateFor(kind: IncidentKind): 'monitor' | 'heating' | null {
  switch (kind) {
    case IncidentKind.ROOM_LOW_TEMPERATURE:
      return 'monitor';
    case IncidentKind.BOILER_LOW_TEMPERATURE:
      return 'heating';
    default:
      return null;
  }
}

/**
 * MUZLASH XAVFI, °C — bundan past (yoki teng) harorat ODATIY past harorat
 * EMAS: quvur va radiator muzlab yorilishi mumkin.
 *
 * ⚠️⚠️ Texnik topshiriq §2 faqat «ODATIY past xona harorati» ni jadvaldan
 * tashqarida yashirishga ruxsat beradi. Tunda 3 °C gacha tushgan sinfxona
 * yoki 4 °C li kotyol suvi ertalabgacha kutmaydi — shuning uchun bu chegaradan
 * past qiymat har qanday jadvalda XAVF ochadi. Chegara ataylab past (5 °C):
 * kechasi rejali o'chirilgan kotyol (15–20 °C) har kecha xabar bermasin.
 */
export const FREEZE_RISK_C = 5;

/** Shu turdagi muammo jadval oynasini CHETLAB o'tadimi (muzlash xavfi). */
export function bypassesGate(
  kind: IncidentKind,
  temperature: number | null,
): boolean {
  return (
    (kind === IncidentKind.ROOM_LOW_TEMPERATURE ||
      kind === IncidentKind.BOILER_LOW_TEMPERATURE) &&
    temperature !== null &&
    temperature <= FREEZE_RISK_C
  );
}

/**
 * TEXNIK OGOHLANTIRISH → XAVF TURI (kotyol darajasi).
 *
 * ⚠️⚠️ `offline` ogohlantirishi IKKI XIL narsani bildiradi
 * (`BoilerStatus.OFFLINE` — «aloqa yo'q» YOKI «kritik sovuq»). XAVF da
 * ular ajratiladi, chunki qilinadigan ish boshqa:
 *   • o'lchov yangi + harorat bor  → kotyol sovuq (`boiler_low_temperature`);
 *   • o'lchov yangi + harorat yo'q → datchik qiymat bermayapti;
 *   • o'lchov eskirgan             → `null`: aloqa yo'qligini QURILMA
 *     darajasidagi XAVF aytadi (`device_offline`), bu yerda ikkinchi
 *     nusxa ochilmaydi.
 *
 * ⚠️ `room_cold` → `null`: xona XAVFi xona holatidan (jadvaldagi
 * minimum bilan) hisoblanadi, umumiy chegarali ogohlantirishdan emas.
 */
export function incidentKindForAlert(input: {
  type: AlertType;
  boilerFresh: boolean;
  temperature: number | null;
}): IncidentKind | null {
  switch (input.type) {
    case AlertType.LOW_TEMPERATURE:
    case AlertType.CRITICAL_TEMPERATURE:
      return IncidentKind.BOILER_LOW_TEMPERATURE;
    case AlertType.OFFLINE:
      if (!input.boilerFresh) return null;
      return input.temperature === null
        ? IncidentKind.SENSOR_FAULT
        : IncidentKind.BOILER_LOW_TEMPERATURE;
    case AlertType.SENSOR_FAULT:
      return IncidentKind.SENSOR_FAULT;
    case AlertType.OVERHEAT:
      return IncidentKind.OVERHEAT;
    case AlertType.NO_CIRCULATION:
      return IncidentKind.NO_CIRCULATION;
    default:
      return null;
  }
}

/** Dublikat kaliti: `tur:qozonxona[:r=xona|:d=qurilma]`. */
export function incidentKey(
  kind: IncidentKind,
  boilerId: string,
  sub?: { roomId?: string | null; deviceId?: string | null },
): string {
  if (sub?.deviceId) return `${kind}:${boilerId}:d=${sub.deviceId}`;
  if (sub?.roomId) return `${kind}:${boilerId}:r=${sub.roomId}`;
  return `${kind}:${boilerId}`;
}

// ════════════════════════ Xona harorati ════════════════════════

/**
 * TIKLANISH ZAXIRASI, °C.
 *
 * ⚠️⚠️ Xona minimum chegarasi atrofida «sakraydi» (17.9 → 18.1 → 17.9).
 * XAVF `harorat < minimum` da ochiladi, lekin u faqat
 * `harorat ≥ minimum + 0.5` da AVTOMATIK yopiladi. Busiz har sakrashda
 * hodisa yopilib-ochilib, mas'ulga yangi xabar ketardi.
 */
export const ROOM_RECOVERY_MARGIN_C = 0.5;

export function isRoomCold(temperature: number, minC: number): boolean {
  return temperature < minC;
}

export function isRoomRecovered(temperature: number, minC: number): boolean {
  return temperature >= minC + ROOM_RECOVERY_MARGIN_C;
}

// ════════════════════════ Og'irlik ════════════════════════

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  [AlertSeverity.INFO]: 0,
  [AlertSeverity.WARNING]: 1,
  [AlertSeverity.CRITICAL]: 2,
};

export function maxSeverity(a: AlertSeverity, b: AlertSeverity): AlertSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function isSeverityHigher(
  next: AlertSeverity,
  current: AlertSeverity,
): boolean {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current];
}

// ════════════════════════ Holat mashinasi ════════════════════════

export type IncidentAction =
  'acknowledge' | 'start' | 'resolve' | 'close' | 'reopen';

/**
 * QO'LDA O'TISHLAR.
 *
 *   NEW ─► ACKNOWLEDGED ─► IN_PROGRESS ─► RESOLVED ─► CLOSED
 *    └──────────┴──────────────┘ (oldinga sakrash mumkin)  │
 *                     IN_PROGRESS ◄── reopen ─────────────┘ (RESOLVED dan)
 *
 * ⚠️ ORQAGA faqat `reopen` (RESOLVED → IN_PROGRESS): tekshiruvchi
 * «aslida bartaraf etilmagan» desa. `CLOSED` — yakuniy: yopilgan hodisa
 * qayta ochilmaydi, muammo qaytsa YANGI hodisa ochiladi (hisobotda
 * «takrorlanayotgan muammo» bo'lib sanaladi).
 */
const TRANSITIONS: Record<
  IncidentAction,
  { from: readonly IncidentStatus[]; to: IncidentStatus }
> = {
  acknowledge: { from: [IncidentStatus.NEW], to: IncidentStatus.ACKNOWLEDGED },
  start: {
    from: [IncidentStatus.NEW, IncidentStatus.ACKNOWLEDGED],
    to: IncidentStatus.IN_PROGRESS,
  },
  resolve: {
    from: [
      IncidentStatus.NEW,
      IncidentStatus.ACKNOWLEDGED,
      IncidentStatus.IN_PROGRESS,
    ],
    to: IncidentStatus.RESOLVED,
  },
  close: { from: [IncidentStatus.RESOLVED], to: IncidentStatus.CLOSED },
  reopen: { from: [IncidentStatus.RESOLVED], to: IncidentStatus.IN_PROGRESS },
};

/** Ruxsat etilgan o'tishning natijasi yoki `null`. */
export function nextStatus(
  action: IncidentAction,
  current: IncidentStatus,
): IncidentStatus | null {
  const rule = TRANSITIONS[action];
  return rule.from.includes(current) ? rule.to : null;
}

export function allowedFrom(action: IncidentAction): readonly IncidentStatus[] {
  return TRANSITIONS[action].from;
}

export function isActiveStatus(status: IncidentStatus): boolean {
  return ACTIVE_INCIDENT_STATUSES.includes(status);
}

// ════════════════════════ Takrorlanish ════════════════════════

export interface RecurrencePolicy {
  /** Avtomatik bartaraf etilgan hodisa shu daqiqa ichida qaytsa — QAYTA OCHILADI. */
  reopenWindowMinutes: number;
  /** Qo'lda «bartaraf etildi» deyilgach — xona isishi uchun kutish. */
  manualGraceMinutes: number;
}

export const DEFAULT_RECURRENCE: RecurrencePolicy = {
  reopenWindowMinutes: 60,
  manualGraceMinutes: 30,
};

/**
 * MUAMMO YANA BOR, FAOL HODISA YO'Q — NIMA QILISH KERAK.
 *
 *   • `create` — yangi hodisa (oldingisi yopilgan yoki ancha eski);
 *   • `reopen` — oxirgi hodisani qayta ochish (yangisi EMAS);
 *   • `wait`   — hech narsa qilmaslik (qo'lda bartaraf etilganiga hali
 *                kam vaqt o'tdi: radiator yoqildi, xona isishi kerak).
 *
 * ⚠️⚠️ BUSIZ «CHEKSIZ TAKRORIY OGOHLANTIRISH» bo'lardi: chegara atrofida
 * sakragan harorat har daqiqada yangi XAVF va yangi xabar berardi. Qayta
 * ochilgan hodisa yangi xabar YARATMAYDI (`incident_notifications` yagona
 * kaliti) — faqat tarixga «qayta ochildi» yoziladi.
 *
 * ⚠️ Qo'lda bartaraf etilgan, lekin muammo davom etayotgan hodisa
 * kutishdan keyin QAYTA OCHILADI: «bartaraf etildi» degan da'vo
 * o'lchovga zid — monitoring buni yashirmasligi kerak.
 */
export function decideRecurrence(
  latest: {
    status: IncidentStatus;
    resolution: 'auto' | 'manual' | null;
    resolvedAt: Date | null;
  } | null,
  now: Date,
  policy: RecurrencePolicy = DEFAULT_RECURRENCE,
): 'create' | 'reopen' | 'wait' {
  if (!latest || latest.status !== IncidentStatus.RESOLVED) return 'create';
  if (!latest.resolvedAt) return 'create';

  const ageMin = (now.getTime() - latest.resolvedAt.getTime()) / 60_000;
  if (latest.resolution === 'manual') {
    if (ageMin < policy.manualGraceMinutes) return 'wait';
    return ageMin < policy.manualGraceMinutes + policy.reopenWindowMinutes
      ? 'reopen'
      : 'create';
  }
  return ageMin < policy.reopenWindowMinutes ? 'reopen' : 'create';
}

// ════════════════════════ Eskalatsiya ════════════════════════

export interface EscalationRuleLike {
  id: string;
  severity: AlertSeverity | null;
  level: number;
  condition: EscalationCondition;
  afterMinutes: number;
  target: NotifyAudience;
  isActive: boolean;
}

/**
 * OG'IRLIK UCHUN AMALDAGI QOIDALAR — daraja bo'yicha o'sish tartibida.
 *
 * ⚠️ Aniq og'irlikdagi qoida AYNI darajadagi umumiy (`severity = null`)
 * qoidani ALMASHTIRADI — hatto u faolsiz bo'lsa ham. Shu yo'l bilan
 * administrator «kritik uchun 1-daraja kerak emas» deya oladi: umumiy
 * qoidaga tegmasdan, kritik uchun faolsiz qoida yozadi.
 */
export function effectiveRules<T extends EscalationRuleLike>(
  rules: readonly T[],
  severity: AlertSeverity,
): T[] {
  const byLevel = new Map<number, T>();
  for (const rule of rules) {
    if (rule.severity !== null && rule.severity !== severity) continue;
    const existing = byLevel.get(rule.level);
    if (!existing || (existing.severity === null && rule.severity !== null)) {
      byLevel.set(rule.level, rule);
    }
  }
  return [...byLevel.values()]
    .filter((rule) => rule.isActive)
    .sort((a, b) => a.level - b.level);
}

/**
 * HOZIR ISHGA TUSHISHI KERAK BO'LGAN ESKALATSIYA (yoki `null`).
 *
 * ⚠️⚠️ Faqat JORIY darajadan YUQORI qoidalar ko'riladi va har chaqiruvda
 * ko'pi bilan BITTASI qaytadi: daraja faqat o'sadi, demak har qoida bir
 * marta ishlaydi — takroriy xabar strukturaviy imkonsiz.
 *
 * ⚠️ «Qabul qilinmadi» qoidasi hodisa qabul qilingach O'TKAZIB yuboriladi
 * (keyingi «hal qilinmadi» qoidasi kutadi). Navbatdagi qo'llaniladigan
 * qoida muddati hali kelmagan bo'lsa — kutiladi, undan yuqorisi ham
 * ishlamaydi: darajalar tartibi buzilmasin.
 */
export function dueEscalation<T extends EscalationRuleLike>(
  incident: {
    severity: AlertSeverity;
    status: IncidentStatus;
    escalationLevel: number;
    openedAt: Date;
  },
  rules: readonly T[],
  now: Date,
): T | null {
  if (!isActiveStatus(incident.status)) return null;

  for (const rule of effectiveRules(rules, incident.severity)) {
    if (rule.level <= incident.escalationLevel) continue;
    if (
      rule.condition === EscalationCondition.NOT_ACKNOWLEDGED &&
      incident.status !== IncidentStatus.NEW
    ) {
      continue;
    }
    const dueAt = incident.openedAt.getTime() + rule.afterMinutes * 60_000;
    return now.getTime() >= dueAt ? rule : null;
  }
  return null;
}

// ════════════════════════ Shaxsiy ma'lumot ════════════════════════

/**
 * TELEFON NIQOBI: `+998 90 123 45 67` → `+998 ** *** ** 67`.
 *
 * ⚠️ Mamlakat kodi (birinchi 3 raqam) va oxirgi 2 raqam qoladi: «qaysi
 * javobgar» ni ajratish uchun yetadi, qo'ng'iroq qilish uchun yetmaydi.
 * Shakl (bo'shliq, chiziqcha) saqlanadi.
 */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return phone;
  const total = phone.replace(/\D/g, '').length;
  let seen = 0;
  return phone.replace(/\d/g, (digit) => {
    seen += 1;
    return seen <= 3 || seen > total - 2 ? digit : '*';
  });
}

/** `ali.valiyev@maktab.uz` → `a***@maktab.uz`. */
export function maskEmail(email: string | null): string | null {
  if (!email) return email;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
