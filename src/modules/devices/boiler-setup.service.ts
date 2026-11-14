import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../../common/constants/enums';
import { PERMISSIONS } from '../../common/constants/permissions';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import { Device } from '../../database/entities/device.entity';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { AuditService } from '../audit/audit.service';
import { BoilersService } from '../boilers/boilers.service';
import { DevicesService } from './devices.service';
import { BoilerSetupDto, SetupDeviceMode } from './dto/boiler-setup.dto';
import { PendingDevicesService } from './pending-devices.service';

export interface BoilerSetupResult {
  boiler: Boiler;
  device: Device | null;
  /**
   * Shaxsiy kalit — FAQAT umumiy token o'chiq bo'lganda va faqat shu
   * javobda. Umumiy token yoqilgan bo'lsa `null`: kalit kerak emas va
   * keraksiz sirni ekranga chiqarish — sirni oshkor qilish.
   */
  apiKey: string | null;
  organizationCreated: boolean;
}

/**
 * KOTYOL + MODUL BITTA FORMADA.
 *
 * ⚠️⚠️ TEKSHIRUVLAR NUSXA EMAS: kotyolniki `BoilersService.prepareNew`,
 * qurilmaniki `DevicesService.prepareNewDevice` dan olinadi. Bu servis
 * faqat ularni BITTA tranzaksiyada saqlaydi.
 *
 * ⚠️ Audit TRANZAKSIYADAN KEYIN yoziladi: ichida yozilsa va
 * tranzaksiya orqaga qaytsa, jurnalda MAVJUD BO'LMAGAN kotyol haqida
 * «qo'shildi» yozuvi qolardi (audit o'z ulanishida yozadi).
 */
@Injectable()
export class BoilerSetupService {
  private readonly logger = new Logger(BoilerSetupService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(ObjectType)
    private readonly objectTypes: Repository<ObjectType>,
    private readonly boilers: BoilersService,
    private readonly devices: DevicesService,
    private readonly pending: PendingDevicesService,
    private readonly audit: AuditService,
  ) {}

  async setup(
    dto: BoilerSetupDto,
    actor: AuthUser,
  ): Promise<BoilerSetupResult> {
    this.assertDevicePermission(dto, actor);
    await this.assertOrganizationInput(dto);

    // ───────── Tekshiruvlar (tranzaksiyadan OLDIN, faqat o'qish) ─────────
    const boiler = await this.boilers.prepareNew(dto.boiler, actor);

    let existing: Device | null = null;
    let prepared: { device: Device; apiKey: string } | null = null;

    if (dto.device.mode === SetupDeviceMode.EXISTING) {
      existing = await this.devices.findOneVisible(
        dto.device.existingId as string,
        actor,
      );
      if (existing.boilerId) {
        throw new ConflictException(
          `«${existing.deviceId}» moduli allaqachon boshqa kotyolga biriktirilgan`,
        );
      }
      if (!existing.isActive) {
        throw new BadRequestException(
          `«${existing.deviceId}» moduli o‘chirilgan — avval uni yoqing`,
        );
      }
      /*
       * ⚠️⚠️ MODUL FAQAT O'Z TUMANIDAGI KOTYOLGA (biznes qarori): tuman
       * platadan keladi va kabinetda o'zgartirilmaydi.
       */
      if (
        existing.districtId &&
        existing.districtId !== dto.boiler.districtId
      ) {
        throw new BadRequestException(
          `«${existing.deviceId}» moduli platada «${existing.district?.name ?? 'boshqa'}» ` +
            'tumaniga sozlangan — kotyol ham shu tumanda bo‘lishi kerak',
        );
      }
    } else if (dto.device.mode === SetupDeviceMode.NEW) {
      prepared = await this.devices.prepareNewDevice({
        deviceId: dto.device.deviceId as string,
        name: dto.device.name,
      });
    }

    // ───────── Yozish — BITTA tranzaksiya ─────────
    let organizationCreated = false;
    let savedBoiler: Boiler;
    let savedDevice: Device | null = null;

    try {
      ({ savedBoiler, savedDevice, organizationCreated } =
        await this.dataSource.transaction(async (manager) => {
          let created = false;

          if (dto.newOrganizationName) {
            const found = await manager
              .getRepository(Organization)
              .createQueryBuilder('org')
              .where('LOWER(org.name) = LOWER(:name)', {
                name: dto.newOrganizationName,
              })
              .getOne();

            if (found) {
              /*
               * ⚠️ Arxivlangan nom QAYTA TIRILTIRILMAYDI: uni admin
               * ongli ravishda arxivlagan. Tuman mas'uli buni
               * bilmasdan bekor qilib qo'ymasligi kerak.
               */
              if (found.isArchived) {
                throw new BadRequestException(
                  `«${found.name}» muassasasi arxivlangan — administratorga murojaat qiling`,
                );
              }
              boiler.organizationId = found.id;
            } else {
              const organization = await manager
                .getRepository(Organization)
                .save(
                  manager.getRepository(Organization).create({
                    name: dto.newOrganizationName,
                    objectTypeId: dto.newOrganizationTypeId ?? null,
                    note: null,
                    phone: null,
                    isArchived: false,
                  }),
                );
              boiler.organizationId = organization.id;
              created = true;
            }
          }

          const boilerRow = await manager.getRepository(Boiler).save(boiler);

          let deviceRow: Device | null = null;

          if (existing) {
            /*
             * ⚠️⚠️ SHARTLI YOZUV: `boiler_id IS NULL`. Tekshiruvdan keyin
             * boshqa foydalanuvchi AYNI modulni o'z kotyoliga biriktirib
             * ulgurgan bo'lishi mumkin. Shartsiz yozuv uni jimgina
             * «tortib olardi» — ikkinchi kotyol modulsiz qolar, uning
             * egasi esa sababini bilmasdi.
             */
            const result = await manager
              .createQueryBuilder()
              .update(Device)
              .set({ boilerId: boilerRow.id })
              .where('id = :id', { id: existing.id })
              .andWhere('boiler_id IS NULL')
              .execute();
            if (!result.affected) {
              throw new ConflictException(
                `«${existing.deviceId}» moduli shu orada boshqa kotyolga biriktirildi`,
              );
            }
            deviceRow = existing;
            deviceRow.boilerId = boilerRow.id;
          }

          if (prepared) {
            prepared.device.boilerId = boilerRow.id;
            deviceRow = await manager
              .getRepository(Device)
              .save(prepared.device);
          }

          return {
            savedBoiler: boilerRow,
            savedDevice: deviceRow,
            organizationCreated: created,
          };
        }));
    } catch (error) {
      /*
       * ⚠️ Yagonalik buzilishi = POYGA: tekshiruvdan keyin boshqa
       * foydalanuvchi AYNI qurilma identifikatori, AYNI muassasa nomi
       * yoki AYNI modul biriktirishini yozib ulgurgan. Tranzaksiya
       * to'liq orqaga qaytdi — hech narsa yarim yozilmagan. 500 emas,
       * tushunarli 409.
       */
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Ma‘lumot shu orada boshqa foydalanuvchi tomonidan qo‘shildi — ' +
            'sahifani yangilab, qaytadan urinib ko‘ring',
        );
      }
      throw error;
    }

    // ───────── Tranzaksiyadan keyin ─────────
    await this.writeAudit(
      actor,
      dto,
      savedBoiler,
      savedDevice,
      existing,
      organizationCreated,
    );

    if (prepared && savedDevice) {
      // «Yangi qurilma so'rayapti» bildirishnomasi o'z-o'zidan yopiladi.
      await this.pending.closeFor(savedDevice.deviceId);
    }

    return {
      boiler: await this.boilers.findOne(savedBoiler.id, actor),
      device: savedDevice ? await this.devices.findOne(savedDevice.id) : null,
      apiKey:
        prepared && !prepared.device.allowSharedToken ? prepared.apiKey : null,
      organizationCreated,
    };
  }

  /**
   * MODUL QISMI UCHUN RUXSAT.
   *
   * ⚠️⚠️ Endpoint faqat `boilers.create` ni talab qiladi — modul qismi
   * ichkarida ALOHIDA tekshiriladi. Aks holda kotyol yaratish huquqi
   * bor, lekin qurilma yaratish huquqi yo'q foydalanuvchi shu forma
   * orqali qurilma yaratib, huquqni chetlab o'tardi.
   */
  private assertDevicePermission(dto: BoilerSetupDto, actor: AuthUser): void {
    const needed =
      dto.device.mode === SetupDeviceMode.NEW
        ? PERMISSIONS.DEVICES_CREATE
        : dto.device.mode === SetupDeviceMode.EXISTING
          ? PERMISSIONS.DEVICES_UPDATE
          : null;
    if (needed && !actor.permissions.includes(needed)) {
      throw new ForbiddenException('Modul qo‘shish uchun ruxsatingiz yo‘q');
    }
  }

  private async assertOrganizationInput(dto: BoilerSetupDto): Promise<void> {
    if (dto.newOrganizationName && dto.boiler.organizationId) {
      throw new BadRequestException(
        'Muassasa ro‘yxatdan TANLANGAN yoki YANGI kiritilgan bo‘lishi kerak — ikkalasi birga emas',
      );
    }

    // ⚠️ Mavjud bo'lmagan id FK xatosi bilan 500 qaytarardi.
    if (dto.boiler.organizationId) {
      const organization = await this.organizations.findOne({
        where: { id: dto.boiler.organizationId },
        select: { id: true, isArchived: true },
      });
      if (!organization) {
        throw new BadRequestException('Tanlangan muassasa topilmadi');
      }
    }

    if (dto.newOrganizationTypeId) {
      if (!dto.newOrganizationName) {
        throw new BadRequestException(
          'Muassasa turi faqat yangi muassasa bilan birga beriladi',
        );
      }
      const exists = await this.objectTypes.existsBy({
        id: dto.newOrganizationTypeId,
        isArchived: false,
      });
      if (!exists) throw new BadRequestException('Muassasa turi topilmadi');
    }
  }

  private async writeAudit(
    actor: AuthUser,
    dto: BoilerSetupDto,
    boiler: Boiler,
    device: Device | null,
    existing: Device | null,
    organizationCreated: boolean,
  ): Promise<void> {
    if (organizationCreated && boiler.organizationId) {
      await this.audit.log({
        actor,
        action: AuditAction.CREATE,
        entityName: 'Organization',
        entityId: boiler.organizationId,
        summary: `Muassasa qo‘shildi (kotyol formasidan): ${dto.newOrganizationName}`,
      });
    }

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'Boiler',
      entityId: boiler.id,
      summary:
        `Kotyol qo‘shildi: lot ${boiler.lotNumber}` +
        (device ? ` (modul: ${device.deviceId})` : ''),
      after: { lotNumber: boiler.lotNumber, boilerCount: boiler.boilerCount },
    });

    if (device && existing) {
      await this.audit.log({
        actor,
        action: AuditAction.UPDATE,
        entityName: 'Device',
        entityId: device.id,
        summary: `Modul kotyolga biriktirildi: ${device.deviceId} → lot ${boiler.lotNumber}`,
        before: { boilerId: null },
        after: { boilerId: boiler.id },
      });
    } else if (device) {
      await this.audit.log({
        actor,
        action: AuditAction.CREATE,
        entityName: 'Device',
        entityId: device.id,
        summary: `ESP32 moduli qo‘shildi: ${device.deviceId} → lot ${boiler.lotNumber}`,
      });
    }
  }
}
