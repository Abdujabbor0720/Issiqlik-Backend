import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PendingDevice } from '../../database/entities/pending-device.entity';

export interface PendingDeviceRow {
  id: string;
  deviceId: string;
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
  ) {}

  /**
   * OCHIQ so'rovlar — eng ko'p urinib ko'rgani YUQORIDA.
   *
   * ⚠️ Saralash `attempts` bo'yicha, vaqt bo'yicha EMAS: 2000 marta
   * urinib turgan plata — dalada O'RNATILGAN va kutib turgan
   * qurilma; 3 marta urinib qolgani esa ehtimol sinov yoki tasodif.
   * Vaqt bo'yicha saralansa, eng muhim yozuv pastga tushib ketardi.
   */
  async list(): Promise<PendingDeviceRow[]> {
    const rows = await this.repo.find({
      where: { isDismissed: false },
      order: { attempts: 'DESC', lastSeenAt: 'DESC' },
      take: 200,
    });

    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      institutionHint: row.institutionHint,
      firmwareVersion: row.firmwareVersion,
      lastIpAddress: row.lastIpAddress,
      attempts: row.attempts,
      // ⚠️ Birinchi ko'rilgan vaqt — `createdAt` (BaseEntity dan).
      firstSeenAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    }));
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
