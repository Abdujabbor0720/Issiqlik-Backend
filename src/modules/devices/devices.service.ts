import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import {
  AuditAction,
  DeviceType,
  UserRole,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { Device } from '../../database/entities/device.entity';
import { OtaEvent } from '../../database/entities/firmware.entities';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { sanitizeReportedText } from '../../helpers/device-profile.helper';
import { assertDistrictAccess } from '../../helpers/scope.helper';
import { AuditService } from '../audit/audit.service';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import { ObjectTypeDirectoryService } from '../geo/object-type-directory.service';
import { DeviceKeyService } from './device-key.service';
import { PendingDevicesService } from './pending-devices.service';
import type {
  ConfirmLocationDto,
  CreateDeviceDto,
  DeviceQueryDto,
  RegisterPendingDto,
  UpdateDeviceDto,
} from './dto/device.dto';

/**
 * QURILMA «OFLAYN» CHEGARASI — oxirgi telemetriyadan 5 daqiqa (§6).
 *
 * ⚠️ Kotyol holatining «aloqa yo'q» chegarasi (`offlineAfterMinutes`,
 * sukut 15) BOSHQA narsa: u kotyol holatini baholaydi. Bu esa qurilmaning
 * o'zi tirikmi — qurilma har 60 s da yuboradi, 5 daqiqa = 5 ta o'tkazib
 * yuborilgan signal.
 */
export const DEVICE_OFFLINE_AFTER_MS = 5 * 60_000;

export interface DeviceWithKey {
  device: DeviceRow;
  /**
   * ⚠️ FAQAT shu javobda, BIR MARTA. `null` — kalit tizimga noma'lum
   * (qurilmaning o'z tokeni qabul qilindi yoki u umumiy token bilan ishlaydi).
   */
  apiKey: string | null;
}

type DistrictRef = { id: string; key: string; name: string; shortName: string };

/** «Qurilmalar» sahifasining bitta qatori. */
export interface DeviceRow {
  id: string;
  deviceId: string;
  name: string | null;
  deviceType: DeviceType;
  isActive: boolean;
  firmwareVersion: string | null;
  lastSeenAt: Date | null;
  lastCheckAt: Date | null;
  lastIpAddress: string | null;
  /** Oxirgi telemetriya 5 daqiqadan yangi. */
  online: boolean;
  readingsCount: string;
  note: string | null;
  apiKeyPreview: string;
  allowSharedToken: boolean;
  /** Oxirgi so'rovdagi token turi (`personal` | `shared`), hali so'rov bo'lmasa `null`. */
  tokenKind: 'personal' | 'shared' | null;
  tokenIssuedAt: Date | null;
  boilerId: string | null;
  districtId: string | null;
  organizationId: string | null;
  boiler: {
    id: string;
    lotNumber: string | null;
    districtId: string;
    organization: { id: string; name: string } | null;
  } | null;
  /** Qurilmaning o'z (paneldagi) tumani — kotyolga ulanmaganlar uchun. */
  district: DistrictRef | null;
  /** AMALDAGI joylashuv: kotyolniki, aks holda qurilmaniki. */
  location: {
    source: 'boiler' | 'device' | null;
    district: DistrictRef | null;
    objectType: { id: string; code: string; name: string } | null;
    institution: { id: string; name: string } | null;
  };
  /**
   * TAKLIF — plata aytgan, lekin panelda BO'SH maydonlar. Admin
   * `POST /devices/:id/location/confirm` bilan tasdiqlaydi.
   */
  suggestion: {
    district: { key: string; name: string } | null;
    objectType: { code: string; name: string } | null;
    institution: string | null;
  } | null;
  /** Plata aytgan xom joylashuv (tekshirilgan kalitlar). */
  reported: {
    district: string | null;
    objectType: string | null;
    institution: string | null;
    mfy: string | null;
    institutionHint: string | null;
  };
  lastOta: {
    status: string;
    targetVersion: string | null;
    runningVersion: string | null;
    message: string | null;
    at: Date;
  } | null;
  lastRoomTemperature: number | null;
  lastHumidity: number | null;
  lastRoomReadingAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type DeviceWithJoins = Device & { lastOtaEvent?: OtaEvent | null };

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(PendingDevice)
    private readonly pendingRows: Repository<PendingDevice>,
    private readonly keys: DeviceKeyService,
    private readonly audit: AuditService,
    private readonly pending: PendingDevicesService,
    private readonly config: ConfigService,
    private readonly districts: DistrictDirectoryService,
    private readonly objectTypes: ObjectTypeDirectoryService,
  ) {}

  // ═══════════════════════ O'QISH ═══════════════════════

  /**
   * RO'YXAT — filtrlar: tuman, tur, holat (onlayn/oflayn), versiya.
   *
   * ⚠️⚠️ TUMAN MAS'ULI faqat o'z tumanini ko'radi — chegara `where` da
   * (`applyVisibility`), UI'da emas.
   */
  async list(
    query: DeviceQueryDto,
    user?: AuthUser,
  ): Promise<PaginatedResult<DeviceRow>> {
    const offlineBefore = new Date(Date.now() - DEVICE_OFFLINE_AFTER_MS);
    const qb = this.baseQuery()
      .orderBy('device.lastSeenAt', 'DESC', 'NULLS LAST')
      .addOrderBy('device.deviceId', 'ASC')
      .skip(query.skip)
      .take(query.limit);

    await this.applyVisibility(qb, user);

    if (query.districtId) {
      qb.andWhere(
        'COALESCE(boiler.district_id, device.district_id) = :filterDistrict',
        { filterDistrict: query.districtId },
      );
    }
    if (query.deviceType) {
      qb.andWhere('device.device_type = :deviceType', {
        deviceType: query.deviceType,
      });
    }
    const status = query.status ?? (query.offline ? 'offline' : undefined);
    if (status === 'online') {
      qb.andWhere('device.last_seen_at >= :offlineBefore', { offlineBefore });
    } else if (status === 'offline') {
      qb.andWhere(
        '(device.last_seen_at IS NULL OR device.last_seen_at < :offlineBefore)',
        { offlineBefore },
      );
    }
    if (query.version) {
      if (query.version === 'none')
        qb.andWhere('device.firmware_version IS NULL');
      else
        qb.andWhere('device.firmware_version = :version', {
          version: query.version,
        });
    }
    if (query.search) {
      qb.andWhere(
        '(device.device_id ILIKE :q OR device.name ILIKE :q ' +
          'OR device.institution_hint ILIKE :q OR boiler.lot_number ILIKE :q ' +
          'OR device.reported_institution ILIKE :q OR device.reported_mfy ILIKE :q ' +
          'OR boilerOrganization.name ILIKE :q OR deviceOrganization.name ILIKE :q)',
        { q: `%${query.search}%` },
      );
    }
    if (query.isActive !== undefined) {
      qb.andWhere('device.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.unassigned) qb.andWhere('device.boiler_id IS NULL');
    if (query.hasSuggestion) {
      qb.andWhere(
        '((COALESCE(boiler.district_id, device.district_id) IS NULL AND device.reported_district IS NOT NULL) ' +
          'OR (COALESCE(boiler.organization_id, device.organization_id) IS NULL AND device.reported_institution IS NOT NULL))',
      );
    }

    const [items, total] = await qb.getManyAndCount();
    const rows = await Promise.all(items.map((item) => this.toRow(item)));
    return new PaginatedResult(rows, total, query.page, query.limit);
  }

  /** Filtr uchun: tizimdagi proshivka versiyalari (ko'rinadigan qurilmalar bo'yicha). */
  async versions(
    user?: AuthUser,
  ): Promise<Array<{ version: string | null; count: number }>> {
    const qb = this.repo
      .createQueryBuilder('device')
      .leftJoin('device.boiler', 'boiler')
      .select('device.firmware_version', 'version')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('device.firmware_version')
      .orderBy('device.firmware_version', 'DESC', 'NULLS LAST');
    await this.applyVisibility(qb, user);
    return qb.getRawMany<{ version: string | null; count: number }>();
  }

  async findOne(id: string): Promise<Device> {
    const device = await this.repo.findOne({
      where: { id },
      relations: {
        boiler: { district: true, organization: { objectType: true } },
        district: true,
        organization: { objectType: true },
      },
    });
    if (!device) throw new NotFoundException('Qurilma topilmadi');
    return device;
  }

  /**
   * Tuman chegarasi bilan — ro'yxatdagi qoida bilan AYNI.
   * ⚠️ Begona tuman qurilmasi uchun 404 (403 emas): mavjudligini ham oshkor qilmaymiz.
   */
  async findOneVisible(id: string, user?: AuthUser): Promise<Device> {
    const device = await this.findOne(id);
    if (!(await this.canSee(device, user))) {
      throw new NotFoundException('Qurilma topilmadi');
    }
    return device;
  }

  async getRow(id: string, user?: AuthUser): Promise<DeviceRow> {
    await this.findOneVisible(id, user);
    const qb = this.baseQuery().where('device.id = :id', { id });
    const device = await qb.getOne();
    if (!device) throw new NotFoundException('Qurilma topilmadi');
    return this.toRow(device);
  }

  sharedTokenEnabled(): boolean {
    return Boolean(
      this.config.get<string>('telemetry.sharedDeviceToken')?.trim(),
    );
  }

  // ═══════════════════════ YOZISH ═══════════════════════

  /**
   * Yangi qurilma uchun tayyor (saqlanmagan) yozuv.
   *
   * ⚠️ `BoilerSetupService` ham shuni chaqiradi — kalit qoidasi BITTA joyda.
   */
  async prepareNewDevice(
    dto: Pick<CreateDeviceDto, 'deviceId' | 'name' | 'apiKey' | 'note'> &
      Partial<Pick<CreateDeviceDto, 'deviceType'>>,
  ): Promise<{ device: Device; apiKey: string }> {
    const exists = await this.repo.existsBy({ deviceId: dto.deviceId });
    if (exists) {
      throw new ConflictException(
        `«${dto.deviceId}» identifikatorli qurilma allaqachon mavjud`,
      );
    }

    const personalKey = dto.apiKey?.trim();
    const apiKey = personalKey || this.keys.generate();

    const device = this.repo.create({
      deviceId: dto.deviceId,
      name: dto.name ?? null,
      boilerId: null,
      deviceType: dto.deviceType ?? DeviceType.KOTYOL,
      apiKeyHash: this.keys.hash(apiKey),
      apiKeyPreview: this.keys.preview(apiKey),
      tokenIssuedAt: new Date(),
      note: dto.note ?? null,
      isActive: true,
      allowSharedToken: !personalKey && this.sharedTokenEnabled(),
    });

    return { device, apiKey };
  }

  async create(dto: CreateDeviceDto, actor: AuthUser): Promise<DeviceWithKey> {
    const { device, apiKey } = await this.prepareNewDevice(dto);

    const districtId = await this.resolveDistrictForWrite(
      dto.districtId ?? null,
      actor,
    );
    device.districtId = districtId;

    if (dto.boilerId) {
      await this.assertBoilerAssignable(
        dto.boilerId,
        actor,
        undefined,
        districtId,
        device.deviceType,
      );
      device.boilerId = dto.boilerId;
    }
    if (dto.organizationId) {
      device.organizationId = await this.assertOrganization(
        dto.organizationId,
        districtId,
      );
    }

    const saved = await this.repo.save(device);
    await this.pending.closeFor(saved.deviceId);

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'Device',
      entityId: saved.id,
      summary: `ESP32 moduli qo‘shildi: ${saved.deviceId} (${saved.deviceType})`,
    });

    return { device: await this.getRow(saved.id, actor), apiKey };
  }

  async update(
    id: string,
    dto: UpdateDeviceDto,
    actor: AuthUser,
  ): Promise<DeviceRow> {
    const device = await this.findOneVisible(id, actor);
    assertDistrictAccess(actor, this.effectiveDistrictId(device));

    const before = {
      deviceId: device.deviceId,
      boilerId: device.boilerId,
      isActive: device.isActive,
      deviceType: device.deviceType,
      districtId: device.districtId,
      organizationId: device.organizationId,
    };

    if (dto.deviceId && dto.deviceId !== device.deviceId) {
      const exists = await this.repo.existsBy({ deviceId: dto.deviceId });
      if (exists) {
        throw new ConflictException('Bunday identifikatorli qurilma bor');
      }
      device.deviceId = dto.deviceId;
    }

    /*
     * ⚠️⚠️ TURNI QO'LDA O'ZGARTIRISH — OTA xavfsizligiga ta'sir qiladi.
     * Faqat qurilma o'zi turini aytmaydigan eski proshivkalar uchun
     * kerak (masalan DHT22 uzilib, tur noto'g'ri qolgan). Kotyolda boshqa
     * kotyol moduli bo'lsa — rad etiladi.
     */
    if (dto.deviceType && dto.deviceType !== device.deviceType) {
      if (dto.deviceType === DeviceType.KOTYOL && device.boilerId) {
        await this.assertBoilerAssignable(
          device.boilerId,
          actor,
          id,
          null,
          DeviceType.KOTYOL,
        );
      }
      device.deviceType = dto.deviceType;
    }

    if (dto.districtId !== undefined) {
      const next = await this.resolveDistrictForWrite(dto.districtId, actor);
      if (next && device.boiler && device.boiler.districtId !== next) {
        throw new BadRequestException(
          'Qurilma boshqa tumandagi kotyolga ulangan — avval kotyoldan ajrating',
        );
      }
      if (next !== device.districtId) {
        device.districtId = next;
        // ⚠️ Muassasa tumanga tegishli: tuman o'zgarsa, eski muassasa tushadi.
        if (device.organizationId && dto.organizationId === undefined) {
          device.organizationId = null;
        }
      }
    }

    if (dto.boilerId !== undefined) {
      if (dto.boilerId) {
        await this.assertBoilerAssignable(
          dto.boilerId,
          actor,
          id,
          device.districtId,
          device.deviceType,
        );
        const boiler = await this.boilers.findOne({
          where: { id: dto.boilerId },
          select: { id: true, districtId: true },
        });
        // ⚠️ Tumani bo'sh modul kotyolga ulanganda tuman kotyoldan olinadi.
        if (boiler && !device.districtId) device.districtId = boiler.districtId;
      }
      device.boilerId = dto.boilerId || null;
    }

    if (dto.organizationId !== undefined) {
      device.organizationId = dto.organizationId
        ? await this.assertOrganization(dto.organizationId, device.districtId)
        : null;
    }

    if (dto.name !== undefined) device.name = dto.name ?? null;
    if (dto.note !== undefined) device.note = dto.note ?? null;
    if (dto.isActive !== undefined) device.isActive = dto.isActive;

    /*
     * ⚠️⚠️ `update()` ANIQ USTUNLAR bilan, yuklangan entity'ni `save()` QILISH
     * EMAS: `findOne` relation obyektlarini (eski `boiler`, `district`) ham
     * yuklaydi va TypeORM `save()` da relation obyekti FK ustunidan USTUN
     * turadi — yangi `boilerId` / `districtId` jimgina eski qiymatga
     * qaytib qolardi.
     */
    const after = {
      deviceId: device.deviceId,
      name: device.name,
      note: device.note,
      isActive: device.isActive,
      deviceType: device.deviceType,
      boilerId: device.boilerId,
      districtId: device.districtId,
      organizationId: device.organizationId,
    };
    try {
      await this.repo.update(id, after);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Bu kotyolga boshqa kotyol moduli biriktirilgan yoki identifikator band',
        );
      }
      throw error;
    }
    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Device',
      entityId: id,
      summary: `Qurilma tahrirlandi: ${after.deviceId}`,
      before,
      after,
    });
    return this.getRow(id, actor);
  }

  /**
   * JOYLASHUV TAKLIFINI TASDIQLASH (§4: «panelda joylashuv bo'sh bo'lsa,
   * taklif sifatida saqla va adminga tasdiqlash uchun ko'rsat»).
   *
   * ⚠️ Faqat BO'SH maydonlar to'ldiriladi — to'la panel maydoni hech qachon
   * plata qiymati bilan almashtirilmaydi. Muassasa katalogdan topiladi
   * (tuman ichida, nom bo'yicha) yoki katalogga yangi yozuv sifatida
   * qo'shiladi.
   */
  async confirmLocation(
    id: string,
    dto: ConfirmLocationDto,
    actor: AuthUser,
  ): Promise<DeviceRow> {
    const device = await this.findOneVisible(id, actor);
    if (device.boilerId) {
      throw new BadRequestException(
        'Qurilma kotyolga ulangan — joylashuv kotyoldan olinadi',
      );
    }
    const fields = new Set(
      dto.fields?.length
        ? dto.fields
        : ['district', 'objectType', 'institution'],
    );
    const changes: string[] = [];

    if (
      fields.has('district') &&
      !device.districtId &&
      device.reportedDistrict
    ) {
      const district = await this.districts.byKey(device.reportedDistrict);
      if (!district) {
        throw new BadRequestException('Taklif qilingan tuman topilmadi');
      }
      assertDistrictAccess(actor, district.id);
      device.districtId = district.id;
      changes.push(`tuman: ${district.name}`);
    }
    assertDistrictAccess(actor, device.districtId);

    if (
      (fields.has('institution') || fields.has('objectType')) &&
      !device.organizationId &&
      device.reportedInstitution
    ) {
      if (!device.districtId) {
        throw new BadRequestException(
          'Muassasa tumanga tegishli — avval tumanni tasdiqlang',
        );
      }
      const district = await this.districts.byId(device.districtId);
      const type = fields.has('objectType')
        ? await this.objectTypes.resolve(device.reportedObjectType)
        : null;
      const organization = await this.findOrCreateInstitution(
        district?.key ?? '',
        device.reportedInstitution,
        type?.id ?? null,
      );
      device.organizationId = organization.id;
      changes.push(`muassasa: ${organization.name}`);
    }

    if (changes.length === 0) {
      throw new BadRequestException('Tasdiqlanadigan taklif yo‘q');
    }

    await this.repo.update(device.id, {
      districtId: device.districtId,
      organizationId: device.organizationId,
    });
    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Device',
      entityId: device.id,
      summary: `Qurilma ${device.deviceId} joylashuvi tasdiqlandi (${changes.join(', ')})`,
    });
    return this.getRow(device.id, actor);
  }

  /**
   * «YANGI QURILMALAR» → BIR BOSISHDA RO'YXATGA OLISH.
   *
   * Token tanlovi (ustuvorlik bilan):
   *   1) admin kiritgan kalit (`apiKey`);
   *   2) qurilma so'nggi so'rovda yuborgan SHAXSIY token (hash) — plata
   *      o'zgarishsiz ishlay boshlaydi; `token_conflict` bo'lsa — RAD
   *      (kimdir shu `device_id` dan boshqa token bilan foydalangan);
   *   3) umumiy token bilan kelgan bo'lsa — `allowSharedToken`.
   *
   * Joylashuv: admin tanlagani, aks holda plata aytgani (taklif). Tuman
   * mas'uli faqat O'Z tumaniga ro'yxatga oladi.
   */
  async registerPending(
    pendingId: string,
    dto: RegisterPendingDto,
    actor: AuthUser,
  ): Promise<DeviceWithKey & { tokenSource: string }> {
    const row = await this.pendingRows.findOne({ where: { id: pendingId } });
    if (!row) throw new NotFoundException('So‘rov topilmadi');

    const deviceType = dto.deviceType ?? row.deviceType;
    if (!deviceType) {
      throw new BadRequestException('Qurilma turini tanlang: kotyol yoki xona');
    }

    const reportedDistrict = await this.districts.byKey(row.reportedDistrict);
    const districtId = await this.resolveDistrictForWrite(
      dto.districtId !== undefined
        ? dto.districtId
        : (reportedDistrict?.id ?? null),
      actor,
    );

    let apiKey: string | null = null;
    let tokenSource: 'provided' | 'adopted' | 'shared';
    const generated = this.keys.generate();
    const device = this.repo.create({
      deviceId: row.deviceId,
      name: dto.name ?? null,
      note: dto.note ?? null,
      deviceType,
      districtId,
      isActive: true,
      firmwareVersion: row.firmwareVersion,
      lastIpAddress: row.lastIpAddress,
      institutionHint: row.institutionHint,
      reportedDistrict: row.reportedDistrict,
      reportedObjectType: row.reportedObjectType,
      reportedInstitution: row.reportedInstitution,
      tokenIssuedAt: new Date(),
      allowSharedToken: false,
      apiKeyHash: this.keys.hash(generated),
      apiKeyPreview: this.keys.preview(generated),
    });

    if (dto.apiKey?.trim()) {
      apiKey = dto.apiKey.trim();
      device.apiKeyHash = this.keys.hash(apiKey);
      device.apiKeyPreview = this.keys.preview(apiKey);
      tokenSource = 'provided';
    } else if (row.tokenConflict) {
      throw new ConflictException(
        'Bu identifikator bilan TURLI tokenlar kelgan — kalitni qo‘lda kiriting',
      );
    } else if (row.tokenKind === 'shared') {
      if (!this.sharedTokenEnabled()) {
        throw new BadRequestException(
          'Qurilma umumiy token bilan kelgan, lekin serverda DEVICE_SHARED_TOKEN o‘chirilgan — kalitni qo‘lda kiriting',
        );
      }
      device.allowSharedToken = true;
      apiKey = generated;
      tokenSource = 'shared';
    } else if (row.tokenHash) {
      device.apiKeyHash = row.tokenHash;
      device.apiKeyPreview = row.tokenPreview ?? '—';
      tokenSource = 'adopted';
    } else {
      throw new BadRequestException(
        'Qurilma tokeni noma‘lum — kalitni qo‘lda kiriting',
      );
    }

    if (dto.boilerId) {
      await this.assertBoilerAssignable(
        dto.boilerId,
        actor,
        undefined,
        districtId,
        deviceType,
      );
      device.boilerId = dto.boilerId;
    }

    if (dto.organizationId) {
      device.organizationId = await this.assertOrganization(
        dto.organizationId,
        districtId,
      );
    } else if (!dto.boilerId && districtId) {
      const name = dto.institutionName ?? row.reportedInstitution;
      if (name) {
        const district = await this.districts.byId(districtId);
        const typeId =
          dto.objectTypeId ??
          (await this.objectTypes.resolve(row.reportedObjectType))?.id ??
          null;
        device.organizationId = (
          await this.findOrCreateInstitution(district?.key ?? '', name, typeId)
        ).id;
      }
    }

    let saved: Device;
    try {
      saved = await this.repo.save(device);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `«${row.deviceId}» allaqachon ro‘yxatda (yoki kotyolda boshqa kotyol moduli bor)`,
        );
      }
      throw error;
    }
    await this.pending.closeFor(saved.deviceId);
    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'Device',
      entityId: saved.id,
      summary:
        `«Yangi qurilmalar» dan ro‘yxatga olindi: ${saved.deviceId} (${saved.deviceType}, ` +
        `token: ${tokenSource})`,
    });

    return {
      device: await this.getRow(saved.id, actor),
      apiKey,
      tokenSource,
    };
  }

  async rotateKey(id: string, actor: AuthUser): Promise<DeviceWithKey> {
    const device = await this.findOneVisible(id, actor);
    const apiKey = this.keys.generate();

    await this.repo.update(id, {
      apiKeyHash: this.keys.hash(apiKey),
      apiKeyPreview: this.keys.preview(apiKey),
      tokenIssuedAt: new Date(),
    });

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Device',
      entityId: id,
      summary: `Qurilma kaliti almashtirildi: ${device.deviceId}`,
    });

    return { device: await this.getRow(id, actor), apiKey };
  }

  async remove(id: string, actor: AuthUser): Promise<void> {
    const device = await this.findOneVisible(id, actor);
    await this.repo.delete(id);
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'Device',
      entityId: id,
      summary: `Qurilma o‘chirildi: ${device.deviceId}`,
      before: { deviceId: device.deviceId },
    });
  }

  /**
   * Kotyolga biriktirish mumkinmi.
   *
   * ⚠️ Bitta kotyolga bitta KOTYOL moduli; xona modullari — istalgancha.
   * ⚠️ Tumani belgilangan modul faqat shu tumandagi kotyolga.
   */
  async assertBoilerAssignable(
    boilerId: string,
    actor: AuthUser,
    exceptDeviceId?: string,
    deviceDistrictId?: string | null,
    deviceType: DeviceType = DeviceType.KOTYOL,
  ): Promise<void> {
    const boiler = await this.boilers.findOne({
      where: { id: boilerId },
      relations: { district: true },
    });
    if (!boiler) throw new BadRequestException('Bunday kotyol topilmadi');
    assertDistrictAccess(actor, boiler.districtId);

    if (deviceDistrictId && deviceDistrictId !== boiler.districtId) {
      throw new BadRequestException(
        `Modul boshqa tumanga biriktirilgan — uni faqat o‘sha tumandagi ` +
          `kotyolga ulash mumkin (tanlangan kotyol: ${boiler.district?.name ?? 'boshqa tuman'})`,
      );
    }

    if (boiler.isArchived) {
      throw new BadRequestException(
        'Arxivlangan kotyolga qurilma biriktirib bo‘lmaydi',
      );
    }

    if (deviceType === DeviceType.XONA) return;

    const qb = this.repo
      .createQueryBuilder('device')
      .where('device.boiler_id = :boilerId', { boilerId })
      .andWhere('device.device_type = :kotyol', { kotyol: DeviceType.KOTYOL });
    if (exceptDeviceId) {
      qb.andWhere('device.id <> :exceptDeviceId', { exceptDeviceId });
    }
    const busy = await qb.getOne();
    if (busy) {
      throw new ConflictException(
        `Bu kotyolga «${busy.deviceId}» kotyol moduli allaqachon biriktirilgan`,
      );
    }
  }

  // ═══════════════════════ Yordamchilar ═══════════════════════

  private baseQuery(): SelectQueryBuilder<DeviceWithJoins> {
    return this.repo
      .createQueryBuilder('device')
      .leftJoin('device.boiler', 'boiler')
      .addSelect([
        'boiler.id',
        'boiler.lotNumber',
        'boiler.districtId',
        'boiler.organizationId',
      ])
      .leftJoin('boiler.organization', 'boilerOrganization')
      .addSelect([
        'boilerOrganization.id',
        'boilerOrganization.name',
        'boilerOrganization.objectTypeId',
      ])
      .leftJoin('device.organization', 'deviceOrganization')
      .addSelect([
        'deviceOrganization.id',
        'deviceOrganization.name',
        'deviceOrganization.objectTypeId',
      ])
      .leftJoinAndMapOne(
        'device.lastOtaEvent',
        OtaEvent,
        'lastOta',
        `lastOta.id = (SELECT e.id FROM ota_events e
                        WHERE e.device_id = device.id
                        ORDER BY e.created_at DESC LIMIT 1)`,
      );
  }

  /**
   * KO'RINISH CHEGARASI — tuman mas'uli uchun.
   *
   * ⚠️ Mas'ul ko'radi: amaldagi tumani o'ziniki bo'lgan qurilmalar VA hali
   * hech qaysi tumanga biriktirilmagan, lekin plata o'z tumanini aytgan
   * qurilmalar (taklifni tasdiqlashi uchun).
   */
  private async applyVisibility<T extends object>(
    qb: SelectQueryBuilder<T>,
    user?: AuthUser,
  ): Promise<void> {
    if (user?.role !== UserRole.OPERATOR) return;
    if (!user.districtId) {
      throw new ForbiddenException(
        'Hisobingizga tuman biriktirilmagan — administratorga murojaat qiling',
      );
    }
    const district = await this.districts.byId(user.districtId);
    qb.andWhere(
      '(COALESCE(boiler.district_id, device.district_id) = :scopeDistrict ' +
        'OR (boiler.district_id IS NULL AND device.district_id IS NULL ' +
        'AND device.reported_district = :scopeDistrictKey))',
      {
        scopeDistrict: user.districtId,
        scopeDistrictKey: district?.key ?? '__none__',
      },
    );
  }

  private async canSee(device: Device, user?: AuthUser): Promise<boolean> {
    if (user?.role !== UserRole.OPERATOR) return true;
    if (!user.districtId) return false;
    const effective = this.effectiveDistrictId(device);
    if (effective) return effective === user.districtId;
    const district = await this.districts.byId(user.districtId);
    return Boolean(district && device.reportedDistrict === district.key);
  }

  private effectiveDistrictId(device: Device): string | null {
    return device.boiler?.districtId ?? device.districtId ?? null;
  }

  /** Tuman mas'uli faqat o'z tumaniga yoza oladi. */
  private async resolveDistrictForWrite(
    districtId: string | null,
    actor: AuthUser,
  ): Promise<string | null> {
    if (actor.role === UserRole.OPERATOR) {
      if (districtId && districtId !== actor.districtId) {
        throw new ForbiddenException('Bu tuman sizga biriktirilmagan');
      }
      return actor.districtId ?? null;
    }
    if (!districtId) return null;
    if (!(await this.districts.byId(districtId))) {
      throw new BadRequestException('Bunday tuman topilmadi');
    }
    return districtId;
  }

  /** Muassasa mavjudmi va qurilma tumaniga tegishlimi. */
  private async assertOrganization(
    organizationId: string,
    districtId: string | null,
  ): Promise<string> {
    const organization = await this.organizations.findOne({
      where: { id: organizationId },
      select: { id: true, districtKey: true, isArchived: true },
    });
    if (!organization) throw new BadRequestException('Muassasa topilmadi');
    if (organization.isArchived) {
      throw new BadRequestException('Arxivlangan muassasani tanlab bo‘lmaydi');
    }
    const district = await this.districts.byId(districtId);
    if (
      organization.districtKey &&
      district &&
      organization.districtKey !== district.key
    ) {
      throw new BadRequestException('Muassasa boshqa tumanga tegishli');
    }
    return organization.id;
  }

  /**
   * KATALOGDAN TOPISH YOKI QO'SHISH — tuman ichida, nom bo'yicha.
   *
   * ⚠️ Plata yuborgan nom TOZALANADI (boshqaruv va yo'nalish belgilari),
   * solishtirish katta-kichik harfsiz. Bir vaqtda ikki so'rov bir xil nomni
   * qo'shsa, ikkinchisi unique indeksga uriladi va mavjud yozuv qaytadi.
   */
  private async findOrCreateInstitution(
    districtKey: string,
    rawName: string,
    objectTypeId: string | null,
  ): Promise<Organization> {
    const name = sanitizeReportedText(rawName, 180);
    if (!districtKey || !name) {
      throw new BadRequestException('Muassasa nomi yoki tumani noto‘g‘ri');
    }
    const find = () =>
      this.organizations
        .createQueryBuilder('org')
        .where('org.district_key = :districtKey', { districtKey })
        .andWhere('LOWER(org.name) = LOWER(:name)', { name })
        .getOne();

    const existing = await find();
    if (existing) {
      if (existing.isArchived) {
        throw new BadRequestException(
          `«${existing.name}» muassasasi arxivlangan — katalogda tiklang`,
        );
      }
      return existing;
    }
    const otherTypeId =
      objectTypeId ?? (await this.objectTypes.resolve('other'))?.id ?? null;
    try {
      return await this.organizations.save(
        this.organizations.create({
          name,
          districtKey,
          objectTypeId: otherTypeId,
          note: 'Qurilma taklifidan qo‘shildi',
          phone: null,
          isArchived: false,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await find();
      if (!raced) throw error;
      return raced;
    }
  }

  private async toRow(device: DeviceWithJoins): Promise<DeviceRow> {
    const allDistricts = await this.districts.all();
    const byId = (id: string | null | undefined) =>
      allDistricts.find((item) => item.id === id) ?? null;
    const asRef = (record: ReturnType<typeof byId>): DistrictRef | null =>
      record
        ? {
            id: record.id,
            key: record.key,
            name: record.name,
            shortName: record.shortName ?? record.name,
          }
        : null;

    const boiler = device.boiler ?? null;
    const effectiveDistrict = byId(boiler?.districtId ?? device.districtId);
    const org = boiler?.organization ?? device.organization ?? null;
    const objectType = org?.objectTypeId
      ? await this.objectTypes.byId(org.objectTypeId)
      : null;

    const suggestDistrict =
      !effectiveDistrict && device.reportedDistrict
        ? (allDistricts.find((item) => item.key === device.reportedDistrict) ??
          null)
        : null;
    const suggestType =
      !org && device.reportedObjectType
        ? await this.objectTypes.resolve(device.reportedObjectType)
        : null;
    const suggestInstitution =
      !org && !boiler && device.reportedInstitution
        ? device.reportedInstitution
        : null;
    const hasSuggestion = Boolean(
      suggestDistrict || suggestType || suggestInstitution,
    );

    const lastOta = device.lastOtaEvent ?? null;
    const online =
      device.lastSeenAt !== null &&
      Date.now() - new Date(device.lastSeenAt).getTime() <
        DEVICE_OFFLINE_AFTER_MS;

    return {
      id: device.id,
      deviceId: device.deviceId,
      name: device.name,
      deviceType: device.deviceType,
      isActive: device.isActive,
      firmwareVersion: device.firmwareVersion,
      lastSeenAt: device.lastSeenAt,
      lastCheckAt: device.lastCheckAt,
      lastIpAddress: device.lastIpAddress,
      online,
      readingsCount: device.readingsCount,
      note: device.note,
      apiKeyPreview: device.apiKeyPreview,
      allowSharedToken: device.allowSharedToken,
      tokenKind: device.lastTokenKind,
      tokenIssuedAt: device.tokenIssuedAt,
      boilerId: device.boilerId,
      districtId: device.districtId,
      organizationId: device.organizationId,
      boiler: boiler
        ? {
            id: boiler.id,
            lotNumber: boiler.lotNumber,
            districtId: boiler.districtId,
            organization: boiler.organization
              ? { id: boiler.organization.id, name: boiler.organization.name }
              : null,
          }
        : null,
      district: asRef(byId(device.districtId)),
      location: {
        source: boiler ? 'boiler' : effectiveDistrict || org ? 'device' : null,
        district: asRef(effectiveDistrict),
        objectType: objectType
          ? { id: objectType.id, code: objectType.code, name: objectType.name }
          : null,
        institution: org ? { id: org.id, name: org.name } : null,
      },
      suggestion: hasSuggestion
        ? {
            district: suggestDistrict
              ? { key: suggestDistrict.key, name: suggestDistrict.name }
              : null,
            objectType: suggestType
              ? { code: suggestType.code, name: suggestType.name }
              : null,
            institution: suggestInstitution,
          }
        : null,
      reported: {
        district: device.reportedDistrict,
        objectType: device.reportedObjectType,
        institution: device.reportedInstitution,
        mfy: device.reportedMfy,
        institutionHint: device.institutionHint,
      },
      lastOta: lastOta
        ? {
            status: lastOta.status,
            targetVersion: lastOta.targetVersion,
            runningVersion: lastOta.runningVersion,
            message: lastOta.message,
            at: lastOta.createdAt,
          }
        : null,
      lastRoomTemperature: device.lastRoomTemperature,
      lastHumidity: device.lastHumidity,
      lastRoomReadingAt: device.lastRoomReadingAt,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
    };
  }
}
