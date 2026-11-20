import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IncidentEngineService } from './incident-engine.service';

/**
 * XAVF KUZATUVCHISI — har daqiqada: solishtirish + eskalatsiya.
 *
 * ⚠️⚠️ BUSIZ VAQTGA BOG'LIQ HAMMA NARSA JIM QOLARDI: monitoring oynasi
 * ochilishi (07:00 da allaqachon sovuq xona), qurilmadan signal kelmay
 * qo'yishi (hech qanday so'rov kelmaydi — demak «hodisa» ham yo'q) va
 * eskalatsiya muddati. Tezkor yo'l (`AlertsService.changes$`) faqat
 * kechikishni qisqartiradi, bu cron esa kafolat beradi.
 *
 * ⚠️ Oldingi ishga tushish tugamagan bo'lsa — o'tkazib yuboriladi: sekin
 * baza paytida sikllar navbatga yig'ilib, bir-birini quvlamasligi kerak.
 */
@Injectable()
export class IncidentWatcherJob {
  private readonly logger = new Logger(IncidentWatcherJob.name);
  private running = false;

  constructor(private readonly engine: IncidentEngineService) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'incident-watch',
    timeZone: 'Asia/Tashkent',
  })
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.engine.runCycle();
      const changed =
        report.created +
        report.reopened +
        report.autoResolved +
        report.escalated;
      if (changed > 0) {
        this.logger.log(
          `XAVF: ${report.created} yangi, ${report.reopened} qayta ochildi, ` +
            `${report.autoResolved} avtomatik bartaraf, ${report.escalated} eskalatsiya ` +
            `(jadvaldan tashqarida: ${report.suppressed})`,
        );
      }
    } catch (error) {
      this.logger.error(
        'XAVF kuzatuvchisi yiqildi',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
