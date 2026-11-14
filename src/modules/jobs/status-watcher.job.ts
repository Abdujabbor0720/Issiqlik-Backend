import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BoilerStatus } from '../../common/constants/enums';
import { Boiler } from '../../database/entities/boiler.entity';
import { resolveBoilerStatus } from '../../helpers/boiler-status.helper';
import { AlertsService } from '../alerts/alerts.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.service';

/**
 * HOLAT KUZATUVCHISI — har daqiqada.
 *
 * ⚠️⚠️ BUSIZ UZILGAN QURILMA ABADIY «FAOL» BO'LIB TURARDI.
 * Kotyol holati telemetriya KELGANDA yoziladi; signal kelmay qo'ysa
 * esa uni yangilaydigan hech narsa yo'q va oxirgi issiq o'lchov
 * ekranda qolib ketardi. Ya'ni tizim aynan muammo boshlangan paytda
 * «hammasi joyida» deb turardi.
 *
 * ⚠️ Faqat HOLATI O'ZGARADIGAN qatorlar yangilanadi: 2000 ta kotyolni
 * har daqiqada qayta yozish diskni va replikatsiyani bekorga band
 * qilardi.
 */
@Injectable()
export class StatusWatcherJob {
  private readonly logger = new Logger(StatusWatcherJob.name);

  constructor(
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'boiler-status-watch',
    timeZone: 'Asia/Tashkent',
  })
  async run(): Promise<void> {
    const thresholds = await this.settings.thresholds();
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - thresholds.offlineAfterMinutes * 60_000,
    );

    /*
     * ⚠️ FAQAT nomzodlar o'qiladi: holati `offline` BO'LMAGAN va
     * oxirgi signali eskirgan kotyollar. Butun jadvalni o'qish har
     * daqiqada minglab qatorni Node xotirasiga olib kelardi.
     */
    const candidates = await this.boilers.find({
      where: [{ isArchived: false }],
      select: {
        id: true,
        lotNumber: true,
        districtId: true,
        currentStatus: true,
        lastTemperature: true,
        lastReadingAt: true,
      },
    });

    /*
     * ⚠️ Ochiq ogohlantirishi bor kotyollar BITTA so'rov bilan olinadi.
     * Usiz har bir kotyol uchun `evaluate()` chaqirish kerak bo'lardi
     * va sog'lom kotyolda bu bekorga UPDATE bo'lib, daqiqasiga minglab
     * bo'sh yozuv hosil qilardi.
     */
    const withOpenAlert = await this.alerts.openBoilerIds();

    let changed = 0;
    let evaluated = 0;

    for (const boiler of candidates) {
      const fresh = boiler.lastReadingAt && boiler.lastReadingAt > staleBefore;

      /*
       * ⚠️ Signal YANGI bo'lsa, holat allaqachon ingest'da yozilgan —
       * uni qayta hisoblash shart emas. Lekin OGOHLANTIRISH baribir
       * tekshiriladi (pastga qarang).
       */
      const next = fresh
        ? boiler.currentStatus
        : resolveBoilerStatus(
            {
              temperature: boiler.lastTemperature,
              lastReadingAt: boiler.lastReadingAt,
              now,
            },
            thresholds,
          );

      if (next !== boiler.currentStatus) {
        await this.boilers.update(boiler.id, {
          currentStatus: next,
          statusChangedAt: now,
        });

        this.realtime.emitBoilerStatus({
          boilerId: boiler.id,
          districtId: boiler.districtId,
          lotNumber: boiler.lotNumber,
          status: next,
          temperature: boiler.lastTemperature,
          at: now.toISOString(),
        });

        changed += 1;
      }

      /*
       * ⚠️⚠️ OGOHLANTIRISH HOLAT O'ZGARMASA HAM TEKSHIRILADI.
       *
       * Ilgari u faqat o'zgarish paytida chaqirilardi va shu sababli
       * JIM BO'SHLIQ paydo bo'lardi: server qayta ishga tushganda yoki
       * ma'lumot tashqaridan yozilganda (import, migratsiya, demo)
       * sovuq kotyol allaqachon `inactive` holatida turardi —
       * «o'zgarish» yo'q, demak ogohlantirish ham yo'q. Natijada
       * ekranda 18 ta ishlamayotgan kotyol ko'rinib turardi, «Diqqat
       * talab qiladi» ro'yxati esa BO'SH edi.
       *
       * Sog'lom kotyolga tegilmaydi (yuqoridagi `withOpenAlert`
       * izohiga qarang) — qo'shimcha so'rov faqat haqiqatan muammosi
       * borlar uchun ketadi.
       */
      const needsAlertCheck =
        next !== BoilerStatus.ACTIVE || withOpenAlert.has(boiler.id);

      if (needsAlertCheck) {
        await this.alerts.evaluate({
          boilerId: boiler.id,
          lotNumber: boiler.lotNumber,
          status: next,
          temperature: boiler.lastTemperature,
          now,
        });
        evaluated += 1;
      }
    }

    if (changed > 0 || evaluated > 0) {
      this.logger.log(
        `Holat kuzatuvi: ${changed} ta o‘zgardi, ` +
          `${evaluated} ta ogohlantirish tekshirildi`,
      );
    }
  }
}
