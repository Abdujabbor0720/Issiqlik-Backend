import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { DataSource, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  ACTIVE_INCIDENT_STATUSES,
  AlertSeverity,
  AlertType,
  AuditAction,
  DeviceType,
  EscalationCondition,
  IncidentEventType,
  IncidentKind,
  IncidentStatus,
  NotifyAudience,
} from '../../common/constants/enums';
import {
  EscalationRule,
  Incident,
} from '../../database/entities/incident.entities';
import type { SystemSetting } from '../../database/entities/system-setting.entity';
import { lotRef } from '../../helpers/boiler-label.helper';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import {
  decideRecurrence,
  dueEscalation,
  gateFor,
  INCIDENT_KIND_LABELS,
  incidentKey,
  incidentKindForAlert,
  isRoomCold,
  bypassesGate,
  isRoomRecovered,
  isSeverityHigher,
  maxSeverity,
} from '../../helpers/incident-rules.helper';
import { normalizeRoomKey } from '../../helpers/room-reading.helper';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import {
  MonitoringScheduleService,
  type EffectiveSchedule,
  type ScheduleState,
} from '../monitoring/monitoring-schedule.service';
import {
  ResponsiblesService,
  type BoilerResponsibles,
} from '../responsibles/responsibles.service';
import { SettingsService } from '../settings/settings.service';
import { EscalationRulesService } from './escalation-rules.service';
import {
  IncidentNotifierService,
  SYSTEM_ACTOR_LABEL,
} from './incident-notifier.service';

/** Ogohlantirish ochilgach qayta baholashgacha kutish — bir paketdagi signallar birlashadi. */
const FAST_PATH_DELAY_MS = 1500;

/** XAVF yaratish uchun obyekt konteksti. */
interface BoilerContext {
  id: string;
  lotNumber: string | null;
  districtId: string;
  organizationId: string | null;
  organizationName: string | null;
  objectTypeId: string | null;
  agencyId: string | null;
  agencyName: string | null;
  isArchived: boolean;
  lastReadingAt: Date | null;
  lastTemperature: number | null;
  lastInletTemperature: number | null;
}

/** «Hozir shu muammo bor» — bitta kalit bo'yicha. */
interface Condition {
  key: string;
  kind: IncidentKind;
  severity: AlertSeverity;
  boilerId: string;
  roomId: string | null;
  roomName: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  alertId: string | null;
  temperature: number | null;
  threshold: number | null;
}

export interface ReconcileReport {
  /** Hozir mavjud muammolar (jadvaldan qat'i nazar). */
  conditions: number;
  created: number;
  reopened: number;
  updated: number;
  autoResolved: number;
  /** Jadvaldan tashqarida — XAVF ochilmadi. */
  suppressed: number;
  /** Qo'lda bartaraf etilgan, kutish muddati tugamagan. */
  waiting: number;
}

/** Past harorat turlari — «eng yomon» qiymat = eng pasti. */
const LOW_KINDS: readonly IncidentKind[] = [
  IncidentKind.ROOM_LOW_TEMPERATURE,
  IncidentKind.BOILER_LOW_TEMPERATURE,
];

/**
 * XAVF DVIGATELI — «hozir qanday muammolar bor» ni faol hodisalar bilan
 * SOLISHTIRADI (reconcile) va farqni yopadi.
 *
 * ⚠️⚠️ NEGA HODISA (event) EMAS, HOLAT (state) ASOSIDA. Agar XAVF faqat
 * «ogohlantirish ochildi» hodisasida yaratilsa, UCHTA jim bo'shliq qolardi:
 *   1) 05:30 da sovigan sinfxona 07:00 da (monitoring boshlanganda) XAVF
 *      bo'lishi kerak — lekin 07:00 da hech qanday «hodisa» bo'lmaydi;
 *   2) server qayta ishga tushganda yo'qolgan signal hech qachon qaytmaydi;
 *   3) xona minimumi obyektda 18 °C, umumiy sozlamada 15 °C — 16 °C li
 *      xona uchun umuman ogohlantirish ochilmaydi.
 * Shuning uchun har daqiqada (va ogohlantirish o'zgarganda darhol)
 * holat qayta o'qiladi; natija bir xil kirishda bir xil — takroriy
 * ishlash xavfsiz (idempotent).
 *
 * ⚠️⚠️ MANBALAR:
 *   • kotyol muammolari — ochiq `alerts` qatorlari (datchik, sirkulyatsiya,
 *     qizish mantig'i telemetriyada; bu yerda qayta yozilmaydi);
 *   • xona sovuqligi — `rooms` holati va OBYEKT jadvalidagi minimum;
 *   • qurilma uzilishi — `devices.last_seen_at` (kotyol VA xona moduli).
 *
 * ⚠️⚠️ QURILMA YUBORGAN `institution_id` GA TAYANILMAYDI: obyekt faqat
 * `devices.boiler_id` (server biriktirgan) orqali aniqlanadi — XAVF qaysi
 * muassasa, tuman va tashkilotga borishi shu zanjirdan chiqadi.
 */
@Injectable()
export class IncidentEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncidentEngineService.name);
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private subscription: Subscription | null = null;

  constructor(
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly schedules: MonitoringScheduleService,
    private readonly responsibles: ResponsiblesService,
    private readonly rules: EscalationRulesService,
    private readonly notifier: IncidentNotifierService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════ Hayot sikli ════════════════════════

  /**
   * ⚠️ TEZKOR YO'L: ogohlantirish ochilsa yoki yopilsa, o'sha obyekt
   * ~1.5 s ichida qayta baholanadi — cron'ni (60 s) kutmasdan. Bir
   * paketdagi signallar (10 xona birdan) bitta baholashga yig'iladi.
   */
  onModuleInit(): void {
    this.subscription = this.alerts.changes$.subscribe((boilerId) => {
      this.pending.add(boilerId);
      this.flushTimer ??= setTimeout(() => this.flush(), FAST_PATH_DELAY_MS);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  /** To'liq sikl: solishtirish + eskalatsiya (cron). */
  runCycle(now = new Date()): Promise<ReconcileReport & { escalated: number }> {
    return this.exclusive(async () => {
      /*
       * ⚠️ Solishtirish yiqilsa ham eskalatsiya ISHLAYDI: bitta buzuq obyekt
       * (masalan, kutilmagan ma'lumot) butun viloyat bo'yicha «qabul
       * qilinmadi» xabarlarini to'xtatib qo'ymasligi kerak.
       */
      let report: ReconcileReport = {
        conditions: 0,
        created: 0,
        reopened: 0,
        updated: 0,
        autoResolved: 0,
        suppressed: 0,
        waiting: 0,
      };
      try {
        report = await this.reconcile({ now });
      } catch (error) {
        this.logger.error(
          'XAVF solishtirish yiqildi',
          error instanceof Error ? error.stack : String(error),
        );
      }
      const escalated = await this.escalate(now);
      return { ...report, escalated };
    });
  }

  /** Faqat solishtirish (ixtiyoriy: faqat shu obyektlar). */
  reconcileNow(
    boilerIds?: string[],
    now = new Date(),
  ): Promise<ReconcileReport> {
    return this.exclusive(() => this.reconcile({ boilerIds, now }));
  }

  /** Faqat eskalatsiya — muddatni tekshirish uchun `now` beriladi. */
  escalateNow(now = new Date()): Promise<number> {
    return this.exclusive(() => this.escalate(now));
  }

  /**
   * ⚠️ BIR NUSXADA BITTADAN: cron va tezkor yo'l bir vaqtda ishlasa, ikkalasi
   * ham «faol hodisa yo'q» deb ko'rib, ikkinchisi yagona indeksga urilardi
   * (zararsiz, lekin shovqin). Bir nechta server nusxasida esa himoya —
   * bazadagi yagona indeks va CAS yozuvlar.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private flush(): void {
    this.flushTimer = null;
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length === 0) return;
    this.reconcileNow(ids).catch((error: unknown) =>
      this.logger.warn(
        'XAVF tezkor baholash yiqildi (cron qayta urinadi): ' +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }

  // ════════════════════════ Solishtirish ════════════════════════

  private async reconcile(input: {
    boilerIds?: string[];
    now: Date;
  }): Promise<ReconcileReport> {
    const { now } = input;
    const filter = input.boilerIds?.length ? input.boilerIds : null;
    const report: ReconcileReport = {
      conditions: 0,
      created: 0,
      reopened: 0,
      updated: 0,
      autoResolved: 0,
      suppressed: 0,
      waiting: 0,
    };

    const settings = await this.settings.get();
    const state = await this.schedules.state();
    const staleBefore = new Date(
      now.getTime() - settings.offlineAfterMinutes * 60_000,
    );

    // ─── 1. Xom holat ───
    const [alerts, coldRooms, staleDevices, active] = await Promise.all([
      this.loadOpenAlerts(filter),
      this.loadColdRoomCandidates(filter, staleBefore, settings, state),
      this.loadStaleDevices(filter, staleBefore),
      this.incidents.find({
        where: {
          status: In([...ACTIVE_INCIDENT_STATUSES]),
          ...(filter ? { boilerId: In(filter) } : {}),
        },
      }),
    ]);

    const boilerIds = new Set<string>([
      ...alerts.map((row) => row.boiler_id),
      ...coldRooms.map((row) => row.boiler_id),
      ...staleDevices.map((row) => row.boiler_id),
      ...active.map((row) => row.boilerId),
    ]);
    const contexts = await this.loadBoilers([...boilerIds]);
    const effective = new Map<string, EffectiveSchedule>();
    const scheduleFor = (ctx: BoilerContext): EffectiveSchedule => {
      let value = effective.get(ctx.id);
      if (!value) {
        value = this.schedules.effectiveFrom(
          state,
          {
            boilerId: ctx.id,
            organizationId: ctx.organizationId,
            objectTypeId: ctx.objectTypeId,
          },
          settings.roomMinC,
        );
        effective.set(ctx.id, value);
      }
      return value;
    };

    // ─── 2. Shartlar ───
    const conditions = await this.buildConditions({
      alerts,
      coldRooms,
      staleDevices,
      contexts,
      settings,
      staleBefore,
      scheduleFor,
    });
    report.conditions = conditions.size;

    // ─── 3. Faol hodisalarni yangilash / yangi nomzodlar ───
    const activeByKey = new Map(active.map((row) => [row.dedupeKey, row]));
    const candidates: Array<{ condition: Condition; ctx: BoilerContext }> = [];

    for (const condition of conditions.values()) {
      const ctx = contexts.get(condition.boilerId);
      if (!ctx) continue;
      const existing = activeByKey.get(condition.key);
      if (existing) {
        await this.safely(`XAVF №${existing.number} yangilanmadi`, async () => {
          if (await this.refresh(existing, condition, now)) report.updated += 1;
        });
        continue;
      }
      /*
       * ⚠️ Jadval faqat ODATIY past haroratni yashiradi; muzlash xavfi
       * (≤ 5 °C) har qanday vaqtda XAVF (`bypassesGate`).
       */
      if (
        !bypassesGate(condition.kind, condition.temperature) &&
        !this.inGate(condition.kind, scheduleFor(ctx), now, state)
      ) {
        report.suppressed += 1;
        continue;
      }
      candidates.push({ condition, ctx });
    }

    if (candidates.length > 0) {
      const latest = await this.loadLatestByKey(
        candidates.map((item) => item.condition.key),
      );
      const toCreate: typeof candidates = [];
      for (const item of candidates) {
        const previous = latest.get(item.condition.key) ?? null;
        const decision = decideRecurrence(previous, now);
        if (decision === 'wait') {
          report.waiting += 1;
        } else if (decision === 'reopen' && previous) {
          await this.safely(
            `XAVF №${previous.number} qayta ochilmadi`,
            async () => {
              if (await this.reopen(previous, item.condition, now)) {
                report.reopened += 1;
              }
            },
          );
        } else {
          toCreate.push(item);
        }
      }

      if (toCreate.length > 0) {
        const responsibles = await this.responsibles.forBoilers([
          ...new Set(toCreate.map((item) => item.ctx.id)),
        ]);
        for (const item of toCreate) {
          await this.safely(
            `XAVF yaratilmadi (${item.condition.key})`,
            async () => {
              const created = await this.create(
                item.condition,
                item.ctx,
                scheduleFor(item.ctx),
                responsibles.get(item.ctx.id) ?? { snapshots: [], users: [] },
                now,
              );
              if (created) report.created += 1;
            },
          );
        }
      }
    }

    // ─── 4. Muammosi yo'qolgan faol hodisalar ───
    const resolvedIds = new Set<string>();
    const orphaned = active.filter((row) => !conditions.has(row.dedupeKey));
    if (orphaned.length > 0) {
      const evidence = await this.loadEvidence(orphaned);
      for (const incident of orphaned) {
        const ctx = contexts.get(incident.boilerId) ?? null;
        const verdict = this.resolutionFor(incident, {
          ctx,
          room: incident.roomId ? evidence.rooms.get(incident.roomId) : null,
          device: incident.deviceId
            ? evidence.devices.get(incident.deviceId)
            : null,
          minRoomC: ctx ? scheduleFor(ctx).minRoomTemperature : null,
          settings,
          staleBefore,
        });
        if (!verdict) continue;
        await this.safely(`XAVF №${incident.number} yopilmadi`, async () => {
          if (await this.autoResolve(incident, verdict, now)) {
            report.autoResolved += 1;
            resolvedIds.add(incident.id);
          }
        });
      }
    }

    // ─── 5. Keyin biriktirilgan mas'ullar va yuborilmay qolgan xabarlar ───
    await this.safely('yo‘naltirish to‘ldirilmadi', () =>
      this.fillRoutingGaps(
        active.filter((row) => !resolvedIds.has(row.id)),
        contexts,
      ),
    );
    await this.safely('yuborilmagan xabarlar qayta yuborilmadi', () =>
      this.retryInitialNotifications(filter),
    );

    return report;
  }

  /**
   * ⚠️ Bitta hodisadagi xato BUTUN siklni to'xtatmaydi: 2000 obyektdan
   * bittasidagi kutilmagan qiymat qolgan 1999 tasining XAVF ini yashirmasin.
   */
  private async safely(
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `XAVF dvigateli: ${label}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * KECH BIRIKTIRILGAN MAS'ULLAR.
   *
   * ⚠️⚠️ Hodisa ochilganda muassasa hech qaysi tashkilotga biriktirilmagan
   * (yoki javobgar yo'q) bo'lishi mumkin. Admin buni keyin tuzatsa, HALI
   * FAOL hodisa ham yangi mas'ulga yetib borishi kerak — aks holda tashkilot
   * mas'uli uni ko'rmasdi va unga eskalatsiya ham bo'sh ketardi.
   *
   * ⚠️ Faqat BO'SHLIQ to'ldiriladi: allaqachon yo'naltirilgan hodisa boshqa
   * idoraga KO'CHIRILMAYDI («qaysi idoraga yuborilgan edi» tarixi buzilmasin).
   */
  private async fillRoutingGaps(
    incidents: Incident[],
    contexts: Map<string, BoilerContext>,
  ): Promise<void> {
    const candidates = incidents.filter((incident) => {
      const ctx = contexts.get(incident.boilerId);
      if (!ctx || ctx.isArchived) return false;
      return (
        (!incident.organizationId && !!ctx.organizationId) ||
        (!incident.agencyId && !!ctx.agencyId) ||
        incident.responsibleSnapshot.length === 0
      );
    });
    if (candidates.length === 0) return;

    const responsibles = await this.responsibles.forBoilers([
      ...new Set(
        candidates
          .filter((incident) => incident.responsibleSnapshot.length === 0)
          .map((incident) => incident.boilerId),
      ),
    ]);

    for (const incident of candidates) {
      const ctx = contexts.get(incident.boilerId) as BoilerContext;
      const patch: QueryDeepPartialEntity<Incident> = {};
      const audiences: NotifyAudience[] = [];
      let responsibleUsers: Array<{ userId: string; label: string }> = [];

      if (!incident.organizationId && ctx.organizationId) {
        patch.organizationId = ctx.organizationId;
        patch.organizationName = ctx.organizationName;
      }
      if (!incident.agencyId && ctx.agencyId) {
        patch.agencyId = ctx.agencyId;
        patch.agencyName = ctx.agencyName;
        audiences.push(NotifyAudience.AGENCY);
      }
      const found = responsibles.get(incident.boilerId);
      if (
        incident.responsibleSnapshot.length === 0 &&
        found?.snapshots.length
      ) {
        patch.responsibleSnapshot = found.snapshots;
        responsibleUsers = found.users;
        audiences.push(NotifyAudience.RESPONSIBLE);
      }
      if (Object.keys(patch).length === 0) continue;

      await this.safely(
        `XAVF №${incident.number} yo‘naltirilmadi`,
        async () => {
          await this.incidents.update(incident.id, patch);
          Object.assign(incident, patch);
          if (audiences.length > 0) {
            await this.notifier.notify(incident, {
              level: 0,
              audiences,
              responsibleUsers,
              reason: 'keyin biriktirilgan mas‘ul',
            });
          }
          this.notifier.broadcast(
            incident,
            'updated',
            await this.notifiedUsers(incident.id),
          );
        },
      );
    }
  }

  /**
   * YUBORILMAY QOLGAN DASTLABKI XABAR.
   *
   * ⚠️ Hodisa yozilgach, xabar yuborilishidan OLDIN jarayon to'xtasa
   * (deploy, xotira), hodisa bor-u, hech kim bilmasdi. Tarixida «yuborildi»
   * yozuvi yo'q faol hodisa shu yerda qayta yuboriladi; takror yo'q —
   * `incident_notifications` yagona kaliti.
   *
   * ⚠️ 30 s kutiladi: boshqa server nusxasi hozirgina yaratayotgan hodisaga
   * ikkinchi marta yubormaslik uchun.
   */
  private async retryInitialNotifications(
    filter: string[] | null,
  ): Promise<void> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT i.id FROM incidents i
        WHERE i.status IN ('new', 'acknowledged', 'in_progress')
          AND i.created_at < now() - interval '30 seconds'
          AND ($1::uuid[] IS NULL OR i.boiler_id = ANY($1::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM incident_events e
                           WHERE e.incident_id = i.id AND e.type = 'notified')`,
      [filter],
    );
    if (rows.length === 0) return;

    const incidents = await this.incidents.find({
      where: { id: In(rows.map((row) => row.id)) },
    });
    const responsibles = await this.responsibles.forBoilers([
      ...new Set(incidents.map((incident) => incident.boilerId)),
    ]);
    for (const incident of incidents) {
      await this.safely(
        `XAVF №${incident.number} xabari qayta yuborilmadi`,
        () =>
          this.notifier.notify(incident, {
            level: 0,
            audiences: [
              NotifyAudience.RESPONSIBLE,
              NotifyAudience.DISTRICT,
              NotifyAudience.AGENCY,
            ],
            responsibleUsers: responsibles.get(incident.boilerId)?.users ?? [],
            reason: 'qayta yuborish (avvalgisi yetib bormagan)',
          }),
      );
    }
  }

  /** Xom holatdan «hozir qanday muammolar bor» to'plami. */
  private async buildConditions(input: {
    alerts: OpenAlertRow[];
    coldRooms: ColdRoomRow[];
    staleDevices: StaleDeviceRow[];
    contexts: Map<string, BoilerContext>;
    settings: SystemSetting;
    staleBefore: Date;
    scheduleFor: (ctx: BoilerContext) => EffectiveSchedule;
  }): Promise<Map<string, Condition>> {
    const conditions = new Map<string, Condition>();
    const add = (condition: Condition) => {
      const existing = conditions.get(condition.key);
      if (!existing) {
        conditions.set(condition.key, condition);
        return;
      }
      existing.severity = maxSeverity(existing.severity, condition.severity);
      existing.alertId ??= condition.alertId;
    };

    // ─── Kotyol (texnik ogohlantirishlardan) ───
    const roomAlerts = new Map<string, string>();
    for (const alert of input.alerts) {
      if (alert.type === AlertType.ROOM_COLD) {
        if (alert.room_id) roomAlerts.set(alert.room_id, alert.id);
        continue;
      }
      const ctx = input.contexts.get(alert.boiler_id);
      if (!ctx || ctx.isArchived) continue;
      const fresh =
        !!ctx.lastReadingAt && ctx.lastReadingAt > input.staleBefore;
      const kind = incidentKindForAlert({
        type: alert.type,
        boilerFresh: fresh,
        temperature: ctx.lastTemperature,
      });
      if (!kind) continue;
      add({
        key: incidentKey(kind, ctx.id),
        kind,
        // ⚠️ `offline` — «kritik sovuq» ma'nosida: kritik.
        severity:
          alert.type === AlertType.OFFLINE
            ? AlertSeverity.CRITICAL
            : alert.severity,
        boilerId: ctx.id,
        roomId: null,
        roomName: null,
        deviceId: null,
        deviceLabel: null,
        alertId: alert.id,
        temperature: ctx.lastTemperature,
        threshold: this.boilerThreshold(kind, input.settings),
      });
    }

    // ─── Xona sovuqligi (obyekt jadvalidagi minimum bilan) ───
    const roomDevices = await this.loadDevicesByRoomKey([
      ...new Set(input.coldRooms.map((room) => room.boiler_id)),
    ]);
    for (const room of input.coldRooms) {
      const ctx = input.contexts.get(room.boiler_id);
      if (!ctx || ctx.isArchived) continue;
      const temperature = Number(room.last_temperature);
      const minC = input.scheduleFor(ctx).minRoomTemperature;
      if (!isRoomCold(temperature, minC)) continue;
      const device = roomDevices.get(`${room.boiler_id}|${room.sensor_key}`);
      add({
        key: incidentKey(IncidentKind.ROOM_LOW_TEMPERATURE, ctx.id, {
          roomId: room.id,
        }),
        kind: IncidentKind.ROOM_LOW_TEMPERATURE,
        severity: AlertSeverity.WARNING,
        boilerId: ctx.id,
        roomId: room.id,
        roomName: room.name,
        deviceId: device?.id ?? null,
        deviceLabel: device?.label ?? null,
        alertId: roomAlerts.get(room.id) ?? null,
        temperature,
        threshold: minC,
      });
    }

    // ─── Qurilma uzilishi (kotyol va xona moduli) ───
    const deviceRooms = await this.loadRoomsForDevices(input.staleDevices);
    for (const device of input.staleDevices) {
      const ctx = input.contexts.get(device.boiler_id);
      if (!ctx || ctx.isArchived) continue;
      const room = deviceRooms.get(device.id) ?? null;
      // ⚠️ Nazoratdan chiqarilgan xonaning moduli — XAVF emas (ta'mir, qozonxona).
      if (room && !room.is_monitored) continue;
      add({
        key: incidentKey(IncidentKind.DEVICE_OFFLINE, ctx.id, {
          deviceId: device.id,
        }),
        kind: IncidentKind.DEVICE_OFFLINE,
        // ⚠️ Kotyol moduli uzilsa — butun qozonxona ko'rinmaydi (kritik).
        severity:
          device.device_type === DeviceType.XONA
            ? AlertSeverity.WARNING
            : AlertSeverity.CRITICAL,
        boilerId: ctx.id,
        roomId: room?.id ?? null,
        roomName: room?.name ?? null,
        deviceId: device.id,
        deviceLabel: device.name ?? device.device_id,
        alertId: null,
        temperature: null,
        threshold: null,
      });
    }

    return conditions;
  }

  /** Jadval: shu tur hozir yangi XAVF ochishi mumkinmi. */
  private inGate(
    kind: IncidentKind,
    schedule: EffectiveSchedule,
    now: Date,
    state: ScheduleState,
  ): boolean {
    const gate = gateFor(kind);
    if (gate === 'monitor') {
      return this.schedules.inMonitorWindow(schedule, now, state.holidays);
    }
    if (gate === 'heating') {
      return this.schedules.inHeatingWindow(schedule, now, state.holidays);
    }
    return true;
  }

  private boilerThreshold(
    kind: IncidentKind,
    settings: SystemSetting,
  ): number | null {
    switch (kind) {
      case IncidentKind.BOILER_LOW_TEMPERATURE:
        return settings.activeMinC;
      case IncidentKind.OVERHEAT:
        return settings.overheatC;
      case IncidentKind.NO_CIRCULATION:
        return settings.minDeltaC;
      default:
        return null;
    }
  }

  // ════════════════════════ Yozuvlar ════════════════════════

  private async create(
    condition: Condition,
    ctx: BoilerContext,
    schedule: EffectiveSchedule,
    responsible: BoilerResponsibles,
    now: Date,
  ): Promise<boolean> {
    const values: QueryDeepPartialEntity<Incident> = {
      dedupeKey: condition.key,
      kind: condition.kind,
      severity: condition.severity,
      status: IncidentStatus.NEW,
      title: this.titleFor(condition, ctx),
      boilerId: ctx.id,
      roomId: condition.roomId,
      roomName: condition.roomName,
      deviceId: condition.deviceId,
      deviceLabel: condition.deviceLabel,
      organizationId: ctx.organizationId,
      organizationName: ctx.organizationName,
      districtId: ctx.districtId,
      agencyId: ctx.agencyId,
      agencyName: ctx.agencyName,
      sourceAlertId: condition.alertId,
      temperature: condition.temperature,
      currentTemperature: condition.temperature,
      extremeTemperature: condition.temperature,
      threshold: condition.threshold,
      detectedAt: now,
      openedAt: now,
      lastSeenAt: now,
      scheduleSnapshot: this.schedules.snapshot(schedule),
      responsibleSnapshot: responsible.snapshots,
    };

    /*
     * ⚠️⚠️ `ON CONFLICT DO NOTHING`: parallel baholash (boshqa server nusxasi)
     * AYNI kalit bo'yicha hodisani hozirgina yozgan bo'lsa, bu yerda xato
     * ham, dublikat ham yo'q — natija kerakli: bitta faol hodisa.
     */
    const result = await this.incidents
      .createQueryBuilder()
      .insert()
      .into(Incident)
      .values(values)
      .orIgnore()
      .returning(['id'])
      .execute();
    const id = (result.raw as Array<{ id: string }>)[0]?.id;
    if (!id) return false;

    const incident = await this.incidents.findOneByOrFail({ id });
    await this.notifier.addEvent(id, IncidentEventType.CREATED, {
      to: IncidentStatus.NEW,
      payload: {
        temperature: condition.temperature,
        threshold: condition.threshold,
        sourceAlertId: condition.alertId,
        schedule: incident.scheduleSnapshot,
        responsibles: responsible.snapshots.length,
      },
    });
    await this.audit.log({
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AuditAction.CREATE,
      entityName: 'Incident',
      entityId: id,
      summary: `XAVF №${incident.number} aniqlandi: ${incident.title}`,
      after: {
        kind: incident.kind,
        severity: incident.severity,
        boilerId: incident.boilerId,
        districtId: incident.districtId,
        agencyId: incident.agencyId,
        temperature: incident.temperature,
        threshold: incident.threshold,
      },
    });

    /*
     * ⚠️ Dastlabki yuborish: obyekt javobgari + TUMAN + TASHKILOT
     * (texnik topshiriq §4: «ikkala mas'ul yo'nalish ham ishlasin»).
     * Viloyat — o'z panelida ko'radi (realtime), shaxsan esa faqat
     * eskalatsiyada.
     */
    await this.notifier.notify(incident, {
      level: 0,
      audiences: [
        NotifyAudience.RESPONSIBLE,
        NotifyAudience.DISTRICT,
        NotifyAudience.AGENCY,
      ],
      responsibleUsers: responsible.users,
      reason: 'yangi XAVF',
    });
    this.notifier.broadcast(
      incident,
      'created',
      responsible.users.map((user) => user.userId),
    );
    return true;
  }

  /**
   * DAVOM ETAYOTGAN HODISA — joriy harorat, eng yomon qiymat, og'irlik.
   * ⚠️ `detectedAt` ga TEGILMAYDI: «qachondan beri» shu maydonda.
   */
  private async refresh(
    incident: Incident,
    condition: Condition,
    now: Date,
  ): Promise<boolean> {
    const patch: QueryDeepPartialEntity<Incident> = {
      lastSeenAt: now,
      currentTemperature: condition.temperature,
    };
    if (condition.temperature !== null) {
      const extreme = incident.extremeTemperature;
      const worse =
        extreme === null ||
        (LOW_KINDS.includes(incident.kind)
          ? condition.temperature < extreme
          : condition.temperature > extreme);
      if (worse) patch.extremeTemperature = condition.temperature;
    }
    if (!incident.sourceAlertId && condition.alertId) {
      patch.sourceAlertId = condition.alertId;
    }
    const raised = isSeverityHigher(condition.severity, incident.severity);
    if (raised) patch.severity = condition.severity;

    await this.incidents.update(incident.id, patch);

    if (raised) {
      await this.notifier.addEvent(
        incident.id,
        IncidentEventType.SEVERITY_RAISED,
        {
          note: `Og‘irlik oshdi: ${incident.severity} → ${condition.severity}`,
          payload: { temperature: condition.temperature },
        },
      );
      incident.severity = condition.severity;
      this.notifier.broadcast(
        incident,
        'updated',
        await this.notifiedUsers(incident.id),
      );
    }
    return true;
  }

  /**
   * QAYTA OCHISH — muammo qaytdi (`decideRecurrence`).
   * ⚠️ Yangi ogohlantirish YARATILMAYDI: mas'ullar bu hodisani biladi.
   */
  private async reopen(
    previous: Incident,
    condition: Condition,
    now: Date,
  ): Promise<boolean> {
    const to = previous.acknowledgedAt
      ? IncidentStatus.IN_PROGRESS
      : IncidentStatus.NEW;
    try {
      const result = await this.incidents
        .createQueryBuilder()
        .update(Incident)
        .set({
          status: to,
          resolvedAt: null,
          resolvedById: null,
          resolution: null,
          resolutionNote: null,
          openedAt: now,
          lastSeenAt: now,
          currentTemperature: condition.temperature,
          severity: maxSeverity(previous.severity, condition.severity),
          reopenCount: () => 'reopen_count + 1',
        })
        .where('id = :id AND status = :status', {
          id: previous.id,
          status: IncidentStatus.RESOLVED,
        })
        .execute();
      if (!result.affected) return false;
    } catch (error) {
      // ⚠️ Shu kalitda boshqa faol hodisa allaqachon bor — dublikat ochilmaydi.
      if (isUniqueViolation(error)) return false;
      throw error;
    }

    const note =
      previous.resolution === 'manual'
        ? 'Qo‘lda «bartaraf etildi» deyilgan, lekin muammo davom etmoqda'
        : 'Muammo qayta paydo bo‘ldi';
    await this.notifier.addEvent(previous.id, IncidentEventType.REOPENED, {
      from: IncidentStatus.RESOLVED,
      to,
      note,
      payload: { temperature: condition.temperature },
    });
    await this.audit.log({
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Incident',
      entityId: previous.id,
      summary: `XAVF №${previous.number} qayta ochildi: ${note}`,
      before: { status: IncidentStatus.RESOLVED },
      after: { status: to },
    });
    const fresh = await this.incidents.findOneByOrFail({ id: previous.id });
    this.notifier.broadcast(
      fresh,
      'reopened',
      await this.notifiedUsers(fresh.id),
    );
    return true;
  }

  /**
   * AVTOMATIK BARTARAF — harorat me'yorga qaytdi / signal tiklandi.
   *
   * ⚠️ Holat `RESOLVED`, `CLOSED` EMAS: yopish — mas'ulning tekshiruvi.
   * Mas'ul yozgan izohlar va tarix o'z joyida qoladi.
   */
  private async autoResolve(
    incident: Incident,
    verdict: { reason: string; temperature: number | null },
    now: Date,
  ): Promise<boolean> {
    const result = await this.incidents
      .createQueryBuilder()
      .update(Incident)
      .set({
        status: IncidentStatus.RESOLVED,
        resolvedAt: now,
        resolvedById: null,
        resolution: 'auto',
        resolutionNote: verdict.reason,
        lastSeenAt: now,
        ...(verdict.temperature !== null
          ? { currentTemperature: verdict.temperature }
          : {}),
      })
      .where('id = :id AND status = :status', {
        id: incident.id,
        status: incident.status,
      })
      .execute();
    if (!result.affected) return false;

    await this.notifier.addEvent(incident.id, IncidentEventType.AUTO_RESOLVED, {
      from: incident.status,
      to: IncidentStatus.RESOLVED,
      note: verdict.reason,
      payload: { temperature: verdict.temperature },
    });
    await this.audit.log({
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Incident',
      entityId: incident.id,
      summary: `XAVF №${incident.number} avtomatik bartaraf etildi: ${verdict.reason}`,
      before: { status: incident.status },
      after: { status: IncidentStatus.RESOLVED, resolution: 'auto' },
    });
    incident.status = IncidentStatus.RESOLVED;
    this.notifier.broadcast(
      incident,
      'resolved',
      await this.notifiedUsers(incident.id),
    );
    return true;
  }

  /**
   * MUAMMO YO'QOLDI — LEKIN BUNGA DALIL BORMI.
   *
   * ⚠️⚠️ «Ogohlantirish yopildi» ≠ «muammo hal bo'ldi». Datchik uzilsa,
   * xona ogohlantirishi yopiladi (`resolveStaleRooms`), kotyolniki esa
   * «aloqa yo'q» ga almashadi. Bunda XAVF ni «bartaraf etildi» deyish
   * YOLG'ON bo'lardi: biz shunchaki ko'rmay qoldik. Shuning uchun faqat
   * IJOBIY DALIL bilan yopiladi (yangi o'lchov me'yorda / signal tiklandi);
   * dalil yo'q bo'lsa — hodisa faol qoladi (`null`).
   */
  private resolutionFor(
    incident: Incident,
    input: {
      ctx: BoilerContext | null;
      room: EvidenceRoom | null | undefined;
      device: EvidenceDevice | null | undefined;
      minRoomC: number | null;
      settings: SystemSetting;
      staleBefore: Date;
    },
  ): { reason: string; temperature: number | null } | null {
    const { ctx, settings, staleBefore } = input;
    if (!ctx) return null;
    if (ctx.isArchived) {
      return { reason: 'Obyekt arxivlandi', temperature: null };
    }
    const boilerFresh = !!ctx.lastReadingAt && ctx.lastReadingAt > staleBefore;
    const t = ctx.lastTemperature;

    switch (incident.kind) {
      case IncidentKind.ROOM_LOW_TEMPERATURE: {
        const room = input.room;
        if (!room) return { reason: 'Xona o‘chirildi', temperature: null };
        if (!room.is_monitored) {
          return { reason: 'Xona nazoratdan chiqarildi', temperature: null };
        }
        const fresh =
          !!room.last_reading_at && room.last_reading_at > staleBefore;
        const temperature =
          room.last_temperature === null ? null : Number(room.last_temperature);
        if (
          fresh &&
          temperature !== null &&
          input.minRoomC !== null &&
          isRoomRecovered(temperature, input.minRoomC)
        ) {
          return {
            reason: `Xona harorati me‘yorga qaytdi: ${temperature.toFixed(1)} °C`,
            temperature,
          };
        }
        return null;
      }

      case IncidentKind.DEVICE_OFFLINE: {
        const device = input.device;
        if (!device) return { reason: 'Qurilma o‘chirildi', temperature: null };
        if (!device.is_active || device.boiler_id !== incident.boilerId) {
          return { reason: 'Qurilma obyektdan ajratildi', temperature: null };
        }
        // ⚠️ Xona nazoratdan chiqarildi — uning moduli endi XAVF emas (aks holda abadiy faol qolardi).
        if (input.room && !input.room.is_monitored) {
          return { reason: 'Xona nazoratdan chiqarildi', temperature: null };
        }
        if (device.last_seen_at && device.last_seen_at > staleBefore) {
          return { reason: 'Qurilmadan signal tiklandi', temperature: null };
        }
        return null;
      }

      case IncidentKind.BOILER_LOW_TEMPERATURE:
        return boilerFresh && t !== null && t >= settings.activeMinC
          ? {
              reason: `Kotyol harorati me‘yorga qaytdi: ${t.toFixed(1)} °C`,
              temperature: t,
            }
          : null;

      case IncidentKind.SENSOR_FAULT:
        return boilerFresh && t !== null
          ? { reason: 'Datchik qiymat bera boshladi', temperature: t }
          : null;

      case IncidentKind.OVERHEAT:
        return boilerFresh && t !== null && t < settings.overheatC
          ? {
              reason: `Harorat xavfsiz chegaraga tushdi: ${t.toFixed(1)} °C`,
              temperature: t,
            }
          : null;

      case IncidentKind.NO_CIRCULATION: {
        /*
         * ⚠️ Dalil — AYIRMA: kirish datchigi jim bo'lsa (`inlet = null`)
         * sirkulyatsiyani baholab bo'lmaydi va «tiklandi» deyish yolg'on.
         */
        const inlet = ctx.lastInletTemperature;
        return boilerFresh &&
          t !== null &&
          inlet !== null &&
          t >= settings.activeMinC &&
          Math.abs(t - inlet) >= settings.minDeltaC
          ? { reason: 'Suv aylanishi tiklandi', temperature: t }
          : null;
      }
    }
  }

  // ════════════════════════ Eskalatsiya ════════════════════════

  private async escalate(now: Date): Promise<number> {
    const rules = await this.rules.rules();
    if (rules.length === 0) return 0;

    const active = await this.incidents.find({
      where: { status: In([...ACTIVE_INCIDENT_STATUSES]) },
    });
    let escalated = 0;

    for (const incident of active) {
      const rule = dueEscalation(incident, rules, now);
      if (!rule) continue;
      await this.safely(`XAVF №${incident.number} eskalatsiyasi`, async () => {
        if (await this.escalateOne(incident, rule, now)) escalated += 1;
      });
    }
    return escalated;
  }

  /** Bitta hodisani bitta darajaga ko'tarish (CAS bilan). */
  private async escalateOne(
    incident: Incident,
    rule: EscalationRule,
    now: Date,
  ): Promise<boolean> {
    /*
     * ⚠️⚠️ CAS: daraja FAQAT o'qilgan qiymatdan ko'tariladi. Ikki cron
     * (ikki server nusxasi) bir vaqtda ko'tarmoqchi bo'lsa, faqat
     * bittasi yozadi — xabar ikki marta ketmaydi.
     */
    const cas = this.incidents
      .createQueryBuilder()
      .update(Incident)
      .set({ escalationLevel: rule.level, lastEscalatedAt: now })
      .where(
        'id = :id AND escalation_level = :level AND status IN (:...statuses)',
        {
          id: incident.id,
          level: incident.escalationLevel,
          statuses: [...ACTIVE_INCIDENT_STATUSES],
        },
      );
    /*
     * ⚠️ «Qabul qilinmadi» qoidasida holat ham CAS ga kiradi: o'qish va
     * yozish orasida mas'ul qabul qilib ulgurgan bo'lsa — eskalatsiya YO'Q.
     */
    if (rule.condition === EscalationCondition.NOT_ACKNOWLEDGED) {
      cas.andWhere('status = :fresh', { fresh: IncidentStatus.NEW });
    }
    const result = await cas.execute();
    if (!result.affected) return false;

    incident.escalationLevel = rule.level;
    incident.lastEscalatedAt = now;
    const conditionLabel =
      rule.condition === EscalationCondition.NOT_ACKNOWLEDGED
        ? 'qabul qilinmadi'
        : 'bartaraf etilmadi';
    const note = `${rule.afterMinutes} daqiqa ichida ${conditionLabel} — ${rule.level}-daraja (${rule.target})`;

    await this.notifier.addEvent(incident.id, IncidentEventType.ESCALATED, {
      note,
      payload: {
        level: rule.level,
        condition: rule.condition,
        afterMinutes: rule.afterMinutes,
        target: rule.target,
        ruleId: rule.id,
      },
    });
    await this.audit.log({
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AuditAction.ESCALATE,
      entityName: 'Incident',
      entityId: incident.id,
      summary: `XAVF №${incident.number} eskalatsiya qilindi: ${note}`,
      after: { level: rule.level, target: rule.target },
    });
    await this.notifier.notify(incident, {
      level: rule.level,
      audiences: [rule.target],
      reason: `eskalatsiya, ${rule.level}-daraja`,
    });
    this.notifier.broadcast(
      incident,
      'escalated',
      await this.notifiedUsers(incident.id),
    );
    return true;
  }

  // ════════════════════════ O'qish ════════════════════════

  private loadOpenAlerts(filter: string[] | null): Promise<OpenAlertRow[]> {
    return this.dataSource.query<OpenAlertRow[]>(
      `SELECT a.id, a.boiler_id, a.type, a.severity, a.room_id
         FROM alerts a
        WHERE a.state IN ('open', 'acknowledged')
          AND ($1::uuid[] IS NULL OR a.boiler_id = ANY($1::uuid[]))`,
      [filter],
    );
  }

  /**
   * SOVUQ XONA NOMZODLARI.
   *
   * ⚠️ Butun `rooms` jadvali o'qilmaydi: SQL da faqat «nazoratda, o'lchovi
   * yangi va harorati eng katta mumkin bo'lgan minimumdan past» xonalar
   * olinadi; aniq minimum (obyekt jadvalidan) keyin xotirada tekshiriladi.
   */
  private loadColdRoomCandidates(
    filter: string[] | null,
    staleBefore: Date,
    settings: SystemSetting,
    state: ScheduleState,
  ): Promise<ColdRoomRow[]> {
    const maxMin = Math.max(
      settings.roomMinC,
      ...state.schedules.map((row) => row.minRoomTemperature ?? -Infinity),
    );
    return this.dataSource.query<ColdRoomRow[]>(
      `SELECT r.id, r.boiler_id, r.name, r.sensor_key, r.last_temperature
         FROM rooms r
         JOIN boilers b ON b.id = r.boiler_id AND NOT b.is_archived
        WHERE r.is_monitored
          AND r.last_reading_at > $1
          AND r.last_temperature < $2
          AND ($3::uuid[] IS NULL OR r.boiler_id = ANY($3::uuid[]))`,
      [staleBefore, maxMin, filter],
    );
  }

  /**
   * UZILGAN QURILMALAR — kamida bir marta signal bergan (hech qachon
   * yoqilmagan, omborda turgan plata XAVF emas).
   */
  private loadStaleDevices(
    filter: string[] | null,
    staleBefore: Date,
  ): Promise<StaleDeviceRow[]> {
    return this.dataSource.query<StaleDeviceRow[]>(
      `SELECT d.id, d.device_id, d.name, d.boiler_id, d.device_type
         FROM devices d
         JOIN boilers b ON b.id = d.boiler_id AND NOT b.is_archived
        WHERE d.is_active
          AND d.last_seen_at IS NOT NULL
          AND d.last_seen_at < $1
          AND ($2::uuid[] IS NULL OR d.boiler_id = ANY($2::uuid[]))`,
      [staleBefore, filter],
    );
  }

  private async loadBoilers(
    ids: string[],
  ): Promise<Map<string, BoilerContext>> {
    const map = new Map<string, BoilerContext>();
    if (ids.length === 0) return map;
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        lot_number: string | null;
        district_id: string;
        organization_id: string | null;
        org_name: string | null;
        object_type_id: string | null;
        agency_id: string | null;
        agency_name: string | null;
        is_archived: boolean;
        last_reading_at: Date | null;
        last_temperature: string | null;
        last_inlet_temperature: string | null;
      }>
    >(
      `SELECT b.id, b.lot_number, b.district_id, b.organization_id, b.is_archived,
              b.last_reading_at, b.last_temperature, b.last_inlet_temperature,
              o.name AS org_name, o.object_type_id, o.agency_id, ag.name AS agency_name
         FROM boilers b
         LEFT JOIN organizations o ON o.id = b.organization_id
         LEFT JOIN agencies ag ON ag.id = o.agency_id
        WHERE b.id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        lotNumber: row.lot_number,
        districtId: row.district_id,
        organizationId: row.organization_id,
        organizationName: row.org_name,
        objectTypeId: row.object_type_id,
        agencyId: row.agency_id,
        agencyName: row.agency_name,
        isArchived: row.is_archived,
        lastReadingAt: row.last_reading_at,
        lastTemperature:
          row.last_temperature === null ? null : Number(row.last_temperature),
        lastInletTemperature:
          row.last_inlet_temperature === null
            ? null
            : Number(row.last_inlet_temperature),
      });
    }
    return map;
  }

  /** `qozonxona|xona_kaliti` → xona moduli (kalit = qurilma identifikatori). */
  private async loadDevicesByRoomKey(
    boilerIds: string[],
  ): Promise<Map<string, { id: string; label: string }>> {
    const map = new Map<string, { id: string; label: string }>();
    if (boilerIds.length === 0) return map;
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        device_id: string;
        name: string | null;
        boiler_id: string;
      }>
    >(
      `SELECT id, device_id, name, boiler_id FROM devices
        WHERE boiler_id = ANY($1::uuid[])`,
      [boilerIds],
    );
    for (const row of rows) {
      const key = normalizeRoomKey(row.device_id);
      if (key) {
        map.set(`${row.boiler_id}|${key}`, {
          id: row.id,
          label: row.name ?? row.device_id,
        });
      }
    }
    return map;
  }

  /** Uzilgan xona moduli → o'sha moduldan yaratilgan xona. */
  private async loadRoomsForDevices(
    devices: StaleDeviceRow[],
  ): Promise<Map<string, { id: string; name: string; is_monitored: boolean }>> {
    const map = new Map<
      string,
      { id: string; name: string; is_monitored: boolean }
    >();
    const keyed = devices
      .map((device) => ({ device, key: normalizeRoomKey(device.device_id) }))
      .filter(
        (item): item is { device: StaleDeviceRow; key: string } => !!item.key,
      );
    if (keyed.length === 0) return map;

    const rows = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        is_monitored: boolean;
        boiler_id: string;
        sensor_key: string;
      }>
    >(
      `SELECT id, name, is_monitored, boiler_id, sensor_key FROM rooms
        WHERE boiler_id = ANY($1::uuid[]) AND sensor_key = ANY($2::text[])`,
      [
        [...new Set(keyed.map((item) => item.device.boiler_id))],
        [...new Set(keyed.map((item) => item.key))],
      ],
    );
    for (const { device, key } of keyed) {
      const room = rows.find(
        (row) => row.boiler_id === device.boiler_id && row.sensor_key === key,
      );
      if (room) map.set(device.id, room);
    }
    return map;
  }

  /** Har kalit bo'yicha OXIRGI (bartaraf etilgan yoki yopilgan) hodisa. */
  private async loadLatestByKey(
    keys: string[],
  ): Promise<Map<string, Incident>> {
    const rows = await this.incidents
      .createQueryBuilder('i')
      .distinctOn(['i.dedupe_key'])
      .where('i.dedupe_key IN (:...keys)', { keys })
      .andWhere('i.status IN (:...statuses)', {
        statuses: [IncidentStatus.RESOLVED, IncidentStatus.CLOSED],
      })
      .orderBy('i.dedupe_key')
      .addOrderBy('i.created_at', 'DESC')
      .getMany();
    return new Map(rows.map((row) => [row.dedupeKey, row]));
  }

  private async loadEvidence(incidents: Incident[]): Promise<{
    rooms: Map<string, EvidenceRoom>;
    devices: Map<string, EvidenceDevice>;
  }> {
    const roomIds = incidents
      .map((row) => row.roomId)
      .filter((id): id is string => !!id);
    const deviceIds = incidents
      .map((row) => row.deviceId)
      .filter((id): id is string => !!id);
    const [rooms, devices] = await Promise.all([
      roomIds.length
        ? this.dataSource.query<EvidenceRoom[]>(
            `SELECT id, is_monitored, last_temperature, last_reading_at
               FROM rooms WHERE id = ANY($1::uuid[])`,
            [roomIds],
          )
        : Promise.resolve([]),
      deviceIds.length
        ? this.dataSource.query<EvidenceDevice[]>(
            `SELECT id, is_active, boiler_id, last_seen_at
               FROM devices WHERE id = ANY($1::uuid[])`,
            [deviceIds],
          )
        : Promise.resolve([]),
    ]);
    return {
      rooms: new Map(rooms.map((row) => [row.id, row])),
      devices: new Map(devices.map((row) => [row.id, row])),
    };
  }

  /** Shu hodisa bo'yicha shaxsan xabar olganlar — yangilanishlar ularga ham boradi. */
  private async notifiedUsers(incidentId: string): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ user_id: string }>>(
      `SELECT DISTINCT user_id FROM incident_notifications
        WHERE incident_id = $1 AND user_id IS NOT NULL`,
      [incidentId],
    );
    return rows.map((row) => row.user_id);
  }

  /** «XAVF: HARORAT ME'YORDAN PAST — 4-sonli maktab, 2-sinf». */
  private titleFor(condition: Condition, ctx: BoilerContext): string {
    const where = [
      ctx.organizationName ?? lotRef(ctx.lotNumber),
      condition.roomName ?? condition.deviceLabel,
    ]
      .filter(Boolean)
      .join(', ');
    return `XAVF: ${INCIDENT_KIND_LABELS[condition.kind].toUpperCase()} — ${where}`.slice(
      0,
      300,
    );
  }
}

interface OpenAlertRow {
  id: string;
  boiler_id: string;
  type: AlertType;
  severity: AlertSeverity;
  room_id: string | null;
}

interface ColdRoomRow {
  id: string;
  boiler_id: string;
  name: string;
  sensor_key: string;
  last_temperature: string;
}

interface StaleDeviceRow {
  id: string;
  device_id: string;
  name: string | null;
  boiler_id: string;
  device_type: DeviceType;
}

interface EvidenceRoom {
  id: string;
  is_monitored: boolean;
  last_temperature: string | null;
  last_reading_at: Date | null;
}

interface EvidenceDevice {
  id: string;
  is_active: boolean;
  boiler_id: string | null;
  last_seen_at: Date | null;
}
