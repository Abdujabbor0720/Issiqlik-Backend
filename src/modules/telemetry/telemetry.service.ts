import { lotRef } from '../../helpers/boiler-label.helper';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
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
  AIR_MAX_C,
  AIR_MIN_C,
  extractRoomSamples,
  normalizeRoomKey,
  type ParsedRoomSamples,
  type RoomSample,
} from '../../helpers/room-reading.helper';
import {
  extractReportedProfile,
  inferDeviceType,
  normalizeInstitutionName,
  type ReportedProfile,
} from '../../helpers/device-profile.helper';
import { tashkentDayStart } from '../../helpers/date.helpers';
import { applyDistrictScope } from '../../helpers/scope.helper';
import { AlertsService } from '../alerts/alerts.service';
import {
  DeviceAuthService,
  type AuthenticatedDevice,
} from '../devices/device-auth.service';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import {
  ObjectTypeDirectoryService,
  type ObjectTypeRecord,
} from '../geo/object-type-directory.service';
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
  /** `X-Module-Type` (xom) — qozonxona proshivkasida YO'Q. */
  deviceTypeHeader?: string | null;
}

/** Plata aytgan va TEKSHIRILGAN joylashuv (noma'lum kalitlar `ignored` da). */
interface ReportedLocation {
  district: DistrictRecord | null;
  objectType: ObjectTypeRecord | null;
  institution: string | null;
  ignored: string[];
}

/** Bir xil ogohlantirish bitta qurilma uchun shundan tez-tez yozilmaydi. */
const PROFILE_WARN_INTERVAL_MS = 30 * 60_000;

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

export interface DeviceSeriesPoint {
  t: string;
  /** Kirish (obratka), °C — kotyol moduli. */
  inlet: number | null;
  /** Chiqish (podacha), °C — kotyol moduli. */
  outlet: number | null;
  /** Xona havosi, °C — xona moduli. */
  room: number | null;
  /** Namlik, % — xona moduli (proshivka yuborsa). */
  humidity: number | null;
  count: number;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  /**
   * ⚠️ Yaroqsiz joylashuv maydoni HAR DAQIQADA keladi (plata menyusida bir
   * marta noto'g'ri tanlangan). Har signalda yozilsa, jurnal shu qator bilan
   * to'lib, haqiqiy nosozliklar ko'rinmay qolardi.
   */
  private readonly profileWarnedAt = new Map<string, number>();
  /** Plata joylashuvi panel bilan oxirgi marta qachon solishtirilgan. */
  private readonly locationCheckedAt = new Map<string, number>();

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
    private readonly objectTypes: ObjectTypeDirectoryService,
  ) {}

  /**
   * ESP32 DAN KELGAN SIGNAL (kotyol v2.0.0/v2.1.0, xona v1.0.0/v1.1.0).
   *
   * Tartib — har bosqich OLDINGISIGA bog'liq:
   *   1) plata profili (tur, joylashuv) xom yukdan — XATO TASHLAMAYDI;
   *   2) autentifikatsiya: 401 (token) / 403 (ro'yxatda yo'q → «Yangi qurilmalar»);
   *   3) tur va joylashuv sinxroni (joylashuv faqat TAKLIF — §4);
   *   4) harorat oralig'i: kotyol -55…125, xona -40…80, tashqarisi — 422;
   *   5) o'lchov SERVER vaqti bilan yoziladi (`measured_at` o'qilmaydi).
   *
   * ⚠️ Bu tizimdagi eng TEZ-TEZ chaqiriladigan funksiya (har qurilma 60 s da).
   * Og'ir ishlar (hisobot, agregat) bu yerda EMAS.
   */
  async ingest(
    dto: IngestDto,
    apiKey: string | null,
    rawPayload: Record<string, unknown>,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const now = new Date();
    const ip = meta.ip?.slice(0, 45) ?? null;
    const firmware = meta.firmwareVersion ?? dto.firmware ?? null;

    const profile = extractReportedProfile(
      rawPayload,
      meta.deviceTypeHeader ?? null,
    );
    const roomPayload = extractRoomSamples(rawPayload);
    const hasBoilerReading =
      dto.inletTemperature !== undefined ||
      dto.outletTemperature !== undefined ||
      dto.singleTemperature !== undefined;
    const inferredType = inferDeviceType({
      hasRoomTemperatureField: roomPayload.source === 'single',
    });
    const location = await this.readReportedLocation(rawPayload, profile);

    const { device } = await this.auth.authenticate(dto.deviceId, apiKey, {
      ip,
      firmwareVersion: firmware,
      institutionHint: dto.institutionId ?? null,
      deviceType: profile.declaredType ?? inferredType,
      reportedDistrictKey: location.district?.key ?? null,
      reportedObjectType: location.objectType?.code ?? null,
      reportedInstitution: location.institution,
    });

    await this.auth.applyDeviceType(device, {
      declared: profile.declaredType,
      inferred: inferredType,
    });
    await this.syncReportedLocation(device, location, profile.mfy);
    this.warnRejectedProfile(device.deviceId, profile, location.ignored);
    this.logRejectedRooms(device.deviceId, roomPayload);

    /*
     * ⚠️⚠️ YAROQSIZ O'LCHOV — 422, LEKIN QURILMA «TIRIK» DEB BELGILANADI.
     * Qurilma tirikligi va o'lchovning yaroqliligi — ikki boshqa narsa:
     * `lastSeenAt` yangilanmasa, datchigi nosoz plata kabinetda «o'lgan»
     * bo'lib ko'rinardi va ta'mirchi Wi-Fi'ni tekshirib yurardi.
     */
    const invalid = this.findInvalidTemperature(dto, roomPayload);
    if (invalid || (!hasBoilerReading && roomPayload.samples.length === 0)) {
      await this.devices.update(device.id, {
        lastSeenAt: now,
        lastIpAddress: ip,
        ...(firmware ? { firmwareVersion: firmware } : {}),
      });
      if (invalid) {
        this.logger.warn(`Qurilma ${device.deviceId}: ${invalid}`);
      }
      throw new UnprocessableEntityException(
        invalid ??
          (roomPayload.source !== undefined
            ? `Xona harorati o‘lchov diapazonidan tashqarida (${AIR_MIN_C}…${AIR_MAX_C} °C)`
            : 'Harorat yuborilmagan: temperature_c, inlet/outlet_temperature_c yoki room_temperature_c kerak'),
      );
    }

    /*
     * ⚠️⚠️ QAYSI SON KIRISH, QAYSI BIRI CHIQISH — `classifyProbeReading` da,
     * BIR joyda. Yakka `probe: "inlet"` o'lchovi kirish chizig'iga, `outlet`
     * (yoki ishorasiz) — chiqish chizig'iga tushadi.
     */
    const classified = hasBoilerReading
      ? classifyProbeReading({
          inlet: dto.inletTemperature ?? null,
          outlet: dto.outletTemperature ?? null,
          single: dto.singleTemperature ?? null,
          probeHint: dto.probeHint ?? null,
        })
      : null;

    const thresholds = classified ? await this.settings.thresholds() : null;
    const readingStatus =
      classified && thresholds
        ? resolveBoilerStatus(
            { temperature: classified.outlet, lastReadingAt: now, now },
            thresholds,
          )
        : null;
    const roomAverage =
      roomPayload.samples.length > 0
        ? Math.round(
            (roomPayload.samples.reduce(
              (acc, item) => acc + item.temperature,
              0,
            ) /
              roomPayload.samples.length) *
              100,
          ) / 100
        : null;

    /*
     * ⚠️⚠️ `boiler_id` FAQAT KOTYOL O'LCHOVIDA. Xona moduli kotyolga
     * ulangan bo'lsa ham uning qatori `boiler_id = null`: kotyol grafigi va
     * holati `boiler_id` bo'yicha o'qiladi va havo harorati suv harorati
     * chizig'iga aralashmasligi kerak. Qurilma grafigi `device_id` bo'yicha.
     */
    const stored = await this.storeReading({
      deviceId: device.id,
      boilerId: classified ? device.boilerId : null,
      temperature: classified?.outlet ?? null,
      inletTemperature: classified?.inlet ?? null,
      outletTemperature: classified?.outlet ?? null,
      probe: classified?.probe ?? null,
      status: readingStatus,
      recordedAt: now,
      measuredAt: null,
      roomTemperature: roomAverage,
      humidity: profile.humidity ?? null,
      rawPayload,
    });

    await this.devices.update(device.id, {
      lastSeenAt: now,
      lastIpAddress: ip,
      ...(firmware ? { firmwareVersion: firmware } : {}),
      ...(dto.institutionId ? { institutionHint: dto.institutionId } : {}),
      ...(stored
        ? { readingsCount: (): string => '"readings_count" + 1' }
        : {}),
    });

    if (roomPayload.samples.length > 0 || profile.humidity !== undefined) {
      await this.recordRoomSnapshot(
        device.id,
        roomPayload.samples,
        profile.humidity,
        now,
      );
    }

    if (classified && thresholds && device.boilerId && stored) {
      if (classified.rejected.length > 0) {
        this.logger.warn(
          `Qurilma ${device.deviceId}: datchik nosoz bo‘lishi mumkin (` +
            classified.rejected
              .map((item) => `${item.probe}=${item.value}`)
              .join(', ') +
            ')',
        );
      }
      await this.applyToBoiler({
        boilerId: device.boilerId,
        inlet: classified.inlet,
        outlet: classified.outlet,
        probe: classified.probe,
        recordedAt: now,
        now,
        thresholds,
      });
    }

    /*
     * ⚠️ Xona yozuvi faqat KOTYOLGA ULANGAN modulda (xona binoga tegishli).
     * Ulanmagan modulning qiymati qurilmaning o'zida va qurilma grafigida.
     */
    const roomsAccepted =
      roomPayload.samples.length === 0
        ? 0
        : device.boilerId
          ? await this.ingestRooms(
              device.boilerId,
              this.roomSamplesFor(device, roomPayload),
              now,
              now,
            )
          : roomPayload.samples.length;

    return {
      ok: true,
      /* ⚠️ Faqat ESKI `modul1` uchun ishora: yangi proshivka oralig'i qotirilgan (60 s). */
      nextIntervalSec: 30,
      status: readingStatus,
      boilerAssigned: Boolean(device.boilerId),
      probe: classified?.probe ?? null,
      rooms: roomsAccepted,
    };
  }

  /**
   * QAT'IY ORALIQ TEKSHIRUVI (§4): kotyol -55…125 °C, xona -40…80 °C.
   *
   * ⚠️ Yangi proshivka nosoz datchikni o'zi chiqarib tashlaydi (yakka
   * `temperature_c` + `probe`), demak oraliqdan tashqaridagi qiymat — buzuq
   * yuk. `rooms[]` massivi (kotyol modulining qo'shimcha datchiklari) bu
   * qoidadan TASHQARIDA: undagi bitta yaroqsiz datchik qolganlarini rad
   * etmasligi kerak — ular alohida jurnalga yoziladi.
   *
   * @returns Xato matni yoki `null`.
   */
  private findInvalidTemperature(
    dto: IngestDto,
    roomPayload: ParsedRoomSamples,
  ): string | null {
    const fields: Array<[string, number | undefined]> = [
      ['inlet_temperature_c', dto.inletTemperature],
      ['outlet_temperature_c', dto.outletTemperature],
      ['temperature_c', dto.singleTemperature],
    ];
    for (const [name, value] of fields) {
      if (value === undefined) continue;
      if (
        !Number.isFinite(value) ||
        value < DS18B20_MIN_C ||
        value > DS18B20_MAX_C
      ) {
        return `${name}=${String(value).slice(0, 16)} kotyol oralig‘idan tashqarida (${DS18B20_MIN_C}…${DS18B20_MAX_C} °C)`;
      }
    }
    if (roomPayload.source === 'single' && roomPayload.rejected.length > 0) {
      const value = String(roomPayload.rejected[0].value).slice(0, 16);
      return `room_temperature_c=${value} xona oralig‘idan tashqarida (${AIR_MIN_C}…${AIR_MAX_C} °C)`;
    }
    return null;
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
    samples: RoomSample[],
    recordedAt: Date,
    now: Date,
  ): Promise<number> {
    if (samples.length === 0) return 0;
    try {
      const boiler = await this.boilers.findOne({
        where: { id: boilerId },
        select: { id: true, lotNumber: true },
      });
      if (!boiler) return 0;

      const result = await this.roomsService.ingest({
        boilerId,
        lotNumber: boiler.lotNumber,
        samples,
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
   * XONA KALITI — yakka qiymat (`room_temperature_c`) QURILMA identifikatori
   * bilan (proshivka bilan kelishilgan: key = "<device_id>").
   *
   * ⚠️⚠️ Bitta binoda (kotyolda) bir nechta xona moduli bo'ladi — har
   * sinfga bittadan. Hammasi `room_temperature_c` yuboradi va u umumiy
   * `xona` kalitiga tushsa, BITTA xona bo'lib, qiymatlar bir-birini bosib
   * ketardi. Qurilma identifikatori (`esp32-…`) doimiy va yagona.
   *
   * ⚠️ Modul TURIGA bog'lanmaydi: tur aniqlanmasdan (masalan kotyolga oldin
   * ulangan 1.0.0 modul) kelgan signal ham AYNI xonaga tushishi kerak —
   * aks holda bitta datchik tur aniqlangach ikkinchi xona bo'lib qolardi.
   * `rooms[]` massivining kalitlari o'zgarishsiz qoladi.
   */
  private roomSamplesFor(
    device: AuthenticatedDevice,
    payload: ParsedRoomSamples,
  ): RoomSample[] {
    if (payload.source !== 'single') return payload.samples;
    const key = normalizeRoomKey(device.deviceId);
    if (!key) return payload.samples;
    return payload.samples.map((sample) => ({ ...sample, key }));
  }

  /**
   * OXIRGI XONA HARORATI / NAMLIGI — QURILMA darajasida.
   *
   * ⚠️⚠️ SHARTLI YOZUV (`last_room_reading_at < :at`): oflayn navbatdan
   * kelgan ESKI o'lchov yangisini bosib ketmaydi — aks holda 3 soatlik
   * uzilishdan keyin kabinetda eski harorat «hozirgi» bo'lib turardi.
   *
   * ⚠️ Kelmagan qiymat O'CHIRILMAYDI: namlik yuborilmasa, oxirgi ma'lum
   * namlik saqlanadi.
   *
   * @returns Yozuv yangilandimi (signallar sanog'i shunga qarab oshadi).
   */
  private async recordRoomSnapshot(
    deviceUuid: string,
    samples: RoomSample[],
    humidity: number | undefined,
    recordedAt: Date,
  ): Promise<boolean> {
    if (samples.length === 0 && humidity === undefined) return false;

    const set: Record<string, unknown> = { lastRoomReadingAt: recordedAt };
    if (samples.length > 0) {
      const sum = samples.reduce((acc, item) => acc + item.temperature, 0);
      set.lastRoomTemperature = Math.round((sum / samples.length) * 100) / 100;
    }
    if (humidity !== undefined) set.lastHumidity = humidity;

    try {
      const result = await this.devices
        .createQueryBuilder()
        .update(Device)
        .set(set)
        .where('id = :id', { id: deviceUuid })
        .andWhere(
          '(last_room_reading_at IS NULL OR last_room_reading_at < :at)',
          { at: recordedAt },
        )
        .execute();
      return Boolean(result.affected);
    } catch (error) {
      // ⚠️ Yon ma'lumot — o'lchovni rad etmaydi.
      this.logger.warn(
        `Qurilmaning xona harorati yozilmadi: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  /**
   * PLATA AYTGAN JOYLASHUVNI O'QISH VA TEKSHIRISH.
   *
   * ⚠️ Noma'lum tuman yoki obyekt turi kaliti so'rovni RAD ETMAYDI (§4) —
   * maydon e'tiborsiz qoldiriladi (`ignored`, jurnalga). Muassasa nomi —
   * erkin matn (48 baytgacha, apostrof bo'lishi mumkin): yangi proshivka
   * `institution_name`, eskisi `institution_id` yuboradi; ikkinchisi NOM
   * EMAS (`maktab-4`) va `institution_hint` da alohida saqlanadi.
   */
  private async readReportedLocation(
    raw: Record<string, unknown>,
    profile: ReportedProfile,
  ): Promise<ReportedLocation> {
    const ignored: string[] = [];
    const districtRaw = extractDistrictRef(raw);
    const district =
      districtRaw === undefined
        ? null
        : await this.districtDirectory.resolve(districtRaw);
    if (districtRaw !== undefined && !district) ignored.push('district');

    const objectType =
      profile.objectType === undefined
        ? null
        : await this.objectTypes.resolve(profile.objectType);
    if (profile.objectType !== undefined && !objectType)
      ignored.push('object_type');

    return {
      district,
      objectType,
      institution: profile.institution ?? null,
      ignored,
    };
  }

  /**
   * TAKLIF YOKI OGOHLANTIRISH — joylashuv PANELDAN olinadi (§4).
   *
   * ⚠️⚠️ Qurilma ↔ muassasa bog'lanishi FAQAT `device_id` orqali, paneldagi
   * qurilmalar jadvalidan. Plata yuborgan joylashuv:
   *   • `reported_*` ustunlariga yoziladi (o'zgarganda);
   *   • panelda shu maydon BO'SH bo'lsa — bu TAKLIF: «Qurilmalar» sahifasida
   *     ko'rinadi va admin bir bosishda tasdiqlaydi (`confirmLocation`);
   *   • panelda TO'LA va farq qilsa — e'tiborsiz, jurnalga ogohlantirish.
   * Ilgarigi «tuman plataniki, kotyoldan avtomatik ajratiladi» qoidasi
   * OLIB TASHLANDI: endi plata panelni hech qachon o'zgartirmaydi.
   *
   * ⚠️ Panel bilan solishtirish uchun so'rov kerak — u qurilma uchun 30
   * daqiqada bir marta yoki yuborilgan qiymat o'zgarganda bajariladi.
   */
  private async syncReportedLocation(
    device: AuthenticatedDevice,
    location: ReportedLocation,
    mfy: string | undefined,
  ): Promise<void> {
    const changes: Partial<
      Pick<
        Device,
        | 'reportedDistrict'
        | 'reportedObjectType'
        | 'reportedInstitution'
        | 'reportedMfy'
      >
    > = {};
    const districtKey = location.district?.key;
    if (districtKey && districtKey !== device.reportedDistrict)
      changes.reportedDistrict = districtKey;
    const typeCode = location.objectType?.code;
    if (typeCode && typeCode !== device.reportedObjectType)
      changes.reportedObjectType = typeCode;
    if (
      location.institution &&
      location.institution !== device.reportedInstitution
    )
      changes.reportedInstitution = location.institution;
    if (mfy !== undefined && mfy !== device.reportedMfy)
      changes.reportedMfy = mfy;

    const changed = Object.keys(changes).length > 0;
    if (changed) {
      try {
        await this.devices.update(device.id, changes);
        Object.assign(device, changes);
      } catch (error) {
        this.logger.warn(
          `Qurilma ${device.deviceId}: joylashuv yozilmadi — ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }

    if (!districtKey && !typeCode && !location.institution) return;
    const nowMs = Date.now();
    const last = this.locationCheckedAt.get(device.id);
    if (
      !changed &&
      last !== undefined &&
      nowMs - last < PROFILE_WARN_INTERVAL_MS
    )
      return;
    if (this.locationCheckedAt.size > 10_000) this.locationCheckedAt.clear();
    this.locationCheckedAt.set(device.id, nowMs);

    const panel = await this.panelLocation(device);
    const mismatches: string[] = [];
    const suggestions: string[] = [];
    if (districtKey) {
      if (!panel.districtKey) suggestions.push(`tuman=${districtKey}`);
      else if (panel.districtKey !== districtKey)
        mismatches.push(
          `tuman: panelda ${panel.districtKey}, platada ${districtKey}`,
        );
    }
    if (typeCode) {
      if (!panel.objectTypeCode) suggestions.push(`obyekt turi=${typeCode}`);
      else if (panel.objectTypeCode !== typeCode)
        mismatches.push(
          `obyekt turi: panelda ${panel.objectTypeCode}, platada ${typeCode}`,
        );
    }
    if (location.institution) {
      if (!panel.institutionName) suggestions.push('muassasa');
      else if (
        normalizeInstitutionName(panel.institutionName) !==
        normalizeInstitutionName(location.institution)
      )
        mismatches.push('muassasa nomi paneldagidan farq qiladi');
    }
    if (mismatches.length > 0) {
      this.logger.warn(
        `Qurilma ${device.deviceId}: plata joylashuvi paneldagidan farq qiladi — ` +
          `${mismatches.join('; ')}. Panel o‘zgartirilmadi.`,
      );
    }
    if (suggestions.length > 0 && changed) {
      this.logger.log(
        `Qurilma ${device.deviceId}: joylashuv TAKLIFI (${suggestions.join(', ')}) — ` +
          'panelda tasdiqlash kutilmoqda',
      );
    }
  }

  /**
   * PANELDAGI JOYLASHUV: kotyolga ulangan bo'lsa — kotyolniki, aks holda
   * qurilmaning o'z maydonlari (`district_id`, `organization_id`).
   */
  private async panelLocation(device: AuthenticatedDevice): Promise<{
    districtKey: string | null;
    objectTypeCode: string | null;
    institutionName: string | null;
  }> {
    const row = await this.devices
      .createQueryBuilder('device')
      .leftJoin('boilers', 'boiler', 'boiler.id = device.boiler_id')
      .leftJoin(
        'organizations',
        'org',
        'org.id = COALESCE(boiler.organization_id, device.organization_id)',
      )
      .leftJoin('object_types', 'ot', 'ot.id = org.object_type_id')
      .leftJoin(
        'districts',
        'district',
        'district.id = COALESCE(boiler.district_id, device.district_id)',
      )
      .select('district.key', 'districtKey')
      .addSelect('ot.code', 'objectTypeCode')
      .addSelect('org.name', 'institutionName')
      .where('device.id = :id', { id: device.id })
      .getRawOne<{
        districtKey: string | null;
        objectTypeCode: string | null;
        institutionName: string | null;
      }>();
    return {
      districtKey: row?.districtKey ?? null,
      objectTypeCode: row?.objectTypeCode ?? null,
      institutionName: row?.institutionName ?? null,
    };
  }

  /**
   * ⚠️ Faqat MAYDON NOMI yoziladi, qiymati emas: u qurilmadan kelgan
   * ixtiyoriy matn va jurnalni buzishi mumkin. Har qurilma+maydon uchun
   * 30 daqiqada bir marta.
   */
  private warnRejectedProfile(
    deviceId: string,
    profile: ReportedProfile,
    unknownKeys: string[] = [],
  ): void {
    const names = [
      ...profile.rejected.map((item) => item.field),
      ...unknownKeys.map((field) => `${field} (noma‘lum kalit)`),
    ];
    if (names.length === 0) return;
    const fields = names.join(', ');
    const key = `${deviceId}|${fields}`;
    const now = Date.now();
    const last = this.profileWarnedAt.get(key);
    if (last !== undefined && now - last < PROFILE_WARN_INTERVAL_MS) return;

    // ⚠️ Xarita cheksiz o'smasin (soxta identifikatorlar bilan).
    if (this.profileWarnedAt.size > 5_000) this.profileWarnedAt.clear();
    this.profileWarnedAt.set(key, now);
    this.logger.warn(
      `Qurilma ${deviceId}: yaroqsiz maydon(lar) e‘tiborsiz qoldirildi — ${fields}`,
    );
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
  async recent(
    boilerId: string,
    limit: number,
    user?: AuthUser,
  ): Promise<TelemetryReading[]> {
    /*
     * ⚠️⚠️ TUMAN CHEGARASI — ilgari bu yerda YO'Q edi: tuman mas'uli
     * boshqa tuman kotyolining o'lchovlarini ID orqali o'qiy olardi.
     */
    if (user?.role === UserRole.OPERATOR) {
      const boiler = await this.boilers.findOne({
        where: { id: boilerId },
        select: { id: true, districtId: true },
      });
      if (!boiler || boiler.districtId !== user.districtId) {
        throw new NotFoundException('Kotyol topilmadi');
      }
    }
    return this.readings.find({
      where: { boilerId },
      order: { recordedAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  /**
   * QURILMA GRAFIGI — `device_id` bo'yicha (kotyolga ulanmagan modul ham).
   *
   *   • kotyol moduli: `inlet` va `outlet` chiziqlari. Yakka datchik
   *     o'lchovi (`probe: inlet|outlet`) O'Z chizig'iga tushadi — ikkinchisi
   *     bu nuqtada bo'sh (nol emas);
   *   • xona moduli: `room` (va bo'lsa `humidity`).
   *
   * ⚠️ `AVG` NULL larni o'tkazib yuboradi — aynan kerakli xatti-harakat.
   * ⚠️ Ko'rinish chegarasini CHAQIRUVCHI tekshiradi (`findOneVisible`).
   */
  async deviceSeries(
    deviceUuid: string,
    query: TelemetryQueryDto,
  ): Promise<DeviceSeriesPoint[]> {
    const { from, to } = this.resolveRange(query);
    const outlet = `COALESCE(reading.outlet_temperature,
        CASE WHEN reading.probe IS DISTINCT FROM 'inlet' THEN reading.temperature END)`;
    const qb = this.readings.createQueryBuilder('reading');

    if (query.bucket === 'raw') {
      qb.select('reading.recorded_at', 't')
        .addSelect('reading.inlet_temperature', 'inlet')
        .addSelect(outlet, 'outlet')
        .addSelect('reading.room_temperature', 'room')
        .addSelect('reading.humidity', 'humidity')
        .addSelect('1', 'count')
        .orderBy('reading.recorded_at', 'ASC');
    } else {
      const unit = query.bucket === 'day' ? 'day' : 'hour';
      qb.select(`date_trunc('${unit}', reading.recorded_at)`, 't')
        .addSelect('AVG(reading.inlet_temperature)', 'inlet')
        .addSelect(`AVG(${outlet})`, 'outlet')
        .addSelect('AVG(reading.room_temperature)', 'room')
        .addSelect('AVG(reading.humidity)', 'humidity')
        .addSelect('COUNT(*)', 'count')
        .groupBy('1')
        .orderBy('1', 'ASC');
    }
    qb.where('reading.device_id = :deviceUuid', { deviceUuid })
      .andWhere('reading.recorded_at BETWEEN :from AND :to', { from, to })
      .limit(query.limit);

    const rows = await qb.getRawMany<Record<string, unknown>>();
    const num = (value: unknown): number | null =>
      value === null || value === undefined
        ? null
        : Math.round(Number(value) * 100) / 100;
    return rows.map((row) => ({
      t: new Date(row.t as string).toISOString(),
      inlet: num(row.inlet),
      outlet: num(row.outlet),
      room: num(row.room),
      humidity: num(row.humidity),
      count: Number(row.count ?? 0),
    }));
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
    // ⚠️ Faqat KOTYOL o'lchovlari: xona moduli qatorida `probe` — `null`.
    qb.andWhere('reading.probe IS NOT NULL');
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
