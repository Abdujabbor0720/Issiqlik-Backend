import { lotRef } from '../../helpers/boiler-label.helper';
import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  AuditAction,
  BoilerStatus,
  ProbeKind,
  UserRole,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import { Device } from '../../database/entities/device.entity';
import { TelemetryReading } from '../../database/entities/telemetry-reading.entity';
import {
  type StatusThresholds,
  resolveBoilerStatus,
} from '../../helpers/boiler-status.helper';
import {
  DS18B20_MAX_C,
  DS18B20_MIN_C,
  classifyProbeReading,
} from '../../helpers/probe-reading.helper';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import {
  extractDistrictRef,
  type DistrictRecord,
} from '../../helpers/district-ref.helper';
import {
  extractRoomSamples,
  type ParsedRoomSamples,
} from '../../helpers/room-reading.helper';
import { tashkentDayStart } from '../../helpers/date.helpers';
import { applyDistrictScope } from '../../helpers/scope.helper';
import { AlertsService } from '../alerts/alerts.service';
import {
  DeviceAuthService,
  type AuthenticatedDevice,
} from '../devices/device-auth.service';
import { AuditService } from '../audit/audit.service';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import { RoomsService } from '../rooms/rooms.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.service';
import type { IngestDto } from './dto/ingest.dto';
import type { Bucket, TelemetryQueryDto } from './dto/telemetry-query.dto';

export interface IngestResult {
  ok: true;
  /** Qurilma shu javobdan keyingi signalgacha qancha kutishi mumkin. */
  nextIntervalSec: number;
  /**
   * ⚠️ `null` — FAQAT xona o'lchovi kelganda (quvur datchiklari
   * yaroqli qiymat bermagan). Kotyol holati bu holatda NOMA'LUM va
   * uni to'qib yozish mumkin emas.
   */
  status: BoilerStatus | null;
  boilerAssigned: boolean;
  /** O'lchovda qaysi datchik qatnashgani — qurilma jurnalida ko'rinadi. */
  probe: ProbeKind | null;
  /** Qabul qilingan xona o'lchovlari soni (yuborilmagan bo'lsa 0). */
  rooms: number;
}

/**
 * SARLAVHALARDAN KELGAN MA'LUMOT.
 *
 * ⚠️ Tana (`IngestDto`) dan ALOHIDA: `X-Firmware-Version` va
 * `X-Device-Id` SARLAVHALARDA keladi (`net.cpp:20-22`) va OTA'ning
 * `GET` so'rovlarida tana umuman yo'q.
 */
export interface IngestMeta {
  ip: string | null;
  /** `X-Firmware-Version` — eski proshivkada YO'Q (`null`). */
  firmwareVersion: string | null;
}

/**
 * O'LCHOV VAQTI CHEGARALARI (§3).
 *
 * ⚠️ ESP32 da real-time soat YO'Q. NTP ishlamasa, qurilma 1970-yilni
 * yoki tasodifiy vaqtni ko'rsatadi. Shuning uchun uning vaqtiga
 * ko'r-ko'rona ishonib bo'lmaydi.
 */
const MEASURED_AT_MAX_FUTURE_MS = 5 * 60_000;
const MEASURED_AT_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * UNIQUE INDEKS BUZILISHI (PostgreSQL `23505`).
 *
 * ⚠️⚠️ Bu xato tizimda IKKI joyda NORMAL holat:
 *   1) oflayn navbat ayni o'lchovni qayta yuborganda
 *      (`UQ_telemetry_device_measured_at`);
 *   2) ikki so'rov bir vaqtda yangi notanish qurilmani yozganda
 *      (`UQ_pending_devices_device_id`).
 * Ikkalasida ham natija KERAKLI holat: qator bazada. Shuning uchun
 * u xato deb ko'tarilmaydi.
 *
 * ⚠️ Kod ikki joydan o'qiladi: TypeORM xatoni `QueryFailedError` ga
 * o'raydi va asl `pg` xatosini `driverError` ichida saqlaydi, lekin
 * ayrim yo'llarda kod to'g'ridan-to'g'ri obyektda bo'ladi. Faqat
 * bittasi tekshirilsa, xato jimgina 500 bo'lib o'tib ketardi.
 */
// ⚠️ `isUniqueViolation` — `helpers/db-errors.helper.ts` (yagona manba).

export interface SeriesPoint {
  t: string;
  /** CHIQISH haroratining o'rtachasi — grafikning asosiy chizig'i. */
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
  /**
   * KIRISH (obratka) haroratining o'rtachasi — ikkinchi chiziq.
   *
   * ⚠️ `null` bo'lishi NORMAL: eski proshivkali qurilmalar kirish
   * haroratini umuman yubormaydi. Grafik bunda ikkinchi chiziqni
   * chizmaydi — nol bilan to'ldirmaydi, aks holda obratka 0 °C
   * bo'lib ko'rinib, ayirma soxta bo'lib chiqardi.
   */
  inletAvg: number | null;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(TelemetryReading)
    private readonly readings: Repository<TelemetryReading>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly auth: DeviceAuthService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly roomsService: RoomsService,
    private readonly districtDirectory: DistrictDirectoryService,
    private readonly audit: AuditService,
  ) {}

  /**
   * ESP32 DAN KELGAN SIGNAL.
   *
   * ⚠️ Bu tizimdagi eng TEZ-TEZ chaqiriladigan funksiya (sekundiga
   * o'nlab marta). Shuning uchun u ATAYLAB sodda: bitta kalit
   * tekshiruvi, bitta `INSERT`, bitta `UPDATE`. Og'ir ishlar (hisobot,
   * agregat) bu yerda EMAS — ular cron yoki so'rov paytida bajariladi.
   */
  async ingest(
    dto: IngestDto,
    apiKey: string | null,
    rawPayload: Record<string, unknown>,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    /*
     * ⚠️⚠️ AUTENTIFIKATSIYA `DeviceAuthService` DA — bu yerda NUSXA
     * YO'Q. Qurilma OTA uchun ham AYNI token bilan keladi va token
     * tekshiruvi ikki joyda bo'lsa, ular bir-biridan ajralib
     * ketishi — vaqt masalasi edi. Xavfsizlik mantig'ining ikki
     * nusxasi esa eng yomon turdagi nusxa.
     *
     * U o'zi mos HTTP xatosini tashlaydi: 401 (token yo'q/xato),
     * 403 (qurilma ro'yxatda yo'q — kutish ro'yxatiga yoziladi).
     */
    /*
     * ⚠️ TUMAN AUTENTIFIKATSIYADAN OLDIN aniqlanadi: yangi plata avtomatik
     * ro'yxatga olinsa, u darhol O'Z tumani bilan yaratiladi va boshqa
     * tuman mas'ullariga ko'rinmaydi.
     */
    const districtRaw = extractDistrictRef(rawPayload);
    const districtText =
      districtRaw === undefined ? null : sanitizeReported(districtRaw);
    const district = await this.districtDirectory.resolve(districtRaw);

    const { device } = await this.auth.authenticate(dto.deviceId, apiKey, {
      ip: meta.ip,
      firmwareVersion: meta.firmwareVersion ?? dto.firmware ?? null,
      institutionHint: dto.institutionId ?? null,
      districtId: district?.id ?? null,
      reportedDistrict: districtText,
    });

    const now = new Date();
    const ip = meta.ip?.slice(0, 45) ?? null;
    const firmware = meta.firmwareVersion ?? dto.firmware ?? null;

    /*
     * ⚠️⚠️ TUMAN SINXRONLASH — o'lchov yozilishidan OLDIN. Plata boshqa
     * tumanni yuborsa va eski tumandagi kotyolga ulangan bo'lsa, u shu
     * yerda ajratiladi (`device.boilerId = null`) va BU o'lchov ham eski
     * binoga yozilmaydi.
     */
    await this.syncDeviceDistrict(device, districtText, district);

    /*
     * ⚠️⚠️ HAROR+ATLARNI TASNIFLASH — `classifyProbeReading` da, BIR
     * joyda. Qaysi son kirish, qaysi biri chiqish ekanini aniqlash
     * tizimdagi eng xavfli qaror va u shu funksiyadan boshqa hech
     * qayerda takrorlanmaydi.
     */
    const classified = classifyProbeReading({
      inlet: dto.inletTemperature ?? null,
      outlet: dto.outletTemperature ?? null,
      single: dto.singleTemperature ?? null,
      probeHint: dto.probeHint ?? null,
    });

    /*
     * ⚠️ XONA (HAVO) O'LCHOVLARI — xom yukdan, DTO dan emas. Ular
     * QO'SHIMCHA ma'lumot: buzuq xona qismi so'rovni rad ETMAYDI
     * (`parseRoomSamples` xato tashlamaydi), faqat jurnalga yoziladi.
     */
    const roomPayload = extractRoomSamples(rawPayload);
    this.logRejectedRooms(device.deviceId, roomPayload);

    /*
     * ⚠️⚠️ YAROQSIZ O'LCHOV — 422, LEKIN QURILMA «TIRIK» DEB BELGILANADI.
     *
     * Qurilma TIRIKLIGI va O'LCHOVNING yaroqliligi — IKKI BOSHQA
     * narsa. Datchik uzilgan plata har daqiqada aloqaga chiqadi,
     * lekin yaroqli harorat bermaydi. `lastSeenAt` yangilanmasa,
     * kabinetda «qurilma o'lgan» bo'lib ko'rinardi va ta'mirchi
     * modem yoki Wi-Fi'ni tekshirib yurardi — muammo esa DATCHIKDA.
     *
     * Kotyolning `lastReadingAt` i esa YANGILANMAYDI: yaroqli o'lchov
     * yo'q, demak kotyol holati haqiqatan ham noma'lum va u belgilangan
     * muddatdan keyin «aloqa yo'q» ga o'tishi KERAK.
     */
    if (!classified) {
      await this.devices.update(device.id, {
        lastSeenAt: now,
        lastIpAddress: ip,
        ...(firmware ? { firmwareVersion: firmware } : {}),
      });

      this.logger.warn(
        `Qurilma ${device.deviceId}: yaroqli harorat yo‘q ` +
          `(kirish=${dto.inletTemperature ?? '—'}, ` +
          `chiqish=${dto.outletTemperature ?? '—'}, ` +
          `yakka=${dto.singleTemperature ?? '—'})`,
      );

      /*
       * ⚠️⚠️ QUVUR O'LCHOVI YO'Q, LEKIN XONALAR BOR — 200, 422 EMAS.
       *
       * Ikki holat: (a) quvur datchiklari uzilgan, xona datchiklari
       * ishlayapti; (b) plata faqat xonalar uchun o'rnatilgan. Ikkalasida
       * ham 422 qaytarilsa, proshivka (§3) butun yukni TASHLARDI va
       * xona haroratlari ham yo'qolardi. Kotyol holatiga TEGILMAYDI —
       * u haqiqatan noma'lum va belgilangan muddatdan keyin o'zi «aloqa
       * yo'q» ga o'tadi.
       *
       * ⚠️ Xona — faqat kotyolga biriktirilgan qurilmada (xona binoga
       * tegishli). Biriktirilmagan qurilma uchun avvalgidek 422.
       */
      if (device.boilerId && roomPayload.samples.length > 0) {
        const roomRecordedAt =
          this.resolveMeasuredAt(dto.measuredAt, now, device.deviceId) ?? now;
        const accepted = await this.ingestRooms(
          device.boilerId,
          roomPayload,
          roomRecordedAt,
          now,
        );
        return {
          ok: true,
          nextIntervalSec: 30,
          status: null,
          boilerAssigned: true,
          probe: null,
          rooms: accepted,
        };
      }

      throw new UnprocessableEntityException(
        `Harorat o‘lchov diapazonidan tashqarida (${DS18B20_MIN_C}…${DS18B20_MAX_C} °C)`,
      );
    }

    /*
     * ⚠️ TASHLANGAN QIYMATLAR DALIL: `-127` — sim uzilgan, aniq
     * nosozlik belgisi. O'lchov qabul qilindi (boshqa datchik
     * ishlayapti), lekin sabab jurnalda qolishi kerak.
     */
    if (classified.rejected.length > 0) {
      const detail = classified.rejected
        .map((item) => `${item.probe}=${item.value}`)
        .join(', ');
      this.logger.warn(
        `Qurilma ${device.deviceId}: datchik nosoz bo‘lishi mumkin (${detail})`,
      );
    }

    /*
     * ⚠️ MUASSASA SOZLAMASI O'ZGARGANINI AYTADI. Qiymatga ishonilmaydi
     * (§3), lekin u O'ZGARGANI muhim: demak platani boshqa binoga
     * ko'chirgan yoki sozlashda adashgan. Kotyol esa hamon eski
     * biriktirishda qolgan va ma'lumot NOTO'G'RI binoga yozilayapti.
     */
    if (
      dto.institutionId &&
      device.institutionHint &&
      dto.institutionId !== device.institutionHint
    ) {
      this.logger.warn(
        `Qurilma ${device.deviceId}: muassasa sozlamasi o‘zgardi ` +
          `(${device.institutionHint} → ${dto.institutionId}) — ` +
          'kotyolga biriktirishni tekshirish kerak',
      );
    }

    const measuredAt = this.resolveMeasuredAt(
      dto.measuredAt,
      now,
      device.deviceId,
    );

    /*
     * ⚠️⚠️ O'LCHOV GRAFIKDA QAYSI NUQTAGA TUSHADI. Oflayn navbatdan
     * kelgan o'lchov O'Z vaqtiga qo'yiladi, aks holda 3 soatlik
     * uzilishdan keyin barcha o'lchov bitta daqiqaga to'planib,
     * grafikda vertikal devor paydo bo'lardi.
     */
    const recordedAt = measuredAt ?? now;
    const thresholds = await this.settings.thresholds();

    /*
     * ⚠️⚠️ O'LCHOV HOLATI O'Z LAHZASIDA baholanadi (`now: recordedAt`).
     *
     * 3 soat oldingi 60 °C o'lchovi O'SHA PAYTDA «faol» edi. Agar
     * hozirgi vaqt bilan baholansa, «eskirgan» deb `offline` bo'lib
     * muhrlanardi va kechagi hisobot «kun bo'yi aloqa yo'q edi» deb
     * yolg'on ko'rsatardi.
     */
    const readingStatus = resolveBoilerStatus(
      {
        temperature: classified.outlet,
        lastReadingAt: recordedAt,
        now: recordedAt,
      },
      thresholds,
    );

    const stored = await this.storeReading({
      deviceId: device.id,
      boilerId: device.boilerId,
      // ⚠️ Asosiy ustun — DOIM chiqish harorati.
      temperature: classified.outlet,
      inletTemperature: classified.inlet,
      outletTemperature: classified.outlet,
      probe: classified.probe,
      status: readingStatus,
      recordedAt,
      measuredAt,
      rawPayload,
    });

    /*
     * ⚠️ `readingsCount` FAQAT yozilgan o'lchov uchun oshiriladi:
     * takrorlangan (idempotent rad etilgan) o'lchov hisobni
     * shishirib, «qurilma 2 barobar ko'p signal yuboryapti» degan
     * yolg'on manzara yaratardi.
     */
    await this.devices.update(device.id, {
      lastSeenAt: now,
      lastIpAddress: ip,
      ...(firmware ? { firmwareVersion: firmware } : {}),
      ...(dto.institutionId ? { institutionHint: dto.institutionId } : {}),
      ...(stored
        ? { readingsCount: (): string => '"readings_count" + 1' }
        : {}),
    });

    if (device.boilerId && stored) {
      await this.applyToBoiler({
        boilerId: device.boilerId,
        inlet: classified.inlet,
        outlet: classified.outlet,
        probe: classified.probe,
        recordedAt,
        now,
        thresholds,
      });
    }

    /*
     * ⚠️ Xonalar FAQAT yangi yozilgan o'lchovda (`stored`): takrorlangan
     * (oflayn navbat qayta yuborgan) yuk xonalarni ikkinchi marta
     * yozmasligi kerak. Kotyolga biriktirilmagan qurilmada xona
     * yaratilmaydi — u qaysi binoda ekani noma'lum; biriktirilgandan
     * keyingi birinchi signalda xonalar o'zi paydo bo'ladi.
     */
    const roomsAccepted =
      device.boilerId && stored
        ? await this.ingestRooms(device.boilerId, roomPayload, recordedAt, now)
        : 0;

    return {
      ok: true,
      rooms: roomsAccepted,
      /*
       * ⚠️ Faqat ESKI proshivka uchun ishora: v2.0.0 bu maydonni
       * o'qimaydi, uning oralig'i `config.h` da qotirilgan (60 s).
       */
      nextIntervalSec: 30,
      status: readingStatus,
      boilerAssigned: Boolean(device.boilerId),
      probe: classified.probe,
    };
  }

  /**
   * PLATA YUBORGAN TUMANNI QURILMAGA YOZISH.
   *
   * ⚠️⚠️ BIZNES QARORI (2026-11-14): tuman — plataniki, kabinetda
   * o'zgartirilmaydi. Plata BOSHQA tumanni yuborsa (qayta sozlangan yoki
   * boshqa joyga ko'chirilgan) va eski tumandagi kotyolga ulangan bo'lsa —
   * modul kotyoldan AVTOMATIK AJRATILADI. Aks holda boshqa binoning harorati
   * eski binoga yozilaverardi. Modul yangi tuman mas'ulining
   * «Biriktirilmagan» ro'yxatiga tushadi, eski kotyol esa «aloqa yo'q»
   * bo'lib, ogohlantirish beradi.
   *
   * ⚠️ Server taniy olmagan qiymat tumanni O'ZGARTIRMAYDI — faqat xom
   * qiymat saqlanadi va kabinetda ko'rinadi. Noto'g'ri kod modulni
   * «hech qaysi tumanga» chiqarib yubormasligi kerak.
   *
   * ⚠️ Yozuv faqat QIYMAT O'ZGARGANDA: har signalda UPDATE — 2000 qurilmada
   * sekundiga o'nlab bekor yozuv.
   */
  private async syncDeviceDistrict(
    device: AuthenticatedDevice,
    reported: string | null,
    district: DistrictRecord | null,
  ): Promise<void> {
    // Eski proshivka — tuman yubormaydi, hech narsa o'zgarmaydi.
    if (reported === null) return;

    if (!district) {
      if (device.reportedDistrict !== reported) {
        await this.devices.update(device.id, { reportedDistrict: reported });
        device.reportedDistrict = reported;
        this.logger.warn(
          `Qurilma ${device.deviceId}: noma‘lum tuman «${reported}» — ` +
            'tuman o‘zgartirilmadi (plata menyusidagi kodni tekshiring)',
        );
      }
      return;
    }

    if (device.districtId === district.id) {
      if (device.reportedDistrict !== reported) {
        await this.devices.update(device.id, { reportedDistrict: reported });
        device.reportedDistrict = reported;
      }
      return;
    }

    const previousDistrictId = device.districtId;
    let detached: { id: string; lotNumber: string | null } | null = null;

    if (device.boilerId) {
      const boiler = await this.boilers.findOne({
        where: { id: device.boilerId },
        select: { id: true, lotNumber: true, districtId: true },
      });
      if (boiler && boiler.districtId !== district.id) {
        /*
         * ⚠️ SHARTLI YOZUV (`boiler_id = :old`): o'qish va yozish orasida
         * admin modulni allaqachon boshqa kotyolga ko'chirgan bo'lsa, uning
         * qarori BOSIB KETILMAYDI.
         */
        const result = await this.devices
          .createQueryBuilder()
          .update()
          .set({
            boilerId: null,
            districtId: district.id,
            reportedDistrict: reported,
          })
          .where('id = :id', { id: device.id })
          .andWhere('boiler_id = :boilerId', { boilerId: boiler.id })
          .execute();
        if (result.affected) detached = boiler;
      }
    }

    if (!detached) {
      await this.devices.update(device.id, {
        districtId: district.id,
        reportedDistrict: reported,
      });
    } else {
      device.boilerId = null;
    }
    device.districtId = district.id;
    device.reportedDistrict = reported;

    if (detached) {
      this.logger.warn(
        `Qurilma ${device.deviceId}: tuman o‘zgardi → «${district.name}». ` +
          `${lotRef(detached.lotNumber)} kotyolidan AVTOMATIK ajratildi`,
      );
      await this.audit.log({
        action: AuditAction.UPDATE,
        entityName: 'Device',
        entityId: device.id,
        summary:
          `Modul ${device.deviceId} platada «${district.name}» tumani tanlangani ` +
          `uchun ${lotRef(detached.lotNumber)} kotyolidan avtomatik ajratildi`,
        before: { boilerId: detached.id, districtId: previousDistrictId },
        after: { boilerId: null, districtId: district.id },
      });
    } else if (previousDistrictId) {
      this.logger.log(
        `Qurilma ${device.deviceId}: tuman yangilandi → «${district.name}»`,
      );
    }
  }

  /**
   * XONALARNI QABUL QILISH — XATOSI YUTILADI.
   *
   * ⚠️⚠️ Bu yerdagi xato qurilmaga YETIB BORMASLIGI kerak: kotyol
   * o'lchovi allaqachon saqlangan, xatoni qaytarish esa qurilmani AYNI
   * yukni qayta-qayta yuborishga majburlardi (oflayn navbat). Xona —
   * qo'shimcha ma'lumot; uning yo'qolishi jurnalda ko'rinadi.
   *
   * @returns Joriy qiymati yangilangan xonalar soni.
   */
  private async ingestRooms(
    boilerId: string,
    payload: ParsedRoomSamples,
    recordedAt: Date,
    now: Date,
  ): Promise<number> {
    if (payload.samples.length === 0) return 0;
    try {
      const boiler = await this.boilers.findOne({
        where: { id: boilerId },
        select: { id: true, lotNumber: true },
      });
      if (!boiler) return 0;

      const result = await this.roomsService.ingest({
        boilerId,
        lotNumber: boiler.lotNumber,
        samples: payload.samples,
        recordedAt,
        now,
      });
      if (result.created > 0) {
        this.logger.log(
          `${lotRef(boiler.lotNumber)}: ${result.created} ta yangi xona ` +
            'avtomatik yaratildi — kabinetda nomlash kerak',
        );
      }
      return result.updated;
    } catch (error) {
      this.logger.warn(
        `Xona o‘lchovlari yozilmadi (kotyol ${boilerId}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return 0;
    }
  }

  /**
   * RAD ETILGAN XONA QIYMATLARI — DALIL.
   *
   * ⚠️ Faqat kalit va sabab yoziladi: qiymat qurilmadan kelgan ixtiyoriy
   * matn bo'lishi mumkin va jurnalni (yoki terminalni) buzmasligi uchun
   * qisqartiriladi.
   */
  private logRejectedRooms(deviceId: string, payload: ParsedRoomSamples): void {
    if (payload.rejected.length === 0) return;
    const detail = payload.rejected
      .slice(0, 8)
      .map(
        (item) =>
          `${item.key ?? '?'}=${String(item.value)
            .slice(0, 16)
            // ⚠️ Boshqaruv belgilari (`\n`) jurnalda SOXTA qator yasardi.
            .replace(/[\u0000-\u001f\u007f]/g, '?')} (${item.reason})`,
      )
      .join(', ');
    const more =
      payload.rejected.length > 8
        ? ` va yana ${payload.rejected.length - 8}`
        : '';
    this.logger.warn(
      `Qurilma ${deviceId}: xona qiymatlari rad etildi — ${detail}${more}`,
    );
  }

  /**
   * QURILMA AYTGAN O'LCHOV VAQTINI TEKSHIRISH.
   *
   * ⚠️⚠️ CHEGARADAN CHIQQAN VAQT O'LCHOVNI RAD ETMAYDI, faqat
   * E'TIBORSIZ qoldiriladi va server vaqti ishlatiladi. Sabab:
   * ESP32 da real-time soat YO'Q. NTP ishlamasa, qurilma 1970-yilni
   * ko'rsatadi — lekin HARORAT YAROQLI. Yaxshi o'lchovni buzuq soat
   * uchun tashlab yuborish ma'lumotni behuda yo'qotardi.
   *
   * ⚠️ Qaytgan `null` IKKINCHI vazifani ham bajaradi: `measured_at`
   * yozilmasa, takrorlanishdan himoya qiluvchi qisman unique indeks
   * bu qatorga TEGMAYDI — va bu to'g'ri, chunki ishonchsiz vaqt
   * bo'yicha takrorni aniqlab bo'lmaydi.
   */
  private resolveMeasuredAt(
    raw: string | undefined,
    now: Date,
    deviceId: string,
  ): Date | null {
    if (!raw) return null;

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.warn(`Qurilma ${deviceId}: o‘lchov vaqti o‘qilmadi (${raw})`);
      return null;
    }

    const drift = parsed.getTime() - now.getTime();

    if (drift > MEASURED_AT_MAX_FUTURE_MS) {
      this.logger.warn(
        `Qurilma ${deviceId}: o‘lchov vaqti KELAJAKDA ` +
          `(${Math.round(drift / 60_000)} daqiqa) — server vaqti ishlatiladi`,
      );
      return null;
    }

    if (-drift > MEASURED_AT_MAX_AGE_MS) {
      this.logger.warn(
        `Qurilma ${deviceId}: o‘lchov vaqti 24 soatdan eski ` +
          `(${Math.round(-drift / 3_600_000)} soat) — server vaqti ishlatiladi`,
      );
      return null;
    }

    return parsed;
  }

  /**
   * O'LCHOVNI YOZISH — IDEMPOTENT.
   *
   * ⚠️⚠️ TAKROR XATO EMAS, NORMAL HOLAT. Oflayn navbatdagi qurilma
   * 2xx javobini olmaguncha AYNI o'lchovni qayta yuboradi
   * (`main.cpp` dagi `queueFlush`). Javob yo'lda yo'qolsa, o'lchov
   * allaqachon yozilgan bo'lib, ikkinchi urinish unique indeksga
   * uriladi.
   *
   * ⚠️⚠️ Agar bu xato yuqoriga ko'tarilsa, qurilma 500 olardi va
   * o'lchovni YANA yuborardi — CHEKSIZ. Shuning uchun takror
   * «muvaffaqiyat» deb qaytariladi: natija aynan o'sha — o'lchov
   * bazada.
   *
   * @returns `true` — yangi qator yozildi; `false` — allaqachon bor edi.
   */
  private async storeReading(row: Record<string, unknown>): Promise<boolean> {
    try {
      await this.readings.insert(row);
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      this.logger.debug(
        'Takrorlangan o‘lchov e‘tiborsiz qoldirildi (oflayn navbat qayta yubordi)',
      );
      return false;
    }
  }

  /**
   * KOTYOLNING JORIY HOLATINI YANGILASH.
   *
   * ⚠️ Holat O'ZGARGANDAGINA `statusChangedAt` yoziladi: aks holda
   * «3 soatdan beri sovuq» degan ko'rsatkich har signalda nolga
   * qaytib, hech qachon o'smasdi.
   */
  private async applyToBoiler(input: {
    boilerId: string;
    inlet: number | null;
    outlet: number | null;
    probe: ProbeKind;
    recordedAt: Date;
    now: Date;
    thresholds: StatusThresholds;
  }): Promise<void> {
    const boiler = await this.boilers.findOne({
      where: { id: input.boilerId },
      select: {
        id: true,
        lotNumber: true,
        districtId: true,
        currentStatus: true,
        statusChangedAt: true,
        lastReadingAt: true,
      },
    });
    if (!boiler) return;

    /*
     * ⚠️⚠️ ESKIRGAN O'LCHOV JORIY HOLATNI O'ZGARTIRMAYDI.
     *
     * Oflayn navbatdan 3 soat oldingi 60 °C o'lchovi kelishi mumkin.
     * Agar u joriy holatga yozilsa, HOZIR sovib qolgan kotyol
     * «faol ishlayotgan» bo'lib yonib turardi va `lastReadingAt`
     * «hozirgina» ga siljib, «aloqa yo'q» ogohlantirishi ham
     * yopilardi. Ya'ni eski ma'lumot yangisini BOSIB ketardi —
     * monitoring tizimida mumkin bo'lmagan xato.
     *
     * O'lchovning O'ZI baribir saqlangan va grafikda o'z joyida
     * turadi; bu yerda faqat «joriy holat» yangilanmaydi.
     */
    if (
      boiler.lastReadingAt &&
      boiler.lastReadingAt.getTime() >= input.recordedAt.getTime()
    ) {
      this.logger.debug(
        `${lotRef(boiler.lotNumber)}: eskirgan o‘lchov (${input.recordedAt.toISOString()}) ` +
          'joriy holatga yozilmadi',
      );
      return;
    }

    /*
     * ⚠️ JORIY holat HOZIRGI vaqt bilan baholanadi (`now`), o'lchov
     * muhri esa o'z lahzasi bilan (`ingest` da). Ikkisi boshqa
     * savolga javob beradi: «hozir qanday?» va «o'sha paytda qanday
     * edi?».
     */
    const status = resolveBoilerStatus(
      {
        temperature: input.outlet,
        lastReadingAt: input.recordedAt,
        now: input.now,
      },
      input.thresholds,
    );

    const statusChanged = boiler.currentStatus !== status;
    const todayAvg = await this.todayAverage(input.boilerId);

    /*
     * ⚠️⚠️ `WHERE` DA HAM ESKIRGANLIK TEKSHIRUVI BOR. Yuqoridagi
     * `if` o'qigandan keyin yozishgacha bo'lgan oraliqda boshqa
     * so'rov yangiroq o'lchov yozib qo'ygan bo'lishi mumkin (ikki
     * qurilma bitta kotyolga biriktirilgan bo'lsa yoki navbat
     * bo'shatilayotganda). Shartsiz `UPDATE` o'sha yangi qiymatni
     * eskisi bilan bosib ketardi.
     */
    const result = await this.boilers
      .createQueryBuilder()
      .update()
      .set({
        // ⚠️ Asosiy ustun — DOIM chiqish harorati.
        lastTemperature: input.outlet,
        lastOutletTemperature: input.outlet,
        /*
         * ⚠️ Kirish qiymati YO'Q bo'lsa, `null` YOZILADI — eski
         * qiymat SAQLANMAYDI. Sabab: kirish datchigi hozir
         * ishlamayapti va eski qiymat yangi chiqish harorati bilan
         * yonma-yon turib, SOXTA ayirma («delta») berardi —
         * ya'ni «sirkulyatsiya bor» degan yolg'on xulosa.
         */
        lastInletTemperature: input.inlet,
        lastReadingAt: input.recordedAt,
        currentStatus: status,
        ...(statusChanged ? { statusChangedAt: input.now } : {}),
        todayAvgTemperature: todayAvg,
      })
      .where('id = :id', { id: input.boilerId })
      .andWhere('(last_reading_at IS NULL OR last_reading_at < :recordedAt)', {
        recordedAt: input.recordedAt,
      })
      .execute();

    // ⚠️ Poyga: boshqa so'rov yangiroq o'lchov yozib ketdi — to'xtaymiz.
    if (!result.affected) return;

    /*
     * OGOHLANTIRISH — holatga qarab ochiladi yoki yopiladi.
     *
     * ⚠️⚠️ XATO YUTILADI va bu ATAYLAB. Ogohlantirish — YON TA'SIR:
     * o'lchov allaqachon yozilgan va kotyol holati yangilangan.
     * Ikki signal bir vaqtda kelsa, ikkalasi ham «ochiq qator yo'q»
     * deb ko'rib, bir xil qator yozishga urinishi mumkin — qisman
     * unique indeks (`UQ_alerts_open_per_type`) ikkinchisini rad
     * etadi. Agar shu xato yuqoriga ko'tarilsa, QURILMA 409 javobini
     * olardi va proshivka uni «yuborilmadi» deb o'qib, o'lchovni
     * qaytadan yuborardi — holbuki u allaqachon saqlangan.
     */
    try {
      await this.alerts.evaluate({
        boilerId: input.boilerId,
        lotNumber: boiler.lotNumber,
        status,
        temperature: input.outlet,
        inletTemperature: input.inlet,
        probe: input.probe,
        minDeltaC: (await this.settings.get()).minDeltaC,
        now: input.now,
      });
    } catch (error) {
      this.logger.warn(
        `Ogohlantirish yozilmadi (${lotRef(boiler.lotNumber)}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    /*
     * ⚠️ WebSocket xabari HOLAT O'ZGARGANDA yuboriladi, har signalda
     * EMAS. 2000 qurilma × har 30 soniya = sekundiga 66 ta xabar;
     * ochiq dashboard shuncha yangilanishni qayta chizishga ulgurmas
     * va brauzer qotib qolardi. Holat o'zgarishi esa kuniga bir necha
     * marta bo'ladi va aynan shu — ko'rilishi kerak bo'lgan hodisa.
     */
    if (statusChanged) {
      this.realtime.emitBoilerStatus({
        boilerId: input.boilerId,
        districtId: boiler.districtId,
        lotNumber: boiler.lotNumber,
        status,
        temperature: input.outlet,
        at: input.now.toISOString(),
      });
    }
  }

  /** Bugungi (Toshkent kuni) o'rtacha harorat. */
  private async todayAverage(boilerId: string): Promise<number | null> {
    const row = await this.readings
      .createQueryBuilder('reading')
      .select('AVG(reading.temperature)', 'avg')
      .where('reading.boiler_id = :boilerId', { boilerId })
      .andWhere('reading.recorded_at >= :dayStart', {
        dayStart: tashkentDayStart(),
      })
      .getRawOne<{ avg: string | null }>();

    return row?.avg === null || row?.avg === undefined
      ? null
      : Math.round(Number(row.avg) * 100) / 100;
  }

  // ───────────────── O'qish ─────────────────

  /**
   * GRAFIK QATORI.
   *
   * ⚠️ Agregat BAZADA bajariladi (`date_trunc` + `AVG`), kodda EMAS.
   * Bir oylik ma'lumot bitta kotyol uchun ~86 000 qator: ularni
   * Node'ga olib kelib o'rtachasini hisoblash xotirani ham, tarmoqni
   * ham bekorga band qilardi. Baza esa indeksdan o'qib, 30 ta qator
   * qaytaradi.
   */
  async series(
    query: TelemetryQueryDto,
    user?: AuthUser,
  ): Promise<SeriesPoint[]> {
    const { from, to } = this.resolveRange(query);

    if (query.bucket === 'raw') {
      const qb = this.readings
        .createQueryBuilder('reading')
        .select('reading.recorded_at', 't')
        .addSelect('reading.temperature', 'avg')
        .addSelect('reading.temperature', 'min')
        .addSelect('reading.temperature', 'max')
        .addSelect('reading.inlet_temperature', 'inletAvg')
        .addSelect('1', 'count')
        .where('reading.recorded_at BETWEEN :from AND :to', { from, to })
        .orderBy('reading.recordedAt', 'ASC')
        .limit(query.limit);

      this.applyScope(qb, query, user);
      const rows = await qb.getRawMany<Record<string, unknown>>();
      return rows.map((row) => this.toPoint(row));
    }

    const unit: Record<Exclude<Bucket, 'raw'>, string> = {
      hour: 'hour',
      day: 'day',
    };

    const qb = this.readings
      .createQueryBuilder('reading')
      .select(`date_trunc('${unit[query.bucket]}', reading.recorded_at)`, 't')
      .addSelect('AVG(reading.temperature)', 'avg')
      .addSelect('MIN(reading.temperature)', 'min')
      .addSelect('MAX(reading.temperature)', 'max')
      /*
       * ⚠️ `AVG` NULL larni O'TKAZIB YUBORADI (SQL semantikasi) —
       * aynan kerakli xatti-harakat: kirish harorati bo'lmagan
       * o'lchovlar o'rtachani PASAYTIRMAYDI. `COALESCE(...,0)`
       * yozilsa, bitta eski proshivkali qurilma butun tuman
       * o'rtachasini nolga tortardi.
       */
      .addSelect('AVG(reading.inlet_temperature)', 'inletAvg')
      .addSelect('COUNT(*)', 'count')
      .where('reading.recorded_at BETWEEN :from AND :to', { from, to })
      .groupBy('1')
      .orderBy('1', 'ASC')
      .limit(query.limit);

    this.applyScope(qb, query, user);
    const rows = await qb.getRawMany<Record<string, unknown>>();
    return rows.map((row) => this.toPoint(row));
  }

  /** Bitta kotyolning oxirgi o'lchovlari — jadval ko'rinishi uchun. */
  async recent(boilerId: string, limit: number): Promise<TelemetryReading[]> {
    return this.readings.find({
      where: { boilerId },
      order: { recordedAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  /**
   * ESKI O'LCHOVLARNI TOZALASH — kunlik cron chaqiradi.
   *
   * ⚠️ `DELETE` BO'LAKLAB bajariladi. Bir urinishda million qator
   * o'chirilsa, tranzaksiya uzoq ochiq qolib butun jadvalni bloklardi
   * va shu paytda kelgan telemetriya rad etilardi.
   */
  async purgeOld(): Promise<number> {
    const settings = await this.settings.get();
    const cutoff = new Date(
      Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000,
    );

    let deleted = 0;
    for (let batch = 0; batch < 50; batch += 1) {
      const result = await this.readings
        .createQueryBuilder()
        .delete()
        .where(
          'id IN (SELECT id FROM telemetry_readings WHERE recorded_at < :cutoff LIMIT 10000)',
          { cutoff },
        )
        .execute();
      const affected = result.affected ?? 0;
      deleted += affected;
      if (affected === 0) break;
    }

    if (deleted > 0) {
      this.logger.log(`Eski telemetriya tozalandi: ${deleted} qator`);
    }
    return deleted;
  }

  /** Oxirgi sutkadagi signal soni — «tizim tirikmi» ko'rsatkichi. */
  async countLast24h(): Promise<number> {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.readings.count({
      where: { recordedAt: Between(from, new Date()) },
    });
  }

  // ───────────────── ichki ─────────────────

  private applyScope(
    qb: ReturnType<Repository<TelemetryReading>['createQueryBuilder']>,
    query: TelemetryQueryDto,
    user?: AuthUser,
  ): void {
    if (query.boilerId) {
      qb.andWhere('reading.boiler_id = :boilerId', {
        boilerId: query.boilerId,
      });
    }
    /*
     * ⚠️ Tuman bo'yicha filtr KOTYOLGA JOIN qilishni talab qiladi va
     * u faqat KERAK BO'LGANDA qo'shiladi: har so'rovda qotirib
     * qo'yilsa, bitta kotyolning grafigini chizish ham million qatorli
     * jadvalni kotyollar jadvaliga ulardi.
     */
    const needsJoin =
      Boolean(query.districtIds?.length) || user?.role === UserRole.OPERATOR;

    if (needsJoin) {
      qb.innerJoin('boilers', 'b', 'b.id = reading.boiler_id');
      if (query.districtIds?.length) {
        qb.andWhere('b.district_id IN (:...districtIds)', {
          districtIds: query.districtIds,
        });
      }
      applyDistrictScope(qb, user, 'b.district_id');
    }
  }

  private resolveRange(query: TelemetryQueryDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date();
    const defaultSpanMs =
      query.bucket === 'day' ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - defaultSpanMs);
    return { from, to };
  }

  private toPoint(row: Record<string, unknown>): SeriesPoint {
    const num = (value: unknown): number | null =>
      value === null || value === undefined
        ? null
        : Math.round(Number(value) * 100) / 100;

    return {
      t: new Date(row.t as string).toISOString(),
      avg: num(row.avg),
      min: num(row.min),
      max: num(row.max),
      count: Number(row.count ?? 0),
      inletAvg: num(row.inletAvg),
    };
  }
}

/**
 * Plata yuborgan xom tuman qiymati — saqlash va jurnal uchun.
 *
 * ⚠️ Boshqaruv belgilari olib tashlanadi (jurnalda soxta qator
 * yasalmasin) va 64 belgigacha qisqartiriladi (ustun hajmi).
 */
function sanitizeReported(raw: unknown): string | null {
  const text =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return clean || null;
}
