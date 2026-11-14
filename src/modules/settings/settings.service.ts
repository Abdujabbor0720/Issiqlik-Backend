import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../../database/entities/system-setting.entity';
import type { StatusThresholds } from '../../helpers/boiler-status.helper';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * TIZIM SOZLAMALARI.
 *
 * ⚠️ Qiymat KESHLANADI. Sabab: `resolveBoilerStatus` har telemetriya
 * signalida chaqiriladi (2000 qurilma × har 30 soniya ≈ sekundiga 66
 * marta) va har safar bazadan qator o'qish sof isrof bo'lardi. Kesh
 * YOZISH paytida tozalanadi — ya'ni sozlama o'zgarishi darhol kuchga
 * kiradi, lekin o'qish bepul bo'lib qoladi.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cached: SystemSetting | null = null;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly repo: Repository<SystemSetting>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Amaldagi sozlama. Qator yo'q bo'lsa — `.env` dagi boshlang'ich
   * qiymatlardan YARATILADI.
   *
   * ⚠️ «Topilmadi» xatosi QAYTARILMAYDI: sozlama hamma joyda kerak va
   * uning yo'qligi butun tizimni to'xtatib qo'yardi. Bo'sh bazada
   * birinchi so'rov qatorni o'zi yozadi.
   */
  async get(): Promise<SystemSetting> {
    if (this.cached) return this.cached;

    let row = await this.repo.findOne({ where: { scope: 'default' } });
    if (!row) {
      row = await this.createDefault();
      this.logger.log(
        'Tizim sozlamalari boshlang‘ich qiymatlar bilan yaratildi',
      );
    }
    this.cached = row;
    return row;
  }

  /** Holat hisoblash uchun kerakli chegaralar. */
  async thresholds(): Promise<StatusThresholds> {
    const settings = await this.get();
    return {
      activeMinC: settings.activeMinC,
      mediumMinC: settings.mediumMinC,
      criticalMinC: settings.criticalMinC,
      offlineAfterMinutes: settings.offlineAfterMinutes,
    };
  }

  async update(dto: UpdateSettingsDto): Promise<SystemSetting> {
    const current = await this.get();

    /*
     * ⚠️⚠️ `Object.assign(current, dto)` ISHLATILMAYDI. `class-transformer`
     * DTO nusxasida e'lon qilingan HAMMA maydonni yaratadi — yuborilmagani
     * `undefined` bo'ladi. `Object.assign` esa `undefined` ni ham
     * ko'chiradi va TypeORM uni `NULL` deb yozishga urinardi: faqat
     * «mavsum yorlig'i» ni o'zgartirmoqchi bo'lgan admin barcha harorat
     * chegaralarini NULL ga aylantirib, `NOT NULL` xatosiga tushardi
     * (yoki eng yomoni — holat hisoblash butunlay buzilardi).
     *
     * Shuning uchun faqat ANIQ berilgan maydonlar ko'chiriladi.
     */
    const keys: Array<keyof UpdateSettingsDto> = [
      'activeMinC',
      'mediumMinC',
      'criticalMinC',
      'overheatC',
      'minDeltaC',
      'offlineAfterMinutes',
      'normTemperature',
      'retentionDays',
      'seasonLabel',
    ];
    for (const key of keys) {
      const value = dto[key];
      if (value !== undefined) {
        (current as unknown as Record<string, unknown>)[key] = value;
      }
    }

    const saved = await this.repo.save(current);
    // ⚠️ Kesh AYNAN shu yerda tozalanadi: aks holda chegarani
    // o'zgartirgan admin natijani faqat server qayta ishga tushgandan
    // keyin ko'rardi va «sozlama ishlamayapti» degan xulosaga kelardi.
    this.cached = saved;
    return saved;
  }

  /** Testlar va bootstrap uchun. */
  invalidate(): void {
    this.cached = null;
  }

  private async createDefault(): Promise<SystemSetting> {
    const boiler = this.config.get<{
      activeMinC: number;
      mediumMinC: number;
      criticalMinC: number;
      offlineAfterMinutes: number;
      normTemperature: number;
    }>('boiler');
    const telemetry = this.config.get<{ retentionDays: number }>('telemetry');

    const row = this.repo.create({
      scope: 'default',
      activeMinC: boiler?.activeMinC ?? 50,
      mediumMinC: boiler?.mediumMinC ?? 40,
      criticalMinC: boiler?.criticalMinC ?? 20,
      overheatC: 95,
      minDeltaC: 3,
      offlineAfterMinutes: boiler?.offlineAfterMinutes ?? 15,
      normTemperature: boiler?.normTemperature ?? 60,
      retentionDays: telemetry?.retentionDays ?? 90,
      seasonLabel: null,
    });
    return this.repo.save(row);
  }
}
