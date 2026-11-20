import { ScheduleMode, ScheduleScope } from '../common/constants/enums';

/**
 * MONITORING OYNASI — «hozir shu obyektda past harorat XAVF hisoblanadimi».
 *
 * ⚠️⚠️ SOF FUNKSIYALAR: baza ham, soat ham yo'q — `now` va bayramlar
 * tashqaridan beriladi. Jadval xatosi kechasi 03:00 da sinfxona uchun
 * XAVF ochib, mas'ulni behuda uyg'otadi yoki (yomonrog'i) 08:00 dagi
 * haqiqiy sovuqni yashiradi — shuning uchun mantiq birlik testlari bilan
 * qotirilgan (`monitoring-window.helper.spec.ts`).
 *
 * ⚠️ Mintaqa — Asia/Tashkent (+5, yozgi vaqt YO'Q). Server qaysi mintaqada
 * ishlashidan qat'i nazar kun va soat shu yerda hisoblanadi; `getHours()`
 * (server mintaqasi) ishlatilmaydi.
 */

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Toshkent bo'yicha lahza: kun kaliti, ISO hafta kuni, sutka daqiqasi. */
export interface TashkentMoment {
  /** `YYYY-MM-DD` — bayram jadvali shu kalit bilan solishtiriladi. */
  dateKey: string;
  /** ISO: 1 — dushanba … 7 — yakshanba. */
  weekday: number;
  /** 0…1439. */
  minuteOfDay: number;
}

export function toTashkentMoment(at: Date): TashkentMoment {
  const local = new Date(at.getTime() + TASHKENT_OFFSET_MS);
  const day = local.getUTCDay();
  return {
    dateKey: local.toISOString().slice(0, 10),
    weekday: day === 0 ? 7 : day,
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** Kun kalitini siljitish (`-1` — kecha). */
export function shiftDateKey(dateKey: string, days: number): string {
  const base = Date.parse(`${dateKey}T00:00:00Z`);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** Kun kalitining ISO hafta kuni. */
export function weekdayOf(dateKey: string): number {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Oyna hisoblash uchun jadvalning kerakli qismi. */
export interface WindowRule {
  mode: ScheduleMode;
  activeDays: readonly number[];
  observeHolidays: boolean;
}

/**
 * LAHZA OYNA ICHIDAMI.
 *
 *   • `always` — har doim (bayram va hafta kuni ahamiyatsiz: 24/7);
 *   • `start == end` — faol kunda kun bo'yi;
 *   • `start <  end` — oddiy oyna `[start, end)`;
 *   • `start >  end` — TUN ORQALI: `[start, 24:00)` bugungi kunga,
 *     `[00:00, end)` esa KECHAGI kunga tegishli. Ya'ni dushanba 22:00–06:00
 *     oynasi seshanba 05:00 da ham «dushanba oynasi» — faol kun va bayram
 *     dushanba bo'yicha tekshiriladi.
 *
 * ⚠️ Oxiri INKLYUZIV EMAS: 07:00–18:00 oynasida 18:00 — tashqarida. Aks
 * holda ikki ketma-ket oyna (06–12, 12–18) chegarada ikki marta sanalardi.
 */
export function isWithinWindow(
  at: Date,
  rule: WindowRule,
  window: { startMin: number; endMin: number },
  holidays: ReadonlySet<string>,
): boolean {
  if (rule.mode === ScheduleMode.ALWAYS) return true;

  const moment = toTashkentMoment(at);
  const minute = moment.minuteOfDay;
  const { startMin: start, endMin: end } = window;

  const dayActive = (dateKey: string): boolean =>
    rule.activeDays.includes(weekdayOf(dateKey)) &&
    !(rule.observeHolidays && holidays.has(dateKey));

  if (start === end) return dayActive(moment.dateKey);
  if (start < end) {
    return minute >= start && minute < end && dayActive(moment.dateKey);
  }
  if (minute >= start) return dayActive(moment.dateKey);
  if (minute < end) return dayActive(shiftDateKey(moment.dateKey, -1));
  return false;
}

/** `HH:mm` → sutka daqiqasi. Noto'g'ri qiymat — `null`. */
export function parseHm(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Sutka daqiqasi → `HH:mm`. */
export function formatHm(minute: number): string {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Ko'rsatish uchun: `07:00–18:00`, `kun bo‘yi`, `24/7`. */
export function formatWindow(
  mode: ScheduleMode,
  startMin: number,
  endMin: number,
): string {
  if (mode === ScheduleMode.ALWAYS) return '24/7';
  if (startMin === endMin) return 'kun bo‘yi';
  return `${formatHm(startMin)}–${formatHm(endMin)}`;
}

/** Jadval qatorining nishoni. */
export interface ScheduleScopeRow {
  scopeType: ScheduleScope;
  scopeId: string | null;
}

/** Qaysi obyekt uchun jadval qidirilmoqda. */
export interface ScheduleTarget {
  boilerId: string;
  organizationId: string | null;
  objectTypeId: string | null;
}

/**
 * AMALDAGI JADVAL — eng aniq daraja yutadi:
 * qozonxona → muassasa → obyekt turi → global.
 *
 * ⚠️ Darajalar ARALASHTIRILMAYDI (to'liq qator qaytadi) — sababi
 * `monitoring.entities.ts` da.
 */
export function pickEffectiveSchedule<T extends ScheduleScopeRow>(
  rows: readonly T[],
  target: ScheduleTarget,
): T | null {
  const find = (scopeType: ScheduleScope, scopeId: string | null) =>
    scopeId === null && scopeType !== ScheduleScope.GLOBAL
      ? undefined
      : rows.find(
          (row) => row.scopeType === scopeType && row.scopeId === scopeId,
        );

  return (
    find(ScheduleScope.BOILER, target.boilerId) ??
    find(ScheduleScope.ORGANIZATION, target.organizationId) ??
    find(ScheduleScope.OBJECT_TYPE, target.objectTypeId) ??
    find(ScheduleScope.GLOBAL, null) ??
    null
  );
}
