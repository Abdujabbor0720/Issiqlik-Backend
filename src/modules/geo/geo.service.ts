import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BoilerStatus, UserRole } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import { District } from '../../database/entities/district.entity';
import { DistrictDirectoryService } from './district-directory.service';
import { Region } from '../../database/entities/region.entity';
import { applyDistrictScope, isNarrowRole } from '../../helpers/scope.helper';
import { SettingsService } from '../settings/settings.service';
import type {
  BoilerPoint,
  DistrictGeoJson,
  DistrictStats,
} from './dto/geo.dto';

/** Agregat so'rovidan keladigan xom qator (hammasi satr bo'lib keladi). */
interface StatRow {
  districtId: string;
  total: string;
  boilerUnits: string | null;
  active: string;
  medium: string;
  inactive: string;
  offline: string;
  avgTemperature: string | null;
}

@Injectable()
export class GeoService {
  constructor(
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly settings: SettingsService,
    private readonly directory: DistrictDirectoryService,
  ) {}

  async regionList(): Promise<Region[]> {
    return this.regions.find({ order: { name: 'ASC' } });
  }

  /** Tumanlar ro'yxati — geometriyasiz (filtr va tanlov uchun). */
  async districtList(
    user?: AuthUser,
  ): Promise<
    Array<Pick<District, 'id' | 'key' | 'code' | 'name' | 'shortName' | 'kind'>>
  > {
    const qb = this.districts
      .createQueryBuilder('district')
      .select([
        'district.id AS id',
        'district.key AS key',
        'district.code AS code',
        'district.name AS name',
        'district.short_name AS "shortName"',
        'district.kind AS kind',
      ])
      .orderBy('district.name', 'ASC');

    /*
     * ⚠️ Tashkilot mas'uli va obyekt javobgari uchun — HAMMA tuman nomlari:
     * bu ochiq ma'lumot (16 ta nom) va XAVF panelidagi «tuman bo'yicha
     * filtr» uchun kerak (boshqarma bir nechta tumanni qamraydi). Tuman
     * kesimi ular uchun YOPIQ ishlaydi (`scope.helper.ts`) va bu yerda
     * 403 qaytsa, panel filtrsiz qolardi.
     */
    if (!isNarrowRole(user)) applyDistrictScope(qb, user, 'district.id');
    return qb.getRawMany();
  }

  /**
   * XARITA UCHUN GeoJSON — chegaralar + har tumanning raqamlari.
   *
   * ⚠️⚠️ Geometriya va statistika BITTA javobda qaytadi. Ajratilsa,
   * frontend ikkita so'rov yuborib, natijani ID bo'yicha qo'lda
   * birlashtirardi: bitta tuman statistikaga tushmay qolsa, xaritada
   * «0 kotyol» bo'lib ko'rinardi va xato manbai topilmasdi.
   *
   * ⚠️ Statistika AGREGAT so'rov bilan, tumanlar bo'ylab sikl bilan
   * EMAS: 16 tuman uchun 16 ta so'rov — bu «N+1» va u sahifa ochilish
   * vaqtini o'n baravarga uzaytirardi.
   */
  async mapGeoJson(
    districtIds: string[] | undefined,
    user?: AuthUser,
  ): Promise<DistrictGeoJson> {
    const region = await this.regions.findOne({ where: { code: 'andijon' } });

    const districtQb = this.districts
      .createQueryBuilder('district')
      .orderBy('district.name', 'ASC');

    applyDistrictScope(districtQb, user, 'district.id');
    if (districtIds?.length) {
      districtQb.andWhere('district.id IN (:...districtIds)', { districtIds });
    }
    const districts = await districtQb.getMany();

    const statsMap = await this.statsByDistrict(user);

    const features = districts.map((district) => {
      const stats = this.buildStats(district, statsMap.get(district.id));
      return {
        type: 'Feature' as const,
        properties: stats,
        geometry: district.geometry,
      };
    });

    return {
      type: 'FeatureCollection',
      /*
       * ⚠️ Chegaralovchi to'rtburchak TANLOVGA qarab emas, VILOYATNIKI.
       * Tanlangan tumanga moslansa, filtr har o'zgarganda xarita
       * sakrab-sakrab kattalashardi va foydalanuvchi mo'ljalni
       * yo'qotardi. Tanlov rangni va raqamni o'zgartiradi, MASSHTABNI emas.
       */
      bbox: region?.bbox ?? null,
      features,
    };
  }

  /** Bitta tuman — kesim sahifasi uchun. */
  async districtDetail(
    id: string,
    user?: AuthUser,
  ): Promise<{ district: District; stats: DistrictStats }> {
    const district = await this.districts.findOne({ where: { id } });
    if (!district) throw new NotFoundException('Tuman topilmadi');

    if (
      user?.districtId &&
      user.role === UserRole.OPERATOR &&
      user.districtId !== id
    ) {
      throw new NotFoundException('Tuman topilmadi');
    }

    const statsMap = await this.statsByDistrict(user, [id]);
    return { district, stats: this.buildStats(district, statsMap.get(id)) };
  }

  /**
   * XARITADAGI NUQTALAR — koordinatasi bor kotyollar.
   *
   * ⚠️ Koordinatasi YO'Q kotyol bu ro'yxatga tushmaydi, lekin tuman
   * SANOG'IDA baribir bor. Aks holda «16 ta kotyol bor-u, xaritada
   * 9 tasi» degan farq paydo bo'lardi va uni hech kim tushuntira olmasdi.
   * Farq soni kesim sahifasida alohida ko'rsatiladi.
   */
  async boilerPoints(
    districtIds: string[] | undefined,
    user?: AuthUser,
  ): Promise<BoilerPoint[]> {
    const settings = await this.settings.get();
    const roomFreshAfter = new Date(
      Date.now() - settings.offlineAfterMinutes * 60_000,
    );

    const qb = this.boilers
      .createQueryBuilder('boiler')
      .innerJoin('boiler.district', 'district')
      .leftJoin('boiler.organization', 'organization')
      .select([
        'boiler.id AS id',
        'boiler.lot_number AS "lotNumber"',
        'organization.name AS "organizationName"',
        'boiler.district_id AS "districtId"',
        'district.name AS "districtName"',
        'boiler.lat AS lat',
        'boiler.lng AS lng',
        'boiler.current_status AS status',
        'boiler.last_temperature AS temperature',
        'boiler.boiler_count AS "boilerCount"',
        'boiler.last_reading_at AS "lastReadingAt"',
      ])
      /*
       * ⚠️⚠️ XONALAR — BITTA bog'liq quyi so'rov, alohida so'rov EMAS.
       * Xaritada 2000 nuqta bor; har biri uchun xonalarni alohida
       * so'rash 2000 ta qo'shimcha so'rov bo'lardi. Bu yerda esa har
       * kotyol uchun `UQ_rooms_boiler_sensor` indeksining boshidan
       * ~10 qator o'qiladi.
       *
       * ⚠️ Faqat NAZORATDAGI va DOLZARB o'lchovlar: eskirgan xona
       * nuqtani yolg'on «iliq» qilib ko'rsatmasligi kerak.
       */
      .addSelect(
        `(SELECT json_build_object(
            'count', COUNT(*),
            'avg', ROUND(AVG(r.last_temperature)::numeric, 1),
            'min', MIN(r.last_temperature),
            'cold', COUNT(*) FILTER (WHERE r.last_temperature < :roomMinC))
          FROM rooms r
          WHERE r.boiler_id = boiler.id
            AND r.is_monitored = true
            AND r.last_temperature IS NOT NULL
            AND r.last_reading_at >= :roomFreshAfter)`,
        'roomStats',
      )
      .setParameters({ roomMinC: settings.roomMinC, roomFreshAfter })
      .where('boiler.is_archived = false')
      .andWhere('boiler.lat IS NOT NULL')
      .andWhere('boiler.lng IS NOT NULL');

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', { districtIds });
    }

    const rows = await qb.getRawMany<Record<string, unknown>>();
    return rows.map((row) => ({
      id: String(row.id),
      lotNumber: (row.lotNumber as string | null) ?? null,
      organizationName: (row.organizationName as string) ?? null,
      districtId: String(row.districtId),
      districtName: String(row.districtName),
      lat: Number(row.lat),
      lng: Number(row.lng),
      status: String(row.status),
      temperature:
        row.temperature === null || row.temperature === undefined
          ? null
          : Number(row.temperature),
      boilerCount: Number(row.boilerCount ?? 1),
      lastReadingAt: row.lastReadingAt
        ? new Date(row.lastReadingAt as string).toISOString()
        : null,
      rooms: toRoomStats(row.roomStats),
    }));
  }

  // ───────────────── ichki ─────────────────

  /**
   * Tumanlar bo'yicha agregat — BITTA so'rov.
   *
   * ⚠️ `FILTER (WHERE ...)` ishlatiladi, `CASE WHEN` emas: PostgreSQL da
   * ikkalasi ham ishlaydi, lekin `FILTER` niyatni ochiq ko'rsatadi va
   * «shu holatdagi qatorlarni sana» degan jumla SQL da aynan shunday
   * o'qiladi.
   */
  private async statsByDistrict(
    user?: AuthUser,
    onlyIds?: string[],
  ): Promise<Map<string, StatRow>> {
    const qb = this.boilers
      .createQueryBuilder('boiler')
      .select('boiler.district_id', 'districtId')
      .addSelect('COUNT(*)', 'total')
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
      /*
       * ⚠️ O'rtacha harorat FAQAT o'lchovi bor kotyollardan. `COALESCE`
       * bilan nolga aylantirilsa, aloqasi yo'q o'nta kotyol butun
       * tumanning o'rtachasini 0 ga tortib tushirardi — ekranda esa
       * «tuman sovuq» bo'lib ko'rinardi.
       */
      .addSelect('AVG(boiler.last_temperature)', 'avgTemperature')
      .where('boiler.is_archived = false')
      .groupBy('boiler.district_id');

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (onlyIds?.length) {
      qb.andWhere('boiler.district_id IN (:...onlyIds)', { onlyIds });
    }

    const rows = await qb.getRawMany<StatRow>();
    return new Map(rows.map((row) => [row.districtId, row]));
  }

  private buildStats(district: District, row?: StatRow): DistrictStats {
    const total = Number(row?.total ?? 0);
    const active = Number(row?.active ?? 0);
    const medium = Number(row?.medium ?? 0);
    const inactive = Number(row?.inactive ?? 0);
    const offline = Number(row?.offline ?? 0);
    const working = active + medium;

    return {
      districtId: district.id,
      key: district.key,
      code: district.code,
      name: district.name,
      shortName: district.shortName,
      kind: district.kind,
      centerLat: district.centerLat,
      centerLng: district.centerLng,
      total,
      boilerUnits: Number(row?.boilerUnits ?? 0),
      active,
      medium,
      inactive,
      offline,
      workingPercent: total > 0 ? Math.round((working / total) * 100) : 0,
      avgTemperature:
        row?.avgTemperature === null || row?.avgTemperature === undefined
          ? null
          : Math.round(Number(row.avgTemperature) * 10) / 10,
      dominantStatus: this.dominantStatus({
        active,
        medium,
        inactive,
        offline,
      }),
    };
  }

  /**
   * USTUN HOLAT — xaritadagi belgi rangi.
   *
   * ⚠️ «Eng ko'p uchragani» EMAS, «eng YOMONI muhim» qoidasi: tumandagi
   * 20 ta kotyoldan 11 tasi faol, 9 tasi o'chiq bo'lsa, belgi yashil
   * bo'lsa rahbar muammoni umuman ko'rmasdi. Shuning uchun ishlamayotgan
   * ulushi sezilarli bo'lsa (≥ 25%), belgi o'shani ko'rsatadi.
   */
  private dominantStatus(counts: {
    active: number;
    medium: number;
    inactive: number;
    offline: number;
  }): string {
    const total =
      counts.active + counts.medium + counts.inactive + counts.offline;
    if (total === 0) return BoilerStatus.OFFLINE;

    const broken = counts.inactive + counts.offline;
    if (broken / total >= 0.25) {
      return counts.offline >= counts.inactive
        ? BoilerStatus.OFFLINE
        : BoilerStatus.INACTIVE;
    }
    if (counts.medium / total >= 0.35) return BoilerStatus.MEDIUM;
    return BoilerStatus.ACTIVE;
  }

  /**
   * YANGI TUMAN QO'SHISH (ma'muriy islohot) — faqat bosh administrator.
   *
   * ⚠️⚠️ KALIT PROSHIVKADA QOTIRILGAN: qurilma sozlash sahifasida faqat
   * proshivkadagi kalitlar bor. Yangi tuman qo'shilsa, proshivka menyusiga
   * ham AYNI kalit qo'shilishi kerak — aks holda qurilma uni yubora olmaydi
   * (panelda esa qo'lda tanlanadi). Kalit keyin O'ZGARTIRILMAYDI.
   *
   * ⚠️ Geometriyasiz yaratiladi: xaritada markaz nuqtasi bilan ko'rinadi,
   * chegara keyin `andijon-districts.geojson` orqali qo'shiladi.
   */
  async createDistrict(input: {
    key: string;
    name: string;
    shortName?: string;
    kind: 'city' | 'district';
    soato?: string;
    centerLat: number;
    centerLng: number;
  }): Promise<District> {
    const region = await this.regions.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });
    if (!region) throw new BadRequestException('Viloyat yozuvi topilmadi');
    const clash = await this.districts.findOne({
      where: [{ key: input.key }, { name: input.name }],
      select: { id: true, key: true, name: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.key === input.key
          ? `«${input.key}» kalitli tuman allaqachon bor`
          : `«${input.name}» nomli tuman allaqachon bor`,
      );
    }
    const saved = await this.districts.save(
      this.districts.create({
        key: input.key,
        code: input.key.replace(/-/g, '_'),
        name: input.name,
        shortName:
          input.shortName ?? input.name.replace(/\s+(tumani|shahri)$/i, ''),
        kind: input.kind,
        soato: input.soato ?? null,
        regionId: region.id,
        centerLat: input.centerLat,
        centerLng: input.centerLng,
        geometry: null,
      }),
    );
    this.directory.invalidate();
    return saved;
  }
}

/**
 * Xona statistikasini o'qish — `json_build_object` natijasi.
 *
 * ⚠️ `pg` drayveri `json` ni obyektga aylantiradi, lekin `numeric`
 * qiymatlar SATR bo'lib keladi (`"21.4"`). Xona yo'q yoki o'lchovi
 * eskirgan bo'lsa — `null` (xaritada «xona ma'lumoti yo'q»).
 */
function toRoomStats(raw: unknown): BoilerPoint['rooms'] {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const count = Number(value.count ?? 0);
  if (!count) return null;
  const num = (input: unknown): number | null =>
    input === null || input === undefined ? null : Number(input);
  return {
    count,
    avg: num(value.avg),
    min: num(value.min),
    cold: Number(value.cold ?? 0),
  };
}
