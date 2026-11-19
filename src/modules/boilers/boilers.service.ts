import { lotRef } from '../../helpers/boiler-label.helper';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, BoilerStatus } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { District } from '../../database/entities/district.entity';
import {
  applyDistrictScope,
  assertDistrictAccess,
} from '../../helpers/scope.helper';
import { AuditService } from '../audit/audit.service';
import type {
  BoilerQueryDto,
  CreateBoilerDto,
  UpdateBoilerDto,
} from './dto/boiler.dto';

/**
 * ⚠️ SARALASH FAQAT OQ RO'YXATDAN.
 *
 * `sortBy` query'dan keladi va to'g'ridan-to'g'ri `orderBy` ga berilsa,
 * bu SQL in'ektsiya (TypeORM `orderBy` argumentini parametrlashtirmaydi).
 * Shu bilan birga ro'yxat UI dagi ustunlar bilan mos bo'lishi kerak —
 * ikkalasini ham shu yagona jadval hal qiladi.
 */
const SORTABLE: Record<string, string> = {
  lotNumber: 'boiler.lotNumber',
  createdAt: 'boiler.createdAt',
  boilerCount: 'boiler.boilerCount',
  normAt60: 'boiler.normAt60',
  lastTemperature: 'boiler.lastTemperature',
  lastReadingAt: 'boiler.lastReadingAt',
  currentStatus: 'boiler.currentStatus',
  district: 'district.name',
};

@Injectable()
export class BoilersService {
  constructor(
    @InjectRepository(Boiler) private readonly repo: Repository<Boiler>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: BoilerQueryDto,
    user?: AuthUser,
  ): Promise<PaginatedResult<Boiler>> {
    const qb = this.baseQuery(user);

    if (!query.includeArchived) {
      qb.andWhere('boiler.is_archived = false');
    }
    if (query.search) {
      qb.andWhere(
        `(boiler.lot_number ILIKE :q
          OR boiler.address ILIKE :q
          OR boiler.responsible_name ILIKE :q
          OR organization.name ILIKE :q
          OR firm.name ILIKE :q
          OR brand.name ILIKE :q)`,
        { q: `%${query.search}%` },
      );
    }
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }
    if (query.statuses?.length) {
      qb.andWhere('boiler.current_status IN (:...statuses)', {
        statuses: query.statuses,
      });
    }
    if (query.firmId)
      qb.andWhere('boiler.firm_id = :firmId', { firmId: query.firmId });
    if (query.brandId) {
      qb.andWhere('boiler.brand_id = :brandId', { brandId: query.brandId });
    }
    if (query.organizationId) {
      qb.andWhere('boiler.organization_id = :organizationId', {
        organizationId: query.organizationId,
      });
    }
    if (query.withoutDevice) {
      /*
       * ⚠️ `NOT EXISTS`, `LEFT JOIN ... IS NULL` EMAS: kotyolda bir
       * nechta qurilma bo'lishi mumkin va `LEFT JOIN` qatorlarni
       * ko'paytirib, `COUNT` ni buzardi.
       */
      /*
       * ⚠️ «Modulsiz» — QOZONXONA modulisiz. Xona moduli kotyol haroratini
       * bermaydi: faqat xona moduli ulangan kotyol hamon «modul kerak».
       */
      qb.andWhere(
        "NOT EXISTS (SELECT 1 FROM devices d WHERE d.boiler_id = boiler.id AND d.device_type = 'kotyol')",
      );
    }

    // ⚠️ Zaxira qiymat ham XOSSA nomi bo'lishi shart (yuqoridagi izoh):
    // `boiler.created_at` yozilsa, SURALMAGAN (sukut) ro'yxat 500
    // qaytarardi — saralash berilgan so'rov esa ishlayverardi va xato
    // «ba'zan ishlaydi» bo'lib ko'rinardi.
    const sortColumn = SORTABLE[query.sortBy ?? ''] ?? 'boiler.createdAt';
    qb.orderBy(sortColumn, query.sortOrder).skip(query.skip).take(query.limit);

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }

  async findOne(id: string, user?: AuthUser): Promise<Boiler> {
    const boiler = await this.baseQuery(user)
      .andWhere('boiler.id = :id', { id })
      .getOne();
    if (!boiler) throw new NotFoundException('Kotyol topilmadi');
    return boiler;
  }

  /**
   * YANGI KOTYOLNI TAYYORLASH — tekshiruv + yozuv, SAQLAMASDAN.
   *
   * ⚠️ Alohida, chunki uni ikki yo'l ishlatadi: oddiy yaratish va
   * «kotyol + modul bitta formada» (`BoilerSetupService`, o'z
   * tranzaksiyasida saqlaydi). Tekshiruvlar (tuman huquqi, tuman bor,
   * lot bo'sh) ikki nusxa bo'lsa, bir kuni ajralib ketardi.
   */
  async prepareNew(dto: CreateBoilerDto, actor: AuthUser): Promise<Boiler> {
    assertDistrictAccess(actor, dto.districtId);
    await this.assertDistrictExists(dto.districtId);
    if (dto.lotNumber) await this.assertLotFree(dto.lotNumber);
    if (dto.organizationId) {
      await this.assertOrganizationInDistrict(
        dto.organizationId,
        dto.districtId,
      );
    }

    return this.repo.create({
      lotNumber: null,
      ...dto,
      firmId: dto.firmId ?? null,
      organizationId: dto.organizationId ?? null,
      brandId: dto.brandId ?? null,
      normAt60: dto.normAt60 ?? null,
      capacityKw: dto.capacityKw ?? null,
      installedYear: dto.installedYear ?? null,
      address: dto.address ?? null,
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
      responsibleName: dto.responsibleName ?? null,
      responsiblePhone: dto.responsiblePhone ?? null,
      note: dto.note ?? null,
      /*
       * ⚠️ Yangi kotyol «aloqa yo'q» bo'lib tug'iladi, «faol» emas.
       * Hali birorta signal kelmagan va uni faol deb ko'rsatish
       * dashboard'dagi raqamni yolg'on qilardi: qurilma ulanmagan
       * kotyol ishlayotgan hisoblanib turardi.
       */
      currentStatus: BoilerStatus.OFFLINE,
      statusChangedAt: new Date(),
    });
  }

  async create(dto: CreateBoilerDto, actor: AuthUser): Promise<Boiler> {
    const boiler = await this.prepareNew(dto, actor);
    const saved = await this.repo.save(boiler);
    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'Boiler',
      entityId: saved.id,
      summary: `Kotyol qo‘shildi: ${lotRef(saved.lotNumber)}`,
      after: { lotNumber: saved.lotNumber, boilerCount: saved.boilerCount },
    });
    return this.findOne(saved.id, actor);
  }

  async update(
    id: string,
    dto: UpdateBoilerDto,
    actor: AuthUser,
  ): Promise<Boiler> {
    const boiler = await this.findOne(id, actor);
    assertDistrictAccess(actor, boiler.districtId);

    if (dto.districtId && dto.districtId !== boiler.districtId) {
      assertDistrictAccess(actor, dto.districtId);
      await this.assertDistrictExists(dto.districtId);
    }
    if (dto.lotNumber && dto.lotNumber !== boiler.lotNumber) {
      await this.assertLotFree(dto.lotNumber);
    }

    const before = {
      lotNumber: boiler.lotNumber,
      districtId: boiler.districtId,
      boilerCount: boiler.boilerCount,
      normAt60: boiler.normAt60,
    };

    /*
     * ⚠️ JORIY HOLAT MAYDONLARIGA TEGILMAYDI (`currentStatus`,
     * `lastTemperature`, `lastReadingAt`). Ular FAQAT telemetriyadan
     * yoziladi. DTO da ham yo'q, lekin `Object.assign` kelajakda
     * qo'shilgan maydonni ham ko'chirib yuborardi — shuning uchun
     * nusxalash maydonma-maydon.
     */
    const patch: Partial<Boiler> = {};
    const assignable: Array<keyof UpdateBoilerDto> = [
      'districtId',
      'lotNumber',
      'firmId',
      'organizationId',
      'brandId',
      'boilerCount',
      'normAt60',
      'fuelType',
      'capacityKw',
      'installedYear',
      'address',
      'lat',
      'lng',
      'responsibleName',
      'responsiblePhone',
      'note',
    ];
    for (const key of assignable) {
      if (dto[key] !== undefined) {
        (patch as Record<string, unknown>)[key] = dto[key];
      }
    }

    const nextOrganizationId =
      dto.organizationId !== undefined
        ? dto.organizationId
        : boiler.organizationId;
    const nextDistrictId = dto.districtId ?? boiler.districtId;
    if (
      nextOrganizationId &&
      (dto.organizationId !== undefined || dto.districtId !== undefined)
    ) {
      await this.assertOrganizationInDistrict(
        nextOrganizationId,
        nextDistrictId,
      );
    }

    Object.assign(boiler, patch);
    const saved = await this.repo.save(boiler);

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Boiler',
      entityId: saved.id,
      summary: `Kotyol tahrirlandi: ${lotRef(saved.lotNumber)}`,
      before,
      after: {
        lotNumber: saved.lotNumber,
        districtId: saved.districtId,
        boilerCount: saved.boilerCount,
        normAt60: saved.normAt60,
      },
    });
    return this.findOne(saved.id, actor);
  }

  /**
   * ARXIVLASH — o'chirishning o'rniga.
   *
   * ⚠️ Kotyolga telemetriya, ogohlantirish va hisobot ishora qiladi.
   * Qator o'chirilsa, o'tgan mavsum hisoboti jimgina kamayib qolardi va
   * «nega noyabrda 196 ta edi, hozir 190 ta» degan savolga javob
   * bo'lmasdi.
   */
  async archive(id: string, reason: string, actor: AuthUser): Promise<Boiler> {
    const boiler = await this.findOne(id, actor);
    assertDistrictAccess(actor, boiler.districtId);

    boiler.isArchived = true;
    boiler.archiveNote = reason;
    const saved = await this.repo.save(boiler);

    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'Boiler',
      entityId: id,
      summary: `Kotyol arxivlandi: ${lotRef(boiler.lotNumber)} — ${reason}`,
    });
    return saved;
  }

  async restore(id: string, actor: AuthUser): Promise<Boiler> {
    const boiler = await this.findOne(id, actor);
    assertDistrictAccess(actor, boiler.districtId);

    boiler.isArchived = false;
    boiler.archiveNote = null;
    const saved = await this.repo.save(boiler);

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Boiler',
      entityId: id,
      summary: `Kotyol arxivdan qaytarildi: ${lotRef(boiler.lotNumber)}`,
    });
    return saved;
  }

  // ───────────────── ichki ─────────────────

  /**
   * ⚠️ BITTA bazaviy so'rov — ro'yxat ham, bitta yozuv ham shundan.
   * Ikki joyda alohida yozilsa, `leftJoin` lardan biri ro'yxatda bo'lib,
   * kartada bo'lmay qolardi va «ro'yxatda firma ko'rinadi, ichkarida
   * yo'q» degan farq paydo bo'lardi.
   */
  private baseQuery(user?: AuthUser) {
    const qb = this.repo
      .createQueryBuilder('boiler')
      .leftJoin('boiler.district', 'district')
      .addSelect([
        'district.id',
        'district.name',
        'district.shortName',
        'district.kind',
      ])
      .leftJoin('boiler.firm', 'firm')
      .addSelect(['firm.id', 'firm.name', 'firm.phone'])
      .leftJoin('boiler.organization', 'organization')
      .addSelect(['organization.id', 'organization.name'])
      /*
       * ⚠️⚠️ ILGARI BU YERDA `organization.kind` TANLANARDI va u
       * `ObjectTypesCatalog` migratsiyasida O'CHIRILGAN ustun edi —
       * natijada KOTYOL KARTASI butunlay 500 qaytarardi
       * («column organization.kind does not exist»).
       *
       * Obyekt turi endi alohida KATALOG jadvalida. Uni `addSelect`
       * bilan matn sifatida emas, RELATSIYA sifatida olish kerak:
       * shunda ustun nomi o'zgarsa, TypeORM entity orqali
       * tekshiriladi va xato kompilyatsiyada chiqadi, dalada emas.
       */
      .leftJoin('organization.objectType', 'objectType')
      .addSelect(['objectType.id', 'objectType.name', 'objectType.code'])
      .leftJoin('boiler.brand', 'brand')
      .addSelect(['brand.id', 'brand.name', 'brand.country'])
      .leftJoin('boiler.devices', 'device')
      .addSelect([
        'device.id',
        'device.deviceId',
        'device.name',
        'device.isActive',
        'device.lastSeenAt',
        'device.deviceType',
        'device.lastRoomTemperature',
        'device.lastRoomReadingAt',
      ]);

    applyDistrictScope(qb, user, 'boiler.district_id');
    return qb;
  }

  private async assertLotFree(lotNumber: string): Promise<void> {
    const exists = await this.repo
      .createQueryBuilder('boiler')
      .where('LOWER(boiler.lot_number) = LOWER(:lotNumber)', { lotNumber })
      .getExists();
    if (exists) {
      throw new BadRequestException(
        `«${lotNumber}» lot raqami allaqachon ro‘yxatda bor`,
      );
    }
  }

  /**
   * ⚠️⚠️ MUASSASA KOTYOL TUMANIGA TEGISHLI BO'LISHI SHART: katalog endi
   * tuman bo'yicha. Tumansiz (tarixiy) yozuv birinchi ishlatilganda shu
   * tumanga biriktiriladi.
   */
  private async assertOrganizationInDistrict(
    organizationId: string,
    districtId: string,
  ): Promise<void> {
    const district = await this.districts.findOne({
      where: { id: districtId },
      select: { id: true, key: true },
    });
    const organizations = this.repo.manager.getRepository(Organization);
    const organization = await organizations.findOne({
      where: { id: organizationId },
      select: { id: true, districtKey: true },
    });
    if (!organization) throw new BadRequestException('Muassasa topilmadi');
    if (!district) throw new BadRequestException('Tuman topilmadi');
    if (organization.districtKey === null) {
      await organizations.update(organization.id, {
        districtKey: district.key,
      });
      return;
    }
    if (organization.districtKey !== district.key) {
      throw new BadRequestException(
        'Muassasa boshqa tumanga tegishli — shu tumandagi muassasani tanlang',
      );
    }
  }

  private async assertDistrictExists(districtId: string): Promise<void> {
    const exists = await this.districts.existsBy({ id: districtId });
    if (!exists) throw new BadRequestException('Bunday tuman topilmadi');
  }
}
