import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceType, UserRole } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import { ObjectTypeDirectoryService } from '../geo/object-type-directory.service';

export interface PendingDeviceRow {
  id: string;
  deviceId: string;
  /** `X-Device-Type` yoki tanadan aniqlangan tur. */
  deviceType: DeviceType | null;
  /** Plata aytgan tuman (tanilgan kalit) va obyekt turi — nomi bilan. */
  district: { id: string; key: string; name: string } | null;
  objectType: { id: string; code: string; name: string } | null;
  /** `institution_name` (yangi proshivka). */
  institutionName: string | null;
  /** `token_conflict` — bir bosishda ro'yxatga olib bo'lmaydi. */
  tokenConflict: boolean;
  tokenKind: 'personal' | 'shared' | null;
  tokenPreview: string | null;
  isDismissed: boolean;
  institutionHint: string | null;
  firmwareVersion: string | null;
  lastIpAddress: string | null;
  attempts: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * «YANGI QURILMA SO'RAYAPTI» RO'YXATI.
 *
 * ⚠️⚠️ BU RO'YXAT HECH QANDAY HUQUQ BERMAYDI. Unga tushgan qurilma
 * baribir 403 oladi va bitta ham o'lchov yozolmaydi. U faqat
 * MA'LUMOT: «dalada ro'yxatdan o'tmagan plata turibdi va u har
 * daqiqada urinib ko'rayapti».
 *
 * ⚠️⚠️ AVTOMATIK QABUL QILISH ATAYLAB QILINMAGAN. «Tasdiqlash»
 * tugmasi faqat yozuvni YOPADI — qurilmani administrator qo'lda
 * yaratadi, kotyolga biriktiradi va token beradi. Avtomatik
 * qo'shilsa, istalgan odam o'z ESP32'sini ulab, viloyat ma'lumotiga
 * soxta qozonxona qo'shib qo'yardi.
 */
@Injectable()
export class PendingDevicesService {
  private readonly logger = new Logger(PendingDevicesService.name);

  constructor(
    @InjectRepository(PendingDevice)
    private readonly repo: Repository<PendingDevice>,
    private readonly districts: DistrictDirectoryService,
    private readonly objectTypes: ObjectTypeDirectoryService,
  ) {}

  /**
   * OCHIQ so'rovlar — eng ko'p urinib ko'rgani YUQORIDA.
   *
   * ⚠️ Saralash `attempts` bo'yicha, vaqt bo'yicha EMAS: 2000 marta
   * urinib turgan plata — dalada O'RNATILGAN va kutib turgan
   * qurilma; 3 marta urinib qolgani esa ehtimol sinov yoki tasodif.
   * Vaqt bo'yicha saralansa, eng muhim yozuv pastga tushib ketardi.
   */
  /**
   * ⚠️⚠️ TUMAN MAS'ULI faqat plata O'Z tumanini aytgan so'rovlarni ko'radi
   * (API darajasida). Tumanini aytmagan yangi qurilmalar — faqat viloyat
   * adminiga.
   */
  async list(
    user?: AuthUser,
    includeDismissed = false,
  ): Promise<PendingDeviceRow[]> {
    const qb = this.repo
      .createQueryBuilder('pending')
      .orderBy('pending.last_seen_at', 'DESC')
      .take(200);
    if (!includeDismissed) qb.where('pending.is_dismissed = false');
    if (user?.role === UserRole.OPERATOR) {
      const own = await this.districts.byId(user.districtId);
      if (!own) {
        throw new ForbiddenException(
          'Hisobingizga tuman biriktirilmagan — administratorga murojaat qiling',
        );
      }
      qb.andWhere('pending.reported_district = :own', { own: own.key });
    }
    const rows = await qb.getMany();

    return Promise.all(
      rows.map(async (row) => {
        const district = await this.districts.byKey(row.reportedDistrict);
        const type = await this.objectTypes.resolve(row.reportedObjectType);
        return {
          id: row.id,
          deviceId: row.deviceId,
          deviceType: row.deviceType,
          district: district
            ? { id: district.id, key: district.key, name: district.name }
            : null,
          objectType: type
            ? { id: type.id, code: type.code, name: type.name }
            : null,
          institutionName: row.reportedInstitution,
          tokenConflict: row.tokenConflict,
          tokenKind: row.tokenKind,
          tokenPreview: row.tokenPreview,
          isDismissed: row.isDismissed,
          institutionHint: row.institutionHint,
          firmwareVersion: row.firmwareVersion,
          lastIpAddress: row.lastIpAddress,
          attempts: row.attempts,
          firstSeenAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
        };
      }),
    );
  }

  /** Tuman mas'uli begona tuman so'roviga tega olmaydi. */
  async assertVisible(id: string, user?: AuthUser): Promise<PendingDevice> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('So‘rov topilmadi');
    if (user?.role === UserRole.OPERATOR) {
      const own = await this.districts.byId(user.districtId);
      if (!own || row.reportedDistrict !== own.key) {
        throw new NotFoundException('So‘rov topilmadi');
      }
    }
    return row;
  }

  /** Ochiq so'rovlar soni — kabinetdagi bildirishnoma uchun. */
  async countOpen(): Promise<number> {
    return this.repo.count({ where: { isDismissed: false } });
  }

  /**
   * RAD ETISH.
   *
   * ⚠️⚠️ O'CHIRILMAYDI, BELGILANADI. O'chirilsa, qurilma keyingi
   * so'rovida yana ro'yxatda paydo bo'lib, bildirishnoma abadiy
   * qaytib turardi — begona yoki sinov platasi esa bir marta rad
   * etilgach, boshqa ko'rinmasligi kerak.
   */
  async dismiss(id: string): Promise<{ dismissed: true }> {
    const row = await this.repo.findOne({
      where: { id },
      select: { id: true, deviceId: true },
    });
    if (!row) throw new NotFoundException('So‘rov topilmadi');

    await this.repo.update(id, { isDismissed: true });
    this.logger.log(`Kutish ro‘yxatidan rad etildi: ${row.deviceId}`);
    return { dismissed: true };
  }

  /**
   * QAYTA OCHISH — rad etilgan so'rovni ro'yxatga qaytarish.
   *
   * ⚠️ Kerak bo'ladi: administrator adashib rad etishi mumkin va
   * qurilma ro'yxatda qaytib paydo bo'lishi uchun uning yana
   * urinib ko'rishini kutish shart emas.
   */
  async restore(id: string): Promise<{ restored: true }> {
    const row = await this.repo.findOne({
      where: { id },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('So‘rov topilmadi');
    await this.repo.update(id, { isDismissed: false });
    return { restored: true };
  }

  /**
   * QURILMA RO'YXATGA OLINGANDAN KEYIN so'rovni yopish.
   *
   * ⚠️ `devices.create` dan chaqiriladi: administrator qurilmani
   * yaratgandan keyin kutish ro'yxatidagi yozuv O'Z-O'ZIDAN yopilishi
   * kerak. Aks holda kabinetda «yangi qurilma so'rayapti» bildirishnomasi
   * qurilma allaqachon ishlab turganda ham yonib turardi va administrator
   * uni qo'lda rad etib yurishi kerak bo'lardi.
   *
   * ⚠️ Xato YUTILADI: bu — tozalash ishi, qurilma yaratishni
   * TO'XTATMASLIGI kerak.
   */
  async closeFor(deviceId: string): Promise<void> {
    try {
      await this.repo.update(
        { deviceId, isDismissed: false },
        { isDismissed: true },
      );
    } catch (error) {
      this.logger.warn(
        `Kutish ro‘yxatini yopib bo‘lmadi (${deviceId}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
