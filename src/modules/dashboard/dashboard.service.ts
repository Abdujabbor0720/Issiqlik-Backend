import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AlertState,
  BoilerStatus,
  UserRole,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Alert } from '../../database/entities/alert.entity';
import { Boiler } from '../../database/entities/boiler.entity';
import { Device } from '../../database/entities/device.entity';
import { District } from '../../database/entities/district.entity';
import { TelemetryReading } from '../../database/entities/telemetry-reading.entity';
import { applyDistrictScope } from '../../helpers/scope.helper';
import { SettingsService } from '../settings/settings.service';
import type {
  DashboardQueryDto,
  DashboardSummary,
  DistrictRow,
  GaugeBoard,
  GaugeItem,
  TrendPoint,
  TrendQueryDto,
} from './dto/dashboard.dto';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    @InjectRepository(TelemetryReading)
    private readonly readings: Repository<TelemetryReading>,
    private readonly settings: SettingsService,
  ) {}

  /**
   * ASOSIY KARTALAR.
   *
   * ⚠️⚠️ Hammasi BITTA agregat so'rovda (`FILTER (WHERE ...)`).
   * Har karta uchun alohida `COUNT` yozilsa, bu olti marta butun
   * jadvalni skanerlash bo'lardi — va eng yomoni, ular BIR LAHZADA
   * emas, ketma-ket bajarilardi: telemetriya oqimi ostida
   * «faol + o'rta + ishlamayotgan» yig'indisi «jami» ga teng
   * bo'lmasligi mumkin edi. Rahbar ekranda 196 = 17 + 145 + 35
   * degan qo'shishni qiladi va u to'g'ri chiqishi SHART.
   */
  async summary(
    query: DashboardQueryDto,
    user?: AuthUser,
  ): Promise<DashboardSummary> {
    const settings = await this.settings.get();
    const offlineBefore = new Date(
      Date.now() - settings.offlineAfterMinutes * 60_000,
    );

    const qb = this.boilers
      .createQueryBuilder('boiler')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(SUM(boiler.boiler_count), 0)', 'boilerUnits')
      .addSelect(
        `COUNT(*) FILTER (WHERE boiler.current_status = '${BoilerStatus.ACTIVE}')`,
        'active',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE boiler.current_status = '${BoilerStatus.MEDIUM}')`,
        'medium',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE boiler.current_status = '${BoilerStatus.INACTIVE}')`,
        'inactive',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE boiler.current_status = '${BoilerStatus.OFFLINE}')`,
        'offline',
      )
      .addSelect('AVG(boiler.last_temperature)', 'avgTemperature')
      .addSelect(
        'COUNT(*) FILTER (WHERE boiler.lat IS NULL OR boiler.lng IS NULL)',
        'withoutCoordinates',
      )
      .addSelect(
        // ⚠️ Faqat QOZONXONA moduli hisoblanadi — xona moduli kotyol haroratini bermaydi.
        "COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.boiler_id = boiler.id AND d.module_type = 'boiler'))",
        'withoutDevice',
      )
      .where('boiler.is_archived = false');

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }

    const row = await qb.getRawOne<Record<string, string | null>>();

    const total = Number(row?.total ?? 0);
    const active = Number(row?.active ?? 0);
    const medium = Number(row?.medium ?? 0);
    const inactive = Number(row?.inactive ?? 0);
    const offline = Number(row?.offline ?? 0);
    const working = active + medium;

    const [openAlerts, devicesTotal, devicesOnline, readingsLast24h] =
      await Promise.all([
        this.countOpenAlerts(query, user),
        this.devices.count(),
        this.devices
          .createQueryBuilder('device')
          .where('device.last_seen_at >= :offlineBefore', { offlineBefore })
          .getCount(),
        this.readings
          .createQueryBuilder('reading')
          .where('reading.recorded_at >= :from', {
            from: new Date(Date.now() - 24 * 60 * 60 * 1000),
          })
          .getCount(),
      ]);

    const percent = (value: number): number =>
      total > 0 ? Math.round((value / total) * 1000) / 10 : 0;

    return {
      total,
      boilerUnits: Number(row?.boilerUnits ?? 0),
      working,
      workingPercent: percent(working),
      active,
      activePercent: percent(active),
      medium,
      mediumPercent: percent(medium),
      inactive,
      inactivePercent: percent(inactive),
      offline,
      offlinePercent: percent(offline),
      avgTemperature:
        row?.avgTemperature === null || row?.avgTemperature === undefined
          ? null
          : Math.round(Number(row.avgTemperature) * 10) / 10,
      normTemperature: settings.normTemperature,
      openAlerts,
      devicesTotal,
      devicesOnline,
      readingsLast24h,
      withoutCoordinates: Number(row?.withoutCoordinates ?? 0),
      withoutDevice: Number(row?.withoutDevice ?? 0),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * MUASSASALAR SHKALASI — har kotyolning kirish/chiqish harorati.
   *
   * ⚠️ BITTA so'rov, sahifalashsiz: ekran tur bo'yicha tablarni (Maktab,
   * Bog'cha…) va o'rtacha qiymatlarni MIJOZDA hisoblaydi — tab almashganda
   * qayta so'rov yo'q, sanoq va kartalar bir lahzadagi ma'lumotdan.
   * Viloyatda bir necha yuz kotyol — bu bir necha o'n kilobayt.
   *
   * ⚠️ Oldingi o'lchov — kotyolning chiqish harorati bor IKKINCHI eng
   * so'nggi telemetriyasi (`OFFSET 1`); kirish ham, chiqish ham AYNAN SHU
   * qatordan. Bu joriy qiymat bilan bir xil qoida: telemetriya har
   * o'lchovda chiqishni yozadi, kirish kelmasa esa `last_inlet_temperature`
   * ga `null` yozadi (eskisi saqlanmaydi) — ya'ni joriy qiymatlar doim eng
   * so'nggi qatorniki. Oldingi qatorda kirish bo'lmasa — o'zgarish `null`
   * («noma'lum»), uzilishdan oldingi eski qiymat bilan solishtirilmaydi.
   * `IDX_telemetry_boiler_time` bo'yicha har kotyolga ikki indeks yozuvi.
   *
   * ⚠️ Chiqish — `last_outlet_temperature`, bo'lmasa `last_temperature`:
   * eski proshivka faqat bitta (chiqish) haroratini yuboradi.
   */
  async gauges(query: DashboardQueryDto, user?: AuthUser): Promise<GaugeBoard> {
    const settings = await this.settings.get();
    // ⚠️ `column` — faqat shu fayldagi doimiy ifodalar (foydalanuvchi matni emas).
    const previous = (column: string): string =>
      `(SELECT ${column} FROM telemetry_readings r
         WHERE r.boiler_id = boiler.id
           AND COALESCE(r.outlet_temperature, r.temperature) IS NOT NULL
         ORDER BY r.recorded_at DESC OFFSET 1 LIMIT 1)`;

    const qb = this.boilers
      .createQueryBuilder('boiler')
      .innerJoin('boiler.district', 'district')
      .leftJoin('boiler.organization', 'organization')
      .leftJoin('organization.objectType', 'objectType')
      .select('boiler.id', 'boilerId')
      .addSelect('boiler.lot_number', 'lotNumber')
      .addSelect('organization.name', 'organizationName')
      .addSelect('objectType.id', 'objectTypeId')
      .addSelect('objectType.name', 'objectTypeName')
      .addSelect('objectType.code', 'objectTypeCode')
      .addSelect('boiler.district_id', 'districtId')
      .addSelect('district.name', 'districtName')
      .addSelect('district.short_name', 'districtShortName')
      .addSelect('boiler.current_status', 'status')
      .addSelect('boiler.last_inlet_temperature', 'inlet')
      .addSelect(
        'COALESCE(boiler.last_outlet_temperature, boiler.last_temperature)',
        'outlet',
      )
      .addSelect(previous('r.inlet_temperature'), 'prevInlet')
      .addSelect(
        previous('COALESCE(r.outlet_temperature, r.temperature)'),
        'prevOutlet',
      )
      .addSelect('boiler.last_reading_at', 'lastReadingAt')
      .addSelect(
        "EXISTS (SELECT 1 FROM devices d WHERE d.boiler_id = boiler.id AND d.module_type = 'boiler')",
        'hasDevice',
      )
      .where('boiler.is_archived = false');

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }

    const rows = await qb.getRawMany<Record<string, unknown>>();
    const num = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);
    const delta = (now: number | null, before: number | null): number | null =>
      now === null || before === null
        ? null
        : Math.round((now - before) * 10) / 10;

    const items: GaugeItem[] = rows.map((row) => {
      const inlet = num(row.inlet);
      const outlet = num(row.outlet);
      const lastReadingAt = row.lastReadingAt as Date | string | null;
      return {
        boilerId: String(row.boilerId),
        lotNumber: (row.lotNumber as string | null) ?? null,
        organizationName: (row.organizationName as string | null) ?? null,
        objectTypeId: (row.objectTypeId as string | null) ?? null,
        objectTypeName: (row.objectTypeName as string | null) ?? null,
        objectTypeCode: (row.objectTypeCode as string | null) ?? null,
        districtId: String(row.districtId),
        districtName: String(row.districtName),
        districtShortName: String(row.districtShortName),
        status: String(row.status),
        inlet,
        outlet,
        inletDelta: delta(inlet, num(row.prevInlet)),
        outletDelta: delta(outlet, num(row.prevOutlet)),
        lastReadingAt: lastReadingAt
          ? new Date(lastReadingAt).toISOString()
          : null,
        hasDevice: row.hasDevice === true || row.hasDevice === 't',
      };
    });

    return {
      normTemperature: settings.normTemperature,
      items,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * TUMANLAR KESIMI — progress-bar ro'yxati uchun.
   *
   * ⚠️ `LEFT JOIN` tumanlardan boshlanadi: kotyoli YO'Q tuman ham
   * ro'yxatda qolishi kerak. Kotyollardan boshlansa, bo'sh tuman
   * jimgina yo'qolardi va «nega 16 ta emas, 14 ta tuman?» degan
   * savolga javob bo'lmasdi.
   */
  async districtRows(
    query: DashboardQueryDto,
    user?: AuthUser,
  ): Promise<DistrictRow[]> {
    const qb = this.districts
      .createQueryBuilder('district')
      .leftJoin(
        'boilers',
        'boiler',
        'boiler.district_id = district.id AND boiler.is_archived = false',
      )
      .select('district.id', 'districtId')
      .addSelect('district.name', 'name')
      .addSelect('district.short_name', 'shortName')
      .addSelect('COUNT(boiler.id)', 'total')
      .addSelect('COALESCE(SUM(boiler.boiler_count), 0)', 'boilerUnits')
      .addSelect(
        `COUNT(boiler.id) FILTER (WHERE boiler.current_status = '${BoilerStatus.ACTIVE}')`,
        'active',
      )
      .addSelect(
        `COUNT(boiler.id) FILTER (WHERE boiler.current_status = '${BoilerStatus.MEDIUM}')`,
        'medium',
      )
      .addSelect(
        `COUNT(boiler.id) FILTER (WHERE boiler.current_status = '${BoilerStatus.INACTIVE}')`,
        'inactive',
      )
      .addSelect(
        `COUNT(boiler.id) FILTER (WHERE boiler.current_status = '${BoilerStatus.OFFLINE}')`,
        'offline',
      )
      .addSelect('AVG(boiler.last_temperature)', 'avgTemperature')
      .groupBy('district.id')
      .addGroupBy('district.name')
      .addGroupBy('district.short_name')
      .orderBy('district.name', 'ASC');

    applyDistrictScope(qb, user, 'district.id');
    if (query.districtIds?.length) {
      qb.andWhere('district.id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }

    const rows = await qb.getRawMany<Record<string, string>>();

    return rows.map((raw) => {
      const total = Number(raw.total ?? 0);
      const active = Number(raw.active ?? 0);
      const medium = Number(raw.medium ?? 0);
      return {
        districtId: raw.districtId,
        name: raw.name,
        shortName: raw.shortName,
        total,
        boilerUnits: Number(raw.boilerUnits ?? 0),
        active,
        medium,
        inactive: Number(raw.inactive ?? 0),
        offline: Number(raw.offline ?? 0),
        workingPercent:
          total > 0 ? Math.round(((active + medium) / total) * 100) : 0,
        avgTemperature:
          raw.avgTemperature === null || raw.avgTemperature === undefined
            ? null
            : Math.round(Number(raw.avgTemperature) * 10) / 10,
      };
    });
  }

  /**
   * HARORAT TRENDI — grafik uchun.
   *
   * ⚠️ Holatlar bo'yicha taqsimot ham SHU yerda hisoblanadi: o'sha
   * paytdagi holat telemetriya qatoriga MUHRLANGAN (`status` ustuni),
   * shuning uchun chegara keyin o'zgarsa ham tarix qayta yozilmaydi.
   * Holatni hozirgi chegara bilan qayta hisoblash «o'tgan haftada 40 ta
   * faol edi» degan hisobotni bir kecha ichida boshqa raqamga
   * aylantirardi.
   */
  async trend(query: TrendQueryDto, user?: AuthUser): Promise<TrendPoint[]> {
    const spans: Record<string, { ms: number; unit: 'hour' | 'day' }> = {
      '24h': { ms: 24 * 60 * 60 * 1000, unit: 'hour' },
      '7d': { ms: 7 * 24 * 60 * 60 * 1000, unit: 'hour' },
      '30d': { ms: 30 * 24 * 60 * 60 * 1000, unit: 'day' },
    };
    const span = spans[query.range] ?? spans['24h'];
    const from = new Date(Date.now() - span.ms);

    const qb = this.readings
      .createQueryBuilder('reading')
      .select(`date_trunc('${span.unit}', reading.recorded_at)`, 't')
      .addSelect('AVG(reading.temperature)', 'avg')
      .addSelect('MIN(reading.temperature)', 'min')
      .addSelect('MAX(reading.temperature)', 'max')
      .addSelect(
        `COUNT(*) FILTER (WHERE reading.status = '${BoilerStatus.ACTIVE}')`,
        'active',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE reading.status = '${BoilerStatus.MEDIUM}')`,
        'medium',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE reading.status = '${BoilerStatus.INACTIVE}')`,
        'inactive',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE reading.status = '${BoilerStatus.OFFLINE}')`,
        'offline',
      )
      .where('reading.recorded_at >= :from', { from })
      .groupBy('1')
      .orderBy('1', 'ASC');

    const needsJoin =
      Boolean(query.districtIds?.length) || user?.role === UserRole.OPERATOR;
    if (needsJoin) {
      qb.innerJoin('boilers', 'b', 'b.id = reading.boiler_id');
      if (query.districtIds?.length) {
        qb.andWhere('b.district_id IN (:...districtIds)', {
          districtIds: query.districtIds,
        });
      }
      applyDistrictScope(qb, user, 'b.district_id');
    }

    const rows = await qb.getRawMany<Record<string, string>>();
    const num = (value: string | null): number | null =>
      value === null || value === undefined
        ? null
        : Math.round(Number(value) * 10) / 10;

    return rows.map((raw) => ({
      t: new Date(raw.t).toISOString(),
      avg: num(raw.avg),
      min: num(raw.min),
      max: num(raw.max),
      active: Number(raw.active ?? 0),
      medium: Number(raw.medium ?? 0),
      inactive: Number(raw.inactive ?? 0),
      offline: Number(raw.offline ?? 0),
    }));
  }

  /**
   * DIQQAT TALAB QILADIGANLAR — ekranning o'ng ustuni.
   *
   * ⚠️ Eng sovuqlar EMAS, eng UZOQ muammoda turganlar. Harorat
   * bo'yicha saralansa, ro'yxat tepasida har doim bitta nosoz datchik
   * (−127 °C) turib qolardi; «6 soatdan beri sovuq maktab» esa pastga
   * tushib ketardi.
   */
  async attention(
    query: DashboardQueryDto,
    user?: AuthUser,
    limit = 8,
  ): Promise<Array<Record<string, unknown>>> {
    const qb = this.boilers
      .createQueryBuilder('boiler')
      .leftJoin('boiler.district', 'district')
      .leftJoin('boiler.organization', 'organization')
      .select([
        'boiler.id AS id',
        'boiler.lot_number AS "lotNumber"',
        'boiler.current_status AS status',
        'boiler.last_temperature AS temperature',
        'boiler.last_reading_at AS "lastReadingAt"',
        'boiler.status_changed_at AS "statusChangedAt"',
        'boiler.boiler_count AS "boilerCount"',
        'boiler.address AS address',
        'district.id AS "districtId"',
        'district.short_name AS "districtName"',
        'organization.name AS "organizationName"',
      ])
      .where('boiler.is_archived = false')
      .andWhere('boiler.current_status IN (:...bad)', {
        bad: [BoilerStatus.OFFLINE, BoilerStatus.INACTIVE, BoilerStatus.MEDIUM],
      })
      /*
       * ⚠️ `DESC` — POSTGRESQL ENUM TARTIBI. `boilers_current_status_enum`
       * migratsiyada `('active','medium','inactive','offline')` tartibida
       * e'lon qilingan, ya'ni `DESC` eng yomonini (offline) birinchi
       * qo'yadi. Xom `CASE ... END` ifodasi ATAYLAB ishlatilmaydi:
       * TypeORM uni ba'zi so'rov shakllarida alias deb o'qib yiqiladi
       * (`alerts.service.ts` dagi izohga qarang).
       */
      .orderBy('boiler.current_status', 'DESC')
      .addOrderBy('boiler.statusChangedAt', 'ASC', 'NULLS FIRST')
      .limit(limit);

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }

    const rows = await qb.getRawMany<Record<string, unknown>>();
    return rows.map((raw) => ({
      ...raw,
      temperature:
        raw.temperature === null || raw.temperature === undefined
          ? null
          : Number(raw.temperature),
    }));
  }

  /** Marka kesimi — «qaysi marka ko'p ishlamayapti». */
  async byBrand(
    query: DashboardQueryDto,
    user?: AuthUser,
  ): Promise<Array<Record<string, unknown>>> {
    const qb = this.boilers
      .createQueryBuilder('boiler')
      .leftJoin('boiler.brand', 'brand')
      .select('COALESCE(brand.name, :unknown)', 'name')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE boiler.current_status IN ('${BoilerStatus.ACTIVE}','${BoilerStatus.MEDIUM}'))`,
        'working',
      )
      .addSelect('AVG(boiler.last_temperature)', 'avgTemperature')
      .where('boiler.is_archived = false')
      .setParameter('unknown', 'Marka ko‘rsatilmagan')
      .groupBy('1')
      .orderBy('2', 'DESC')
      .limit(10);

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }

    const rows = await qb.getRawMany<Record<string, string>>();
    return rows.map((raw) => {
      const total = Number(raw.total ?? 0);
      const working = Number(raw.working ?? 0);
      return {
        name: raw.name,
        total,
        working,
        workingPercent: total > 0 ? Math.round((working / total) * 100) : 0,
        avgTemperature:
          raw.avgTemperature === null || raw.avgTemperature === undefined
            ? null
            : Math.round(Number(raw.avgTemperature) * 10) / 10,
      };
    });
  }

  private async countOpenAlerts(
    query: DashboardQueryDto,
    user?: AuthUser,
  ): Promise<number> {
    const qb = this.alerts
      .createQueryBuilder('alert')
      .innerJoin('alert.boiler', 'boiler')
      .where('alert.state = :state', { state: AlertState.OPEN });

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }
    return qb.getCount();
  }
}
