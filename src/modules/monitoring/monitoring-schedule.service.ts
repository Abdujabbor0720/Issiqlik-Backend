import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import {
  AuditAction,
  ScheduleMode,
  ScheduleScope,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import type { ScheduleSnapshot } from '../../database/entities/incident.entities';
import {
  MonitoringHoliday,
  MonitoringSchedule,
} from '../../database/entities/monitoring.entities';
import { lotRef } from '../../helpers/boiler-label.helper';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import {
  formatHm,
  formatWindow,
  isWithinWindow,
  parseHm,
  pickEffectiveSchedule,
  type ScheduleTarget,
} from '../../helpers/monitoring-window.helper';
import { ObjectAccessService } from '../access/object-access.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import type {
  CreateHolidayDto,
  ScheduleQueryDto,
  UpsertScheduleDto,
} from './dto/monitoring.dto';

/** Obyekt uchun AMALDAGI jadval — XAVF dvigateli shu bilan ishlaydi. */
export interface EffectiveSchedule {
  scheduleId: string | null;
  source: ScheduleScope;
  mode: ScheduleMode;
  activeDays: number[];
  heatingStartMin: number;
  heatingEndMin: number;
  monitorStartMin: number;
  monitorEndMin: number;
  observeHolidays: boolean;
  /** Hal qilingan minimum: jadvaldan yoki umumiy sozlamadan. */
  minRoomTemperature: number;
  minRoomTemperatureSource: 'schedule' | 'settings';
}

/** Jadval va bayramlarning xotiradagi nusxasi. */
export interface ScheduleState {
  schedules: MonitoringSchedule[];
  holidays: ReadonlySet<string>;
}

/** API ko'rinishi. */
export interface ScheduleView {
  id: string;
  scopeType: ScheduleScope;
  scopeId: string | null;
  scopeLabel: string;
  mode: ScheduleMode;
  activeDays: number[];
  heatingStart: string;
  heatingEnd: string;
  monitorStart: string;
  monitorEnd: string;
  minRoomTemperature: number | null;
  observeHolidays: boolean;
  note: string | null;
  updatedAt: Date;
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * ⚠️⚠️ ZAXIRA — bazada global qator ham yo'q bo'lsa (qo'lda o'chirilgan).
 * 24/7: noaniqlikda XAVF yashirilmasin, ortiqcha bo'lsin.
 */
const FALLBACK: Omit<EffectiveSchedule, 'minRoomTemperature'> = {
  scheduleId: null,
  source: ScheduleScope.GLOBAL,
  mode: ScheduleMode.ALWAYS,
  activeDays: ALL_DAYS,
  heatingStartMin: 0,
  heatingEndMin: 0,
  monitorStartMin: 0,
  monitorEndMin: 0,
  observeHolidays: false,
  minRoomTemperatureSource: 'settings',
};

/**
 * MONITORING JADVALI VA BAYRAM KUNLARI.
 *
 * ⚠️ Jadval va bayramlar KESHLANADI (60 s): XAVF dvigateli har daqiqada
 * yuzlab obyekt uchun «hozir oyna ichidami» deb so'raydi. Yozishda kesh
 * darhol tozalanadi; 60 s chegarasi esa bir nechta server nusxasi
 * bo'lganda boshqa nusxadagi o'zgarish ham ko'p kutmasdan yetib kelishi
 * uchun.
 */
@Injectable()
export class MonitoringScheduleService {
  private cache: { at: number; state: ScheduleState } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(
    @InjectRepository(MonitoringSchedule)
    private readonly schedules: Repository<MonitoringSchedule>,
    @InjectRepository(MonitoringHoliday)
    private readonly holidays: Repository<MonitoringHoliday>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(ObjectType)
    private readonly objectTypes: Repository<ObjectType>,
    private readonly settings: SettingsService,
    private readonly access: ObjectAccessService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════ Dvigatel uchun ════════════════════════

  async state(): Promise<ScheduleState> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < MonitoringScheduleService.TTL_MS) {
      return this.cache.state;
    }
    const [schedules, holidays] = await Promise.all([
      this.schedules.find(),
      this.holidays.find({ select: { day: true } }),
    ]);
    const state: ScheduleState = {
      schedules,
      holidays: new Set(holidays.map((row) => row.day)),
    };
    this.cache = { at: now, state };
    return state;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Amaldagi jadval (sinxron — dvigatel holatni bir marta o'qiydi). */
  effectiveFrom(
    state: ScheduleState,
    target: ScheduleTarget,
    settingsRoomMinC: number,
  ): EffectiveSchedule {
    const row = pickEffectiveSchedule(state.schedules, target);
    if (!row) {
      return { ...FALLBACK, minRoomTemperature: settingsRoomMinC };
    }
    const own = row.minRoomTemperature;
    return {
      scheduleId: row.id,
      source: row.scopeType,
      mode: row.mode,
      activeDays: row.activeDays,
      heatingStartMin: row.heatingStartMin,
      heatingEndMin: row.heatingEndMin,
      monitorStartMin: row.monitorStartMin,
      monitorEndMin: row.monitorEndMin,
      observeHolidays: row.observeHolidays,
      minRoomTemperature: own ?? settingsRoomMinC,
      minRoomTemperatureSource: own === null ? 'settings' : 'schedule',
    };
  }

  inMonitorWindow(
    schedule: EffectiveSchedule,
    at: Date,
    holidays: ReadonlySet<string>,
  ): boolean {
    return isWithinWindow(
      at,
      schedule,
      { startMin: schedule.monitorStartMin, endMin: schedule.monitorEndMin },
      holidays,
    );
  }

  inHeatingWindow(
    schedule: EffectiveSchedule,
    at: Date,
    holidays: ReadonlySet<string>,
  ): boolean {
    return isWithinWindow(
      at,
      schedule,
      { startMin: schedule.heatingStartMin, endMin: schedule.heatingEndMin },
      holidays,
    );
  }

  /** Hodisaga muhrlanadigan nusxa. */
  snapshot(schedule: EffectiveSchedule): ScheduleSnapshot {
    return {
      source: schedule.source,
      mode: schedule.mode,
      activeDays: schedule.activeDays,
      heating: formatWindow(
        schedule.mode,
        schedule.heatingStartMin,
        schedule.heatingEndMin,
      ),
      monitor: formatWindow(
        schedule.mode,
        schedule.monitorStartMin,
        schedule.monitorEndMin,
      ),
      minRoomTemperature: schedule.minRoomTemperature,
      observeHolidays: schedule.observeHolidays,
    };
  }

  // ════════════════════════ API ════════════════════════

  /** Obyekt uchun amaldagi jadval va «hozir oyna ichidami». */
  async effectiveForBoiler(boilerId: string, user: AuthUser, now = new Date()) {
    await this.access.assertBoiler(user, boilerId);
    const target = await this.targetFor(boilerId);
    const [state, settings] = await Promise.all([
      this.state(),
      this.settings.get(),
    ]);
    const schedule = this.effectiveFrom(state, target, settings.roomMinC);
    return {
      ...this.snapshot(schedule),
      scheduleId: schedule.scheduleId,
      minRoomTemperatureSource: schedule.minRoomTemperatureSource,
      inMonitorWindow: this.inMonitorWindow(schedule, now, state.holidays),
      inHeatingWindow: this.inHeatingWindow(schedule, now, state.holidays),
    };
  }

  /** Obyektning muassasasi va turi — jadval darajalarini tanlash uchun. */
  async targetFor(boilerId: string): Promise<ScheduleTarget> {
    const row = await this.boilers
      .createQueryBuilder('boiler')
      .leftJoin(Organization, 'org', 'org.id = boiler.organization_id')
      .select('boiler.id', 'boilerId')
      .addSelect('boiler.organization_id', 'organizationId')
      .addSelect('org.object_type_id', 'objectTypeId')
      .where('boiler.id = :boilerId', { boilerId })
      .getRawOne<ScheduleTarget>();
    if (!row) throw new NotFoundException('Obyekt topilmadi');
    return row;
  }

  /**
   * JADVALLAR RO'YXATI.
   *
   * ⚠️ Viloyat darajasidan pastdagilar global va obyekt turi jadvallarini
   * (umumiy qoida) hamda FAQAT o'z vakolatidagi obyekt / muassasa
   * jadvallarini ko'radi.
   */
  async list(query: ScheduleQueryDto, user: AuthUser): Promise<ScheduleView[]> {
    const scope = await this.access.resolve(user);
    const qb = this.schedules
      .createQueryBuilder('s')
      .orderBy('s.scope_type', 'ASC')
      .addOrderBy('s.updated_at', 'DESC');

    if (query.scopeType) {
      qb.andWhere('s.scope_type = :scopeType', { scopeType: query.scopeType });
    }
    if (query.scopeId) {
      qb.andWhere('s.scope_id = :scopeId', { scopeId: query.scopeId });
    }

    if (scope.kind !== 'all') {
      qb.andWhere(
        new Brackets((inner) => {
          inner.where(`s.scope_type IN ('global', 'object_type')`);
          if (scope.kind === 'district') {
            inner
              .orWhere(
                `(s.scope_type = 'boiler' AND s.scope_id IN
                   (SELECT id FROM boilers WHERE district_id = :scopeDistrict))`,
                { scopeDistrict: scope.districtId },
              )
              .orWhere(
                `(s.scope_type = 'organization' AND s.scope_id IN
                   (SELECT id FROM organizations WHERE district_key = :scopeDistrictKey))`,
                { scopeDistrictKey: scope.districtKey },
              );
          } else if (scope.kind === 'agency') {
            inner
              .orWhere(
                `(s.scope_type = 'organization' AND s.scope_id IN
                   (SELECT id FROM organizations WHERE agency_id = :scopeAgency))`,
                { scopeAgency: scope.agencyId },
              )
              .orWhere(
                `(s.scope_type = 'boiler' AND s.scope_id IN
                   (SELECT b.id FROM boilers b JOIN organizations o ON o.id = b.organization_id
                     WHERE o.agency_id = :scopeAgency))`,
                { scopeAgency: scope.agencyId },
              );
          } else {
            inner
              .orWhere(
                `(s.scope_type = 'boiler' AND s.scope_id = ANY(:scopeBoilers))`,
                { scopeBoilers: scope.boilerIds },
              )
              .orWhere(
                `(s.scope_type = 'organization' AND s.scope_id = ANY(:scopeOrgs))`,
                { scopeOrgs: scope.organizationIds },
              );
          }
        }),
      );
    }

    const rows = await qb.getMany();
    const labels = await this.scopeLabels(rows);
    return rows.map((row) => this.toView(row, labels));
  }

  async upsert(dto: UpsertScheduleDto, actor: AuthUser): Promise<ScheduleView> {
    if (dto.scopeType === ScheduleScope.GLOBAL && dto.scopeId) {
      throw new BadRequestException(
        'Umumiy (global) jadvalga nishon berilmaydi',
      );
    }
    const scopeId =
      dto.scopeType === ScheduleScope.GLOBAL ? null : (dto.scopeId ?? null);
    if (dto.scopeType !== ScheduleScope.GLOBAL && !scopeId) {
      throw new BadRequestException('Jadval nishoni (scopeId) tanlanmagan');
    }
    if (scopeId) await this.assertScopeExists(dto.scopeType, scopeId);

    const fields = this.normalizeFields(dto);
    const existing = await this.schedules
      .createQueryBuilder('s')
      .where('s.scope_type = :scopeType', { scopeType: dto.scopeType })
      .andWhere(
        scopeId ? 's.scope_id = :scopeId' : 's.scope_id IS NULL',
        scopeId ? { scopeId } : {},
      )
      .getOne();
    const before = existing ? { ...existing } : null;

    let saved: MonitoringSchedule;
    try {
      saved = await this.schedules.save(
        existing
          ? Object.assign(existing, fields)
          : this.schedules.create({
              scopeType: dto.scopeType,
              scopeId,
              ...fields,
            }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Bu nishon uchun jadval hozirgina saqlandi — sahifani yangilab qayta urinib ko‘ring',
        );
      }
      throw error;
    }
    this.invalidate();

    const labels = await this.scopeLabels([saved]);
    const view = this.toView(saved, labels);
    await this.audit.log({
      actor,
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entityName: 'MonitoringSchedule',
      entityId: saved.id,
      summary: `Monitoring jadvali saqlandi: ${view.scopeLabel}`,
      before,
      after: view as unknown as Record<string, unknown>,
    });
    return view;
  }

  async remove(id: string, actor: AuthUser): Promise<void> {
    const row = await this.schedules.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Jadval topilmadi');
    /*
     * ⚠️ Global jadval O'CHIRILMAYDI — faqat tahrirlanadi. U o'chsa,
     * jadvali yo'q obyektlar uchun «qachon XAVF» degan savolga kodda
     * yashirin zaxira javob berardi va uni panelda hech kim ko'rmasdi.
     */
    if (row.scopeType === ScheduleScope.GLOBAL) {
      throw new BadRequestException(
        'Umumiy jadvalni o‘chirib bo‘lmaydi — uni tahrirlang',
      );
    }
    const labels = await this.scopeLabels([row]);
    await this.schedules.delete(id);
    this.invalidate();
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'MonitoringSchedule',
      entityId: id,
      summary: `Monitoring jadvali o‘chirildi: ${labels.get(id) ?? id}`,
    });
  }

  // ─────────── Bayram kunlari ───────────

  async listHolidays(year?: number): Promise<MonitoringHoliday[]> {
    const qb = this.holidays.createQueryBuilder('h').orderBy('h.day', 'ASC');
    if (year) {
      qb.where('h.day BETWEEN :from AND :to', {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      });
    }
    return qb.getMany();
  }

  async createHoliday(
    dto: CreateHolidayDto,
    actor: AuthUser,
  ): Promise<MonitoringHoliday> {
    const parsed = new Date(`${dto.day}T00:00:00Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== dto.day
    ) {
      throw new BadRequestException('Sana noto‘g‘ri');
    }
    try {
      const saved = await this.holidays.save(
        this.holidays.create({ day: dto.day, name: dto.name }),
      );
      this.invalidate();
      await this.audit.log({
        actor,
        action: AuditAction.CREATE,
        entityName: 'MonitoringHoliday',
        entityId: saved.id,
        summary: `Bayram kuni qo‘shildi: ${dto.day} — ${dto.name}`,
      });
      return saved;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Bu sana allaqachon ro‘yxatda bor');
      }
      throw error;
    }
  }

  async removeHoliday(id: string, actor: AuthUser): Promise<void> {
    const row = await this.holidays.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Bayram kuni topilmadi');
    await this.holidays.delete(id);
    this.invalidate();
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'MonitoringHoliday',
      entityId: id,
      summary: `Bayram kuni o‘chirildi: ${row.day} — ${row.name}`,
    });
  }

  // ════════════════════════ ichki ════════════════════════

  /**
   * DTO → ustunlar. `always` rejimida kun va soatlar ahamiyatsiz —
   * ular toza qiymat bilan yoziladi (eski jadvaldagi soatlar «osilib»
   * qolmasin: keyin `schedule` ga qaytarilganda kutilmagan oyna chiqardi).
   */
  private normalizeFields(dto: UpsertScheduleDto): Partial<MonitoringSchedule> {
    const base: Partial<MonitoringSchedule> = {
      mode: dto.mode,
      minRoomTemperature: dto.minRoomTemperature ?? null,
      note: dto.note ?? null,
    };

    if (dto.mode === ScheduleMode.ALWAYS) {
      return {
        ...base,
        activeDays: ALL_DAYS,
        heatingStartMin: 0,
        heatingEndMin: 0,
        monitorStartMin: 0,
        monitorEndMin: 0,
        observeHolidays: false,
      };
    }

    const minute = (value: string | undefined): number => {
      const parsed = value === undefined ? null : parseHm(value);
      if (parsed === null) {
        throw new BadRequestException(
          'Jadval rejimida isitish va monitoring vaqtlari (HH:mm) majburiy',
        );
      }
      return parsed;
    };
    if (!dto.activeDays || dto.activeDays.length === 0) {
      throw new BadRequestException(
        'Jadval rejimida kamida bitta faol hafta kuni tanlanishi shart',
      );
    }

    return {
      ...base,
      activeDays: [...dto.activeDays].sort((a, b) => a - b),
      heatingStartMin: minute(dto.heatingStart),
      heatingEndMin: minute(dto.heatingEnd),
      monitorStartMin: minute(dto.monitorStart),
      monitorEndMin: minute(dto.monitorEnd),
      observeHolidays: dto.observeHolidays ?? true,
    };
  }

  private async assertScopeExists(
    scopeType: ScheduleScope,
    scopeId: string,
  ): Promise<void> {
    const exists =
      scopeType === ScheduleScope.BOILER
        ? await this.boilers.exist({ where: { id: scopeId } })
        : scopeType === ScheduleScope.ORGANIZATION
          ? await this.organizations.exist({ where: { id: scopeId } })
          : await this.objectTypes.exist({ where: { id: scopeId } });
    if (!exists) throw new BadRequestException('Jadval nishoni topilmadi');
  }

  /** Nishon yorlig'i: «Umumiy», «Obyekt turi: Maktab», muassasa / lot nomi. */
  private async scopeLabels(
    rows: MonitoringSchedule[],
  ): Promise<Map<string, string>> {
    const ids = (type: ScheduleScope) =>
      rows
        .filter((row) => row.scopeType === type && row.scopeId)
        .map((row) => row.scopeId as string);

    const boilerIds = ids(ScheduleScope.BOILER);
    const organizationIds = ids(ScheduleScope.ORGANIZATION);
    const typeIds = ids(ScheduleScope.OBJECT_TYPE);

    const [boilers, organizations, types] = await Promise.all([
      boilerIds.length
        ? this.boilers
            .createQueryBuilder('b')
            .leftJoin(Organization, 'o', 'o.id = b.organization_id')
            .select('b.id', 'id')
            .addSelect('b.lot_number', 'lot')
            .addSelect('o.name', 'org')
            .where('b.id IN (:...boilerIds)', { boilerIds })
            .getRawMany<{
              id: string;
              lot: string | null;
              org: string | null;
            }>()
        : Promise.resolve([]),
      organizationIds.length
        ? this.organizations.find({
            where: organizationIds.map((id) => ({ id })),
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      typeIds.length
        ? this.objectTypes.find({
            where: typeIds.map((id) => ({ id })),
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const names = new Map<string, string>();
    for (const row of boilers) {
      names.set(
        row.id,
        `Obyekt: ${row.org ? `${row.org}, ` : ''}${lotRef(row.lot)}`,
      );
    }
    for (const row of organizations) names.set(row.id, `Muassasa: ${row.name}`);
    for (const row of types) names.set(row.id, `Obyekt turi: ${row.name}`);

    const labels = new Map<string, string>();
    for (const row of rows) {
      labels.set(
        row.id,
        row.scopeType === ScheduleScope.GLOBAL
          ? 'Umumiy (barcha obyektlar)'
          : (names.get(row.scopeId as string) ?? 'O‘chirilgan nishon'),
      );
    }
    return labels;
  }

  private toView(
    row: MonitoringSchedule,
    labels: Map<string, string>,
  ): ScheduleView {
    return {
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      scopeLabel: labels.get(row.id) ?? '—',
      mode: row.mode,
      activeDays: row.activeDays,
      heatingStart: formatHm(row.heatingStartMin),
      heatingEnd: formatHm(row.heatingEndMin),
      monitorStart: formatHm(row.monitorStartMin),
      monitorEnd: formatHm(row.monitorEndMin),
      minRoomTemperature: row.minRoomTemperature,
      observeHolidays: row.observeHolidays,
      note: row.note,
      updatedAt: row.updatedAt,
    };
  }
}
