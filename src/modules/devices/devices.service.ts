import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
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
      /* ⚠️ Muassasa nomi — lot raqami ixtiyoriy: lotsiz qozonxona
         ro'yxatda faqat «Lotsiz» bo'lib, qaysi biri ekanini bilib
         bo'lmasdi. */
      .leftJoin('boiler.organization', 'boilerOrganization')
      .addSelect(['boilerOrganization.id', 'boilerOrganization.name'])
      // ⚠️ Plata yuborgan tuman — alohida taxallus (`district` kotyolniki).
      .leftJoin('device.district', 'deviceDistrict')
      .addSelect([
        'deviceDistrict.id',
        'deviceDistrict.name',
        'deviceDistrict.shortName',
      ])
      .orderBy('device.lastSeenAt', 'DESC', 'NULLS LAST')
      .skip(query.skip)
      .take(query.limit);

    /*
     * ⚠️⚠️ TUMAN CHEGARASI (biznes qarori, 2026-11-14):
     *   • biriktirilgan modul — KOTYOLINING tumani bo'yicha;
     *   • biriktirilmagan modul — PLATA YUBORGAN tuman bo'yicha: Asaka
     *     platasini faqat Asaka mas'uli ko'radi va uni adashib boshqa
     *     tuman kotyoliga ulay olmaydi.
     * Tuman yubormaydigan ESKI platalar (biriktirilmagan, tumansiz) —
     * faqat adminlarga ko'rinadi: ular qaysi tumanniki ekanini bilmaymiz.
     */
    if (user?.role === UserRole.OPERATOR && user.districtId) {
      qb.andWhere(
        '(boiler.district_id = :scopeDistrict ' +
          'OR (device.boiler_id IS NULL AND device.district_id = :scopeDistrict))',
        { scopeDistrict: user.districtId },
      );
    }

    /*
     * ⚠️ Kotyol formasidagi «Ro'yxatdagi moduldan» uchun: faqat SHU tuman
     * modullari. Tumansiz eski platalar ham qo'shiladi — ularni (operator
     * chegarasidan o'tsa) shu tumanga biriktirish mumkin.
     */
    if (query.districtId) {
      qb.andWhere(
        '(COALESCE(device.district_id, boiler.district_id) = :filterDistrict ' +
          'OR (device.district_id IS NULL AND device.boiler_id IS NULL))',
        { filterDistrict: query.districtId },
      );
    }

    if (query.search) {
      /*
       * ⚠️ `institution_hint` HAM qidiriladi — montajchi plata sozlash
       * sahifasida yozgan muassasa nomi («12-maktab»). Yuzlab
       * biriktirilmagan modul orasidan O'Z binosidagisini tuman mas'uli
       * aynan shu bo'yicha topadi: `esp32-a4cf12…` raqamini u bilmaydi.
       */
      qb.andWhere(
        '(device.device_id ILIKE :q OR device.name ILIKE :q ' +
          'OR device.institution_hint ILIKE :q OR boiler.lot_number ILIKE :q)',
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
      relations: { boiler: { district: true }, district: true },
    });
    if (!device) throw new NotFoundException('Qurilma topilmadi');
    return device;
  }

  /**
   * BITTA QURILMA — foydalanuvchi ko'ra oladigan bo'lsa.
   *
   * ⚠️ Tuman mas'uli boshqa tumandagi kotyolga biriktirilgan modulni
   * identifikator bo'yicha ochib ko'ra olmasligi kerak (404, 403 emas:
   * 403 «bunday qurilma BOR» degani). Biriktirilmagan qurilma hammaga
   * ko'rinadi — ro'yxatdagi qoida bilan AYNI.
   */
  async findOneVisible(id: string, user?: AuthUser): Promise<Device> {
    const device = await this.findOne(id);
    /*
     * ⚠️ Ro'yxatdagi qoida bilan AYNI: biriktirilgani — kotyol tumani,
     * biriktirilmagani — plata tumani bo'yicha.
     */
    const districtOfDevice = device.boiler
      ? device.boiler.districtId
      : device.districtId;
    if (
      user?.role === UserRole.OPERATOR &&
      districtOfDevice !== user.districtId
    ) {
      throw new NotFoundException('Qurilma topilmadi');
    }
    return device;
  }

  /** Serverda umumiy qurilma tokeni yoqilganmi. */
  sharedTokenEnabled(): boolean {
    return Boolean(
      this.config.get<string>('telemetry.sharedDeviceToken')?.trim(),
    );
  }

  /**
   * YANGI QURILMANI TAYYORLASH — tekshiruv + yozuv, lekin SAQLAMASDAN.
   *
   * ⚠️ Alohida, chunki uni ikki yo'l ishlatadi: oddiy yaratish va
   * «kotyol + modul bitta formada» (u o'z tranzaksiyasida saqlaydi).
   * Tekshiruv ikki nusxa bo'lsa, ular bir kuni ajralib ketardi.
   */
  async prepareNewDevice(
    dto: Pick<CreateDeviceDto, 'deviceId' | 'name' | 'apiKey' | 'note'>,
  ): Promise<{ device: Device; apiKey: string }> {
    const exists = await this.repo.existsBy({ deviceId: dto.deviceId });
    if (exists) {
      throw new ConflictException(
        `«${dto.deviceId}» identifikatorli qurilma allaqachon mavjud`,
      );
    }

    /*
     * ⚠️ MAVJUD KALITNI QABUL QILISH shart. Proshivka allaqachon
     * yozilgan va o'rnatilgan bo'lishi mumkin (foydalanuvchi bergan
     * misol: `91abcc3d…`). Kalit majburan generatsiya qilinsa,
     * montajchi har bir qurilmani qaytadan proshivka qilishi kerak
     * bo'lardi.
     */
    const personalKey = dto.apiKey?.trim();
    const apiKey = personalKey || this.keys.generate();

    const device = this.repo.create({
      deviceId: dto.deviceId,
      name: dto.name ?? null,
      boilerId: null,
      apiKeyHash: this.keys.hash(apiKey),
      apiKeyPreview: this.keys.preview(apiKey),
      note: dto.note ?? null,
      isActive: true,
      /*
       * ⚠️⚠️ UMUMIY TOKEN — SHAXSIY KALIT KIRITILMAGAN BO'LSA.
       *
       * Hozirgi proshivka (GitHub yig'adi) UMUMIY token bilan keladi.
       * Ilgari kabinetda yaratilgan qurilma `false` bilan tug'ilardi va
       * natijada u HECH QACHON ulanmasdi: token rad etilardi (401),
       * avtomatik ro'yxatga olish esa ishlamasdi — qurilma allaqachon
       * bor. Montajchi platani o'rnatib ketardi, kabinetda esa «hech
       * qachon» turaverardi.
       *
       * Shaxsiy kalit kiritilgan bo'lsa — eski, har plataga alohida
       * yozilgan proshivka: umumiy tokenga ruxsat BERILMAYDI.
       */
      allowSharedToken: !personalKey && this.sharedTokenEnabled(),
    });

    return { device, apiKey };
  }

  async create(dto: CreateDeviceDto, actor: AuthUser): Promise<DeviceWithKey> {
    const { device, apiKey } = await this.prepareNewDevice(dto);

    if (dto.boilerId) {
      await this.assertBoilerAssignable(dto.boilerId, actor);
      device.boilerId = dto.boilerId;
    }

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

    /*
     * ⚠️⚠️ JORIY KOTYOLNING TUMANI HAM TEKSHIRILADI.
     *
     * Ilgari faqat YANGI kotyol tekshirilardi. Natijada tuman mas'uli
     * BOSHQA tumandagi modulni: o'chirib qo'yishi (`isActive`),
     * kotyoldan ajratishi (`boilerId: null` — tekshiruvsiz o'tardi),
     * identifikatorini o'zgartirishi yoki o'z kotyoliga «ko'chirib»
     * olishi mumkin edi. Biriktirilmagan qurilma — hech kimniki, uni
     * har kim o'z kotyoliga biriktira oladi.
     */
    if (device.boiler) {
      assertDistrictAccess(actor, device.boiler.districtId);
    } else {
      /*
       * ⚠️ Biriktirilmagan modul — PLATA tumani bo'yicha. Tumansiz eski
       * plata (`null`) operator uchun yopiq: uni faqat admin biriktiradi.
       */
      assertDistrictAccess(actor, device.districtId);
    }

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
        await this.assertBoilerAssignable(
          dto.boilerId,
          actor,
          id,
          device.districtId,
        );
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

  async assertBoilerAssignable(
    boilerId: string,
    actor: AuthUser,
    exceptDeviceId?: string,
    deviceDistrictId?: string | null,
  ): Promise<void> {
    const boiler = await this.boilers.findOne({
      where: { id: boilerId },
      relations: { district: true },
    });
    if (!boiler) throw new BadRequestException('Bunday kotyol topilmadi');
    assertDistrictAccess(actor, boiler.districtId);

    /*
     * ⚠️⚠️ MODUL FAQAT O'Z TUMANIDAGI KOTYOLGA. Tuman platadan keladi va
     * kabinetda o'zgartirilmaydi (biznes qarori). Boshqa tumanga ulash
     * kerak bo'lsa — plata menyusida tumanni qayta tanlash kerak.
     */
    if (deviceDistrictId && deviceDistrictId !== boiler.districtId) {
      throw new BadRequestException(
        `Bu modul platada boshqa tumanga sozlangan — uni faqat o‘sha tumandagi ` +
          `kotyolga biriktirish mumkin (tanlangan kotyol: ${boiler.district?.name ?? 'boshqa tuman'})`,
      );
    }

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
