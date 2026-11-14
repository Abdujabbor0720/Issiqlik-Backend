import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuthService } from '../auth/auth.service';
import { RoomsService } from '../rooms/rooms.service';
import { SettingsService } from '../settings/settings.service';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * KECHASI BAJARILADIGAN TOZALASH.
 *
 * ⚠️ Vaqt 03:20, Toshkent. Ikkala ish ham jadvalni bloklashi mumkin
 * va kunduzi bajarilsa, o'sha paytda kelgan telemetriya kutib qolardi.
 */
@Injectable()
export class MaintenanceJob {
  private readonly logger = new Logger(MaintenanceJob.name);

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly auth: AuthService,
    private readonly rooms: RoomsService,
    private readonly settings: SettingsService,
  ) {}

  @Cron('20 3 * * *', {
    name: 'nightly-maintenance',
    timeZone: 'Asia/Tashkent',
  })
  async run(): Promise<void> {
    try {
      const purged = await this.telemetry.purgeOld();
      // ⚠️ Xona tarixi kotyol telemetriyasi bilan AYNI muddat saqlanadi.
      const roomPurged = await this.rooms.purgeOld(
        (await this.settings.get()).retentionDays,
      );
      const tokens = await this.auth.purgeExpiredTokens();
      this.logger.log(
        `Tungi tozalash: ${purged} o‘lchov, ${roomPurged} xona o‘lchovi, ` +
          `${tokens} eskirgan token`,
      );
    } catch (error) {
      /*
       * ⚠️ Xato YUTILADI: cron ichidan ko'tarilgan istisno Node'da
       * ushlanmagan rad etish (`unhandledRejection`) bo'lib, butun
       * jarayonni to'xtatishi mumkin. Tozalash — yordamchi ish va u
       * serverni yiqitmasligi kerak.
       */
      this.logger.error(
        'Tungi tozalash bajarilmadi',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
