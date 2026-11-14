import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, UserRole } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import { Device } from '../../database/entities/device.entity';
import { assertDistrictAccess } from '../../helpers/scope.helper';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { DeviceKeyService } from './device-key.service';
import { PendingDevicesService } from './pending-devices.service';
import type {
  CreateDeviceDto,
  DeviceQueryDto,
  UpdateDeviceDto,
} from './dto/device.dto';

/** Yaratish javobi — kalit FAQAT shu yerda, bir marta ko'rinadi. */
export interface DeviceWithKey {
  device: Device;
  apiKey: string;
}

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly keys: DeviceKeyService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly pending: PendingDevicesService,
  ) {}

  async list(
    query: DeviceQueryDto,
    user?: AuthUser,
  ): Promise<PaginatedResult<Device>> {
    const settings = await this.settings.get();
    const offlineBefore = new Date(
      Date.now() - settings.offlineAfterMinutes * 60_000,
    );

    const qb = this.repo
      .createQueryBuilder('device')
      .leftJoin('device.boiler', 'boiler')
      .addSelect(['boiler.id', 'boiler.lotNumber', 'boiler.districtId'])
      .leftJoin('boiler.district', 'district')
      .addSelect(['district.id', 'district.name', 'district.shortName'])
      .orderBy('device.lastSeenAt', 'DESC', 'NULLS LAST')
      .skip(query.skip)
      .take(query.limit);

    /*
     * ⚠️ Tuman chegarasi QURILMAGA emas, uning KOTYOLIGA qo'yiladi.
     * Biriktirilmagan qurilma esa HAMMAGA ko'rinadi: u hali hech bir
     * tumanga tegishli emas va yashirilsa, operator o'z tumaniga
     * qurilma biriktira olmasdi.
     */
    if (user?.role === UserRole.OPERATOR && user.districtId) {
      qb.andWhere(
        '(boiler.district_id = :scopeDistrict OR device.boiler_id IS NULL)',
        { scopeDistrict: user.districtId },
      );
    }

    if (query.search) {
      qb.andWhere(
        '(device.device_id ILIKE :q OR device.name ILIKE :q OR boiler.lot_number ILIKE :q)',
        { q: `%${query.search}%` },
      );
    }
    if (query.isActive !== undefined) {
      qb.andWhere('device.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.unassigned) qb.andWhere('device.boiler_id IS NULL');
    if (query.offline) {
      qb.andWhere(
        '(device.last_seen_at IS NULL OR device.last_seen_at < :offlineBefore)',
        { offlineBefore },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }

  async findOne(id: string): Promise<Device> {
    const device = await this.repo.findOne({
      where: { id },
      relations: { boiler: { district: true } },
    });
    if (!device) throw new NotFoundException('Qurilma topilmadi');
    return device;
  }

  async create(dto: CreateDeviceDto, actor: AuthUser): Promise<DeviceWithKey> {
    const exists = await this.repo.existsBy({ deviceId: dto.deviceId });
    if (exists) {
      throw new ConflictException(
        `«${dto.deviceId}» identifikatorli qurilma allaqachon mavjud`,
      );
    }

    if (dto.boilerId) await this.assertBoilerAssignable(dto.boilerId, actor);

    /*
     * ⚠️ MAVJUD KALITNI QABUL QILISH shart. Proshivka allaqachon
     * yozilgan va o'rnatilgan bo'lishi mumkin (foydalanuvchi bergan
     * misol: `91abcc3d…`). Kalit majburan generatsiya qilinsa,
     * montajchi har bir qurilmani qaytadan proshivka qilishi kerak
     * bo'lardi.
     */
    const apiKey = dto.apiKey?.trim() || this.keys.generate();

    const device = this.repo.create({
      deviceId: dto.deviceId,
      name: dto.name ?? null,
      boilerId: dto.boilerId ?? null,
      apiKeyHash: this.keys.hash(apiKey),
      apiKeyPreview: this.keys.preview(apiKey),
      note: dto.note ?? null,
      isActive: true,
    });

    const saved = await this.repo.save(device);

    /*
     * ⚠️⚠️ KUTISH RO'YXATIDAGI SO'ROV O'Z-O'ZIDAN YOPILADI.
     *
     * Odatiy ish ketma-ketligi aynan shunday: montajchi platani
     * o'rnatadi → qurilma 403 oladi va «yangi qurilma so'rayapti»
     * ro'yxatiga tushadi → administrator shu ro'yxatdan ko'rib,
     * qurilmani YARATADI. Agar so'rov yopilmasa, bildirishnoma
     * qurilma allaqachon ishlab turganda ham yonib turardi va
     * administrator uni qo'lda rad etib yurishi kerak bo'lardi —
     * ya'ni ro'yxat tezda ishonchini yo'qotardi.
     *
     * ⚠️ `await` bor, lekin xato servis ichida YUTILADI: tozalash
     * ishi qurilma yaratilishini to'xtatmasligi kerak.
     */
    await this.pending.closeFor(saved.deviceId);

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'Device',
      entityId: saved.id,
      summary: `ESP32 moduli qo‘shildi: ${saved.deviceId}`,
    });

    return { device: await this.findOne(saved.id), apiKey };
  }

  async update(
    id: string,
    dto: UpdateDeviceDto,
    actor: AuthUser,
  ): Promise<Device> {
    const device = await this.findOne(id);
    const before = {
      deviceId: device.deviceId,
      boilerId: device.boilerId,
      isActive: device.isActive,
    };

    if (dto.deviceId && dto.deviceId !== device.deviceId) {
      const exists = await this.repo.existsBy({ deviceId: dto.deviceId });
      if (exists) {
        throw new ConflictException('Bunday identifikatorli qurilma bor');
      }
      device.deviceId = dto.deviceId;
    }

    if (dto.boilerId !== undefined) {
      if (dto.boilerId)
        await this.assertBoilerAssignable(dto.boilerId, actor, id);
      device.boilerId = dto.boilerId || null;
    }

    if (dto.name !== undefined) device.name = dto.name ?? null;
    if (dto.note !== undefined) device.note = dto.note ?? null;
    if (dto.isActive !== undefined) device.isActive = dto.isActive;

    const saved = await this.repo.save(device);
    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Device',
      entityId: saved.id,
      summary: `Qurilma tahrirlandi: ${saved.deviceId}`,
      before,
      after: {
        deviceId: saved.deviceId,
        boilerId: saved.boilerId,
        isActive: saved.isActive,
      },
    });
    return this.findOne(saved.id);
  }

  /**
   * KALITNI ALMASHTIRISH.
   *
   * ⚠️ Eski kalit DARHOL ishlamay qoladi — ya'ni qurilma proshivkasi
   * yangilanmaguncha tarmoqdan UZILADI. Shuning uchun bu alohida
   * ruxsat (`devices.rotate_key`) va alohida tugma: tahrirlash
   * formasining bir qismi bo'lsa, tasodifan bosilib qolardi.
   */
  async rotateKey(id: string, actor: AuthUser): Promise<DeviceWithKey> {
    const device = await this.findOne(id);
    const apiKey = this.keys.generate();

    await this.repo.update(id, {
      apiKeyHash: this.keys.hash(apiKey),
      apiKeyPreview: this.keys.preview(apiKey),
    });

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Device',
      entityId: id,
      summary: `Qurilma kaliti almashtirildi: ${device.deviceId}`,
    });

    return { device: await this.findOne(id), apiKey };
  }

  async remove(id: string, actor: AuthUser): Promise<void> {
    const device = await this.findOne(id);
    /*
     * ⚠️ Qurilma O'CHIRILADI, arxivlanmaydi — kotyoldan farqli o'laroq.
     * Sabab: telemetriya qatorlari KOTYOLGA ham ishora qiladi
     * (`boilerId` denormallashtirilgan), shuning uchun qurilma
     * o'chirilsa ham tarix kotyol kesimida saqlanib qoladi.
     */
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

  // ───────────────── ichki ─────────────────

  private async assertBoilerAssignable(
    boilerId: string,
    actor: AuthUser,
    exceptDeviceId?: string,
  ): Promise<void> {
    const boiler = await this.boilers.findOne({ where: { id: boilerId } });
    if (!boiler) throw new BadRequestException('Bunday kotyol topilmadi');
    assertDistrictAccess(actor, boiler.districtId);

    if (boiler.isArchived) {
      throw new BadRequestException(
        'Arxivlangan kotyolga qurilma biriktirib bo‘lmaydi',
      );
    }

    /*
     * ⚠️ BITTA KOTYOLGA BITTA MODUL. Ikkita modul ulansa, ularning
     * o'lchovlari navbatma-navbat kelib, kotyol holati har 30 soniyada
     * sakrab turardi — qaysi biri haqiqat ekanini hech kim bilmasdi.
     * Bir nechta modul kerak bo'lsa, ular alohida kotyol yozuvi bo'ladi.
     */
    const qb = this.repo
      .createQueryBuilder('device')
      .where('device.boiler_id = :boilerId', { boilerId });
    if (exceptDeviceId) {
      qb.andWhere('device.id <> :exceptDeviceId', { exceptDeviceId });
    }
    const busy = await qb.getOne();
    if (busy) {
      throw new ConflictException(
        `Bu kotyolga «${busy.deviceId}» moduli allaqachon biriktirilgan`,
      );
    }
  }
}
