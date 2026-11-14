import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  OtaEventStatus,
  RolloutStatus,
  RolloutTargetType,
} from '../../common/constants/enums';
import { Device } from '../../database/entities/device.entity';
import {
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  OtaEvent,
} from '../../database/entities/firmware.entities';
import type {
  AuthenticatedDevice,
  DeviceRequestMeta,
} from '../devices/device-auth.service';
import { DeviceAuthService } from '../devices/device-auth.service';

/**
 * QURILMAGA QAYTADIGAN JAVOB — TEKIS obyekt.
 *
 * ⚠️⚠️ TUZILISHINI O'ZGARTIRMANG. Proshivkadagi JSON o'quvchi juda
 * sodda (`net.cpp` dagi `jsonString` / `jsonNumber` / `jsonBool`):
 *   • faqat `"kalit": qiymat` juftligini topadi — ichma-ich obyekt
 *     yoki massivni UMUMAN tushunmaydi;
 *   • `\uXXXX` ni ochmaydi — kirillcha matn kelsa buzilardi;
 *   • `size` ni `strtol` bilan o'qiydi, ya'ni SON bo'lishi shart.
 * Shu sababli javobga hech qanday erkin matn (`note`, `message`)
 * QO'SHILMAYDI: u kirillcha bo'lsa, `JSON.stringify` uni `\uXXXX`
 * ga aylantirib, javobni o'qib bo'lmas qilardi.
 */
export type OtaCheckResponse =
  | { update: false }
  | {
      update: true;
      version: string;
      url: string;
      sha256: string;
      size: number;
    };

/** Bir vaqtda ruxsat etilgan yuklab olishlar — `.env` dan. */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * KETMA-KET XATOLAR CHEGARASI (§9.4).
 *
 * ⚠️ Uchinchi `failed` dan keyin versiya shu qurilmaga boshqa taklif
 * qilinmaydi. `rolled_back` esa BIRINCHI marta ham bloklaydi —
 * qaytish eng og'ir dalil: proshivka o'rnatildi, lekin ishlamadi.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class OtaService {
  private readonly logger = new Logger(OtaService.name);

  /**
   * Hozir yuklab olayotgan qurilmalar soni.
   *
   * ⚠️⚠️ CHEGARA BO'LMASA KANAL BO'G'ILADI: 1.9 MB × 200 qurilma bir
   * vaqtda yuklab olsa, hosting ulanishi to'lib, TELEMETRIYA ham
   * o'tmay qolardi — ya'ni yangilanish paytida monitoring ko'r
   * bo'lib qolardi. Qurilma chegaraga urilganda 503 oladi va §5
   * bo'yicha «keyinroq qayta so'ra» deb tushunadi.
   */
  private activeDownloads = 0;

  constructor(
    @InjectRepository(FirmwareRelease)
    private readonly releases: Repository<FirmwareRelease>,
    @InjectRepository(FirmwareRollout)
    private readonly rollouts: Repository<FirmwareRollout>,
    @InjectRepository(FirmwareBlock)
    private readonly blocks: Repository<FirmwareBlock>,
    @InjectRepository(OtaEvent)
    private readonly events: Repository<OtaEvent>,
    @InjectRepository(Device)
    private readonly devices: Repository<Device>,
    private readonly auth: DeviceAuthService,
    private readonly config: ConfigService,
  ) {}

  // ═══════════════════════ 1. TEKSHIRUV ═══════════════════════

  /**
   * `GET {OTA_URL}?a=check&device_id=…&version=…&inst=…`
   *
   * Qurilma Wi-Fi'ga ulangandan 1 daqiqa keyin, so'ng har 30 daqiqada
   * so'raydi (`config.h` dagi `OTA_CHECK_*`).
   */
  async check(
    deviceId: string | null,
    token: string | null,
    currentVersion: string | null,
    meta: DeviceRequestMeta,
  ): Promise<OtaCheckResponse> {
    const { device } = await this.auth.authenticate(deviceId, token, meta);

    /*
     * ⚠️ §5: «Har bir so'rovda devices.firmware_version, last_check_at
     * va last_ip ni yangila». `lastSeenAt` esa TEGILMAYDI va bu
     * ongli: u TELEMETRIYA kelgan vaqtni bildiradi. OTA tekshiruvi
     * bilan yangilansa, datchigi uzilgan plata «ma'lumot yuborib
     * turgan» bo'lib ko'rinardi.
     */
    const running = currentVersion ?? meta.firmwareVersion ?? null;
    await this.devices.update(device.id, {
      lastCheckAt: new Date(),
      lastIpAddress: meta.ip?.slice(0, 45) ?? null,
      ...(running ? { firmwareVersion: running } : {}),
    });

    const rollout = await this.activeRollout();
    if (!rollout) return { update: false };

    const release = rollout.release;
    if (!release || release.isArchived) return { update: false };

    /*
     * ⚠️ AYNI VERSIYA TAKLIF QILINMAYDI. Proshivka o'zi ham tekshiradi
     * (`ota.cpp`: `ver == FW_VERSION` bo'lsa o'rnatmaydi), lekin
     * serverda ham to'xtatiladi: aks holda har 30 daqiqada bekorga
     * 1.9 MB yuklab olinardi.
     */
    if (running && running === release.version) return { update: false };

    if (!(await this.isTargeted(device, rollout))) return { update: false };

    /*
     * ⚠️⚠️ BLOKLANGAN VERSIYA QAYTA TAKLIF QILINMAYDI. Busiz yaroqsiz
     * proshivka cheksiz halqa yasardi: yuklab oladi → o'rnatadi →
     * tasdiqlanmaydi → eskisiga qaytadi → 30 daqiqadan keyin YANA.
     */
    if (await this.isBlocked(device.id, release.version)) {
      return { update: false };
    }

    if (!(await this.hasFreeSlot(rollout, release.version, device.id))) {
      return { update: false };
    }

    const url = this.downloadUrl(release.version);
    /*
     * ⚠️⚠️ OXIRGI HIMOYA: manzil proshivka talabiga mos kelmasa,
     * yangilanish TAKLIF QILINMAYDI. Qurilma `isOwnServerUrl()` bilan
     * uni baribir rad etardi, lekin unda sabab faqat qurilma
     * jurnalida qolardi — bu yerda esa server jurnaliga tushadi va
     * administrator `PUBLIC_BASE_URL` xato ekanini DARHOL ko'radi.
     */
    if (!this.isDeviceAcceptableUrl(url)) {
      this.logger.error(
        `PUBLIC_BASE_URL qurilma talabiga mos emas: «${url}». ` +
          'Manzil https:// bilan boshlanishi va ichida @ bo‘lmasligi kerak — ' +
          'yangilanish taklif qilinmadi.',
      );
      return { update: false };
    }

    await this.logEvent(device.id, OtaEventStatus.OFFERED, {
      targetVersion: release.version,
      runningVersion: running,
      ip: meta.ip,
    });

    return {
      update: true,
      version: release.version,
      url,
      sha256: release.sha256,
      size: release.size,
    };
  }

  // ═══════════════════════ 2. YUKLAB BERISH ═══════════════════════

  /**
   * `GET {url}` — `?a=download&v=2.0.1`.
   *
   * ⚠️ Faylni O'ZI oqim qilib bermaydi: kontroller `@Res()` bilan
   * yozadi. Servis faqat RUXSATNI hal qiladi va tekshirilgan relizni
   * qaytaradi — shu tufayli ruxsat mantig'i HTTP qatlamidan ajratilgan
   * va alohida testlanadi.
   *
   * @returns Reliz va navbat o'rnini BO'SHATUVCHI funksiya; uni
   *   kontroller `finally` da chaqirishi SHART.
   */
  async authorizeDownload(
    deviceId: string | null,
    token: string | null,
    version: string | null,
    meta: DeviceRequestMeta,
  ): Promise<{ release: FirmwareRelease; releaseSlot: () => void }> {
    const { device } = await this.auth.authenticate(deviceId, token, meta);

    if (!version) {
      throw new NotFoundException('Versiya ko‘rsatilmagan');
    }

    const release = await this.releases.findOne({ where: { version } });
    if (!release || release.isArchived) {
      throw new NotFoundException('Bunday proshivka versiyasi yo‘q');
    }

    /*
     * ⚠️⚠️ §6: «faylni faqat shu qurilmaga mo'ljallangan rollout
     * bo'lsa ber». Tokenni bilish YETARLI EMAS: aks holda bitta
     * qurilmaning tokeni bilan har qanday proshivkani yuklab olib,
     * ichidan boshqa maxfiy ma'lumotni ajratib olish mumkin bo'lardi.
     */
    const rollout = await this.activeRollout();
    const allowed =
      rollout !== null &&
      rollout.release?.version === version &&
      !(await this.isBlocked(device.id, version)) &&
      (await this.isTargeted(device, rollout));

    if (!allowed) {
      this.logger.warn(
        `Qurilma ${device.deviceId} ruxsatsiz ${version} ni yuklab olishga urindi`,
      );
      throw new NotFoundException('Bu qurilma uchun yangilanish yo‘q');
    }

    const max =
      this.config.get<number>('firmware.maxConcurrentDownloads') ??
      DEFAULT_MAX_CONCURRENT;

    if (this.activeDownloads >= max) {
      this.logger.warn(
        `Yuklab olish navbati to‘ldi (${this.activeDownloads}/${max}) — ` +
          `${device.deviceId} keyinroq qayta so‘raydi`,
      );
      /*
       * ⚠️ 503 — §5 bo'yicha qurilma «keyinroq qayta so'ra» deb
       * tushunadi va 10 daqiqadan keyin qaytadi. 404 bo'lsa, u
       * yangilanish YO'Q deb o'ylab, soatlab kutib qolardi.
       */
      throw new ServiceUnavailableException(
        'Yuklab olish navbati to‘ldi — keyinroq qayta urinib ko‘ring',
      );
    }

    this.activeDownloads += 1;
    let freed = false;
    /*
     * ⚠️ Hisoblagich MAJBURAN bo'shatiladi (kontroller `finally` da
     * chaqiradi). Bo'shatilmasa, uzilib qolgan ulanishlar sanoqni
     * abadiy to'ldirib, OTA butunlay to'xtab qolardi.
     * ⚠️ `freed` bayrog'i ikki marta bo'shatishdan saqlaydi — aks
     * holda hisoblagich manfiyga tushib, chegara ma'nosini
     * yo'qotardi.
     */
    const releaseSlot = (): void => {
      if (freed) return;
      freed = true;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    };

    return { release, releaseSlot };
  }

  // ═══════════════════════ 3. HISOBOT ═══════════════════════

  /**
   * `POST {OTA_URL}?a=report`
   *
   * Qurilma yuboradigan holatlar (`ota.cpp` dagi nomlar bilan AYNI):
   *   installed   — yuklandi, SHA-256 mos keldi, qayta ishga tushmoqda;
   *   ok          — yangi proshivka ishlayapti va TASDIQLANDI;
   *   failed      — yuklash yoki yozish xatosi;
   *   rolled_back — tasdiqlanmadi, bootloader eskisiga qaytardi.
   */
  async report(
    deviceId: string | null,
    token: string | null,
    body: {
      status: string;
      version?: string | null;
      target?: string | null;
      message?: string | null;
    },
    meta: DeviceRequestMeta,
  ): Promise<{ ok: true }> {
    const { device } = await this.auth.authenticate(deviceId, token, meta);

    const status = this.parseStatus(body.status);
    if (!status) {
      /*
       * ⚠️⚠️ NOTANISH HOLAT RAD ETILMAYDI, 2xx qaytariladi.
       * §7: «2xx qaytar. Aks holda qurilma hisobotni xotirada saqlab,
       * keyinroq qayta yuboradi». Notanish holat uchun 400 berilsa,
       * qurilma uni ABADIY qayta yuborib turardi — va bu hisobot
       * navbatini ham to'sib qo'yardi.
       */
      this.logger.warn(
        `Qurilma ${device.deviceId}: notanish OTA holati «${body.status}»`,
      );
      return { ok: true };
    }

    const target = this.trimVersion(body.target);
    const running = this.trimVersion(body.version) ?? meta.firmwareVersion;

    await this.logEvent(device.id, status, {
      targetVersion: target,
      runningVersion: running,
      message: body.message ?? null,
      ip: meta.ip,
    });

    /*
     * ⚠️ Qurilmadagi AMALDAGI versiya hisobotdan ham yangilanadi:
     * `rolled_back` kelganda u eski versiyaga qaytgan va kabinetda
     * shu ko'rinishi kerak.
     */
    if (running) {
      await this.devices.update(device.id, { firmwareVersion: running });
    }

    switch (status) {
      case OtaEventStatus.OK:
        /*
         * ⚠️ Muvaffaqiyatda XATO HISOBI NOLGA QAYTARILADI: «ketma-ket
         * 3 marta» degani aynan ketma-ket. Umumiy hisob bo'lsa, oylar
         * davomida turli sabablarga ko'ra uch marta xato qilgan
         * sog'lom qurilma abadiy bloklanib qolardi.
         */
        if (target) await this.clearFailures(device.id, target);
        await this.finishRolloutIfComplete();
        break;

      case OtaEventStatus.FAILED:
        if (target) {
          await this.registerFailure(
            device.id,
            target,
            body.message ?? 'yuklash yoki yozish xatosi',
          );
        }
        break;

      case OtaEventStatus.ROLLED_BACK:
        /*
         * ⚠️⚠️ QAYTISH — DARHOL BLOK. Bu eng og'ir dalil: proshivka
         * muvaffaqiyatli yozildi, SHA-256 ham mos keldi, lekin
         * ishga tushgandan keyin serverga ulanolmadi. Uni qayta
         * taklif qilish aynan shu natijani takrorlashdan boshqa
         * narsa bermaydi.
         */
        if (target) {
          await this.blockVersion(
            device.id,
            target,
            body.message ?? 'yangi proshivka tasdiqlanmadi',
          );
          this.logger.warn(
            `Qurilma ${device.deviceId}: ${target} QAYTARILDI — ` +
              'versiya shu qurilma uchun bloklandi',
          );
        }
        break;

      default:
        // `installed` — hali natija emas, faqat hodisa yozildi.
        break;
    }

    return { ok: true };
  }

  // ═══════════════════════ Yordamchilar ═══════════════════════

  /**
   * FAOL TARQATISH — reliz bilan birga.
   *
   * ⚠️ Bazada bir vaqtda faqat BITTA `active` qator bo'lishi qisman
   * unique indeks bilan kafolatlangan
   * (`UQ_firmware_rollouts_one_active`), shuning uchun bu yerda
   * «qaysi birini tanlash» muammosi YO'Q.
   */
  private async activeRollout(): Promise<FirmwareRollout | null> {
    return this.rollouts.findOne({
      where: { status: RolloutStatus.ACTIVE },
      relations: { release: true },
    });
  }

  /**
   * QURILMA TARQATISH MAQSADIGA KIRADIMI.
   *
   * ⚠️⚠️ Tuman va obyekt turi QURILMADAN emas, KOTYOLDAN olinadi:
   * `devices → boilers → organizations → object_types`. Qurilmaning
   * o'zida joy ma'lumoti YO'Q (identifikator MAC'dan olingan) va
   * `institution_hint` ga ISHONILMAYDI (§3) — u qurilma AYTGAN
   * qiymat, biz BILGAN qiymat emas.
   *
   * ⚠️ Kotyolga biriktirilmagan qurilma faqat `all` va `devices`
   * maqsadiga tushadi: tumani ham, turi ham noma'lum. Busiz
   * «Jalaquduq tumaniga tarqat» buyrug'i ombordagi platalarga ham
   * tegib ketardi.
   */
  private async isTargeted(
    device: AuthenticatedDevice,
    rollout: FirmwareRollout,
  ): Promise<boolean> {
    const ids = rollout.targetIds ?? [];

    if (rollout.targetType === RolloutTargetType.ALL) return true;

    if (rollout.targetType === RolloutTargetType.DEVICES) {
      return ids.includes(device.id);
    }

    if (!device.boilerId) return false;

    const row = await this.devices
      .createQueryBuilder('device')
      .select('boiler.district_id', 'districtId')
      .addSelect('organization.object_type_id', 'objectTypeId')
      .innerJoin('boilers', 'boiler', 'boiler.id = device.boiler_id')
      .leftJoin(
        'organizations',
        'organization',
        'organization.id = boiler.organization_id',
      )
      .where('device.id = :id', { id: device.id })
      .getRawOne<{ districtId: string | null; objectTypeId: string | null }>();

    if (!row) return false;

    if (rollout.targetType === RolloutTargetType.DISTRICTS) {
      return row.districtId !== null && ids.includes(row.districtId);
    }
    if (rollout.targetType === RolloutTargetType.OBJECT_TYPES) {
      return row.objectTypeId !== null && ids.includes(row.objectTypeId);
    }

    return false;
  }

  private async isBlocked(
    deviceUuid: string,
    version: string,
  ): Promise<boolean> {
    const block = await this.blocks.findOne({
      where: { deviceId: deviceUuid, version },
      select: { id: true, isBlocked: true },
    });
    return block?.isBlocked === true;
  }

  /**
   * SINOV REJIMI CHEGARASI — `maxDevices`.
   *
   * ⚠️⚠️ «Avval 1 ta qurilmada sinov» (§9.3) aynan shu yerda ishlaydi.
   * Allaqachon taklif olgan qurilmalar sanaladi: shu tufayli sinov
   * qurilmasi qayta so'rasa, u o'z joyini YO'QOTMAYDI — aks holda
   * har tekshiruvda boshqa qurilma tanlanib, chegara ma'nosini
   * yo'qotardi.
   */
  private async hasFreeSlot(
    rollout: FirmwareRollout,
    version: string,
    deviceUuid: string,
  ): Promise<boolean> {
    if (rollout.maxDevices === null) return true;

    const taken = await this.events
      .createQueryBuilder('event')
      .select('COUNT(DISTINCT event.device_id)', 'count')
      .where('event.target_version = :version', { version })
      .andWhere('event.status IN (:...statuses)', {
        statuses: [
          OtaEventStatus.OFFERED,
          OtaEventStatus.INSTALLED,
          OtaEventStatus.OK,
        ],
      })
      .getRawOne<{ count: string }>();

    const used = Number(taken?.count ?? 0);
    if (used < rollout.maxDevices) return true;

    // ⚠️ Chegara to'lgan, lekin BU qurilma allaqachon ro'yxatda bo'lsa — ruxsat.
    const mine = await this.events.count({
      where: { deviceId: deviceUuid, targetVersion: version },
    });
    return mine > 0;
  }

  /** Ketma-ket xatoni sanash va chegaraga yetganda bloklash. */
  private async registerFailure(
    deviceUuid: string,
    version: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.blocks.findOne({
      where: { deviceId: deviceUuid, version },
    });

    const failCount = (existing?.failCount ?? 0) + 1;
    const shouldBlock = failCount >= MAX_CONSECUTIVE_FAILURES;

    if (existing) {
      await this.blocks.update(existing.id, {
        failCount,
        isBlocked: shouldBlock || existing.isBlocked,
        reason: reason.slice(0, 500),
      });
    } else {
      await this.blocks.insert({
        deviceId: deviceUuid,
        version,
        failCount,
        isBlocked: shouldBlock,
        reason: reason.slice(0, 500),
      });
    }

    if (shouldBlock) {
      this.logger.warn(
        `Qurilma ${deviceUuid}: ${version} ketma-ket ${failCount} marta ` +
          'xato berdi — versiya bloklandi',
      );
    }
  }

  private async blockVersion(
    deviceUuid: string,
    version: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.blocks.findOne({
      where: { deviceId: deviceUuid, version },
      select: { id: true },
    });

    if (existing) {
      await this.blocks.update(existing.id, {
        isBlocked: true,
        reason: reason.slice(0, 500),
      });
      return;
    }

    await this.blocks.insert({
      deviceId: deviceUuid,
      version,
      failCount: MAX_CONSECUTIVE_FAILURES,
      isBlocked: true,
      reason: reason.slice(0, 500),
    });
  }

  /** Muvaffaqiyatdan keyin ketma-ket xato hisobini tozalash. */
  private async clearFailures(
    deviceUuid: string,
    version: string,
  ): Promise<void> {
    await this.blocks.delete({ deviceId: deviceUuid, version });
  }

  /**
   * TARQATISH TUGADIMI.
   *
   * ⚠️ Faqat `ok` hisoboti kelganda tekshiriladi, har tekshiruvda
   * EMAS: maqsadli qurilmalar to'plamini hisoblash bir nechta
   * `JOIN` talab qiladi va uni har 30 daqiqada, har qurilma uchun
   * bajarish behuda yuk bo'lardi.
   *
   * ⚠️ Tarqatish «tugadi» deb belgilanishi MUHIM: aks holda u abadiy
   * `active` qolib, bir vaqtda bitta faol tarqatish qoidasi tufayli
   * keyingi versiyani tarqatishga YO'L BERMASDI.
   */
  private async finishRolloutIfComplete(): Promise<void> {
    const rollout = await this.activeRollout();
    if (!rollout?.release) return;

    const version = rollout.release.version;
    const targets = await this.targetDeviceIds(rollout);
    if (targets.length === 0) return;

    const done = await this.events
      .createQueryBuilder('event')
      .select('COUNT(DISTINCT event.device_id)', 'count')
      .where('event.target_version = :version', { version })
      .andWhere('event.status = :status', { status: OtaEventStatus.OK })
      .andWhere('event.device_id IN (:...targets)', { targets })
      .getRawOne<{ count: string }>();

    if (Number(done?.count ?? 0) < targets.length) return;

    await this.rollouts.update(rollout.id, {
      status: RolloutStatus.DONE,
      finishedAt: new Date(),
    });
    this.logger.log(
      `Tarqatish tugadi: ${version} — ${targets.length} ta qurilma yangilandi`,
    );
  }

  /** Tarqatish maqsadiga kiradigan qurilmalarning UUID lari. */
  private async targetDeviceIds(rollout: FirmwareRollout): Promise<string[]> {
    const ids = rollout.targetIds ?? [];

    if (rollout.targetType === RolloutTargetType.DEVICES) return ids;

    const qb = this.devices
      .createQueryBuilder('device')
      .select('device.id', 'id')
      /*
       * ⚠️ Faolsizlantirilgan qurilma hisobga olinmaydi: u yangilanmaydi
       * va tarqatishni abadiy «tugamagan» holda ushlab turardi.
       */
      .where('device.is_active = true');

    if (rollout.targetType === RolloutTargetType.ALL) {
      const rows = await qb.getRawMany<{ id: string }>();
      return rows.map((row) => row.id);
    }

    qb.innerJoin('boilers', 'boiler', 'boiler.id = device.boiler_id');

    if (rollout.targetType === RolloutTargetType.DISTRICTS) {
      if (ids.length === 0) return [];
      qb.andWhere('boiler.district_id IN (:...ids)', { ids });
    } else if (rollout.targetType === RolloutTargetType.OBJECT_TYPES) {
      if (ids.length === 0) return [];
      qb.leftJoin(
        'organizations',
        'organization',
        'organization.id = boiler.organization_id',
      ).andWhere('organization.object_type_id IN (:...ids)', { ids });
    }

    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  /**
   * YUKLAB OLISH MANZILI.
   *
   * ⚠️⚠️ `?a=download&v=…` QUERY PARAMETRLARI SAQLANISHI SHART (§5).
   * Proshivka manzilni javobdan oladi, lekin uni `isOwnServerUrl()`
   * bilan tekshiradi: faqat `https://<host>/` bilan boshlanishi va
   * ichida `@` bo'lmasligi kerak.
   *
   * ⚠️ Versiya `encodeURIComponent` bilan o'raladi: reliz versiyasi
   * bazadan keladi va u faqat `x.y.z` ko'rinishida bo'lishi
   * validatsiyada tekshiriladi — lekin manzil quruvchi funksiya
   * bunga ISHONMAYDI.
   */
  private downloadUrl(version: string): string {
    const base = this.config.get<string>('publicBaseUrl') ?? '';
    return `${base}/ota/index.php?a=download&v=${encodeURIComponent(version)}`;
  }

  /**
   * MANZIL QURILMA TALABIGA MOS KELADIMI.
   *
   * ⚠️ Bu `net.cpp:6` dagi `isOwnServerUrl()` ning AYNI mantig'i:
   *   return url.startsWith(OWN_PREFIX) && url.indexOf('@') < 0;
   * Server tomonda ham tekshirilishi sababi — xatoni DALADA emas,
   * kabinetda ko'rish.
   *
   * ⚠️⚠️ `@` HAR QANDAY MUHITDA taqiqlanadi va bu xavfsizlik
   * tekshiruvi, nafaqat moslik: `https://host@evil.com/…` ko'rinishdagi
   * manzil brauzerda va ayrim HTTP kutubxonalarda `evil.com` ga
   * ketadi. Qurilma tokeni bilan birga shunday manzil berilsa, token
   * BEGONA serverga yuborilardi.
   *
   * ⚠️⚠️ `http://` ga FAQAT `development` da ruxsat. Haqiqiy qurilma
   * uni baribir rad etadi (`net.cpp` dagi `OWN_PREFIX` — `https://`),
   * lekin ishlab chiqish muhitida TLS sertifikati bo'lmaydi va bu
   * tekshiruv OTA yo'lini butunlay sinab ko'rish imkonini bermasdi:
   * `check` har doim `{"update":false}` qaytarardi va integratsiya
   * faqat ishlab chiqarishda, dala sharoitida tekshirilardi.
   * Ishlab chiqarishda (`production`) qoida QAT'IY qolaveradi.
   */
  private isDeviceAcceptableUrl(url: string): boolean {
    // ⚠️ `@` — hamma muhitda rad etiladi (yuqoridagi izohga qara).
    if (url.includes('@')) return false;
    if (url.startsWith('https://')) return true;

    const env = this.config.get<string>('env') ?? 'development';
    if (env !== 'production' && url.startsWith('http://')) {
      this.logger.warn(
        `PUBLIC_BASE_URL hali «http://» (${url.split('/ota/')[0]}). ` +
          'Ishlab chiqish muhitida ruxsat berildi, lekin HAQIQIY QURILMA ' +
          'bunday manzilni RAD ETADI — ishga tushirishdan oldin ' +
          'https:// va Let‘s Encrypt sertifikati shart.',
      );
      return true;
    }

    return false;
  }

  /**
   * ⚠️ Holat nomlari PROSHIVKADAGI nomlar bilan AYNI bo'lishi shart
   * (`ota.cpp` dagi `saveReport` chaqiruvlari). Shuning uchun bu
   * yerda qo'lda moslash: enum qiymatlari o'zgarsa, `switch` ni
   * kompilyator ushlaydi, lekin proshivka matnini u bilmaydi.
   */
  private parseStatus(raw: unknown): OtaEventStatus | null {
    if (typeof raw !== 'string') return null;
    switch (raw.trim().toLowerCase()) {
      case 'installed':
        return OtaEventStatus.INSTALLED;
      case 'ok':
        return OtaEventStatus.OK;
      case 'failed':
        return OtaEventStatus.FAILED;
      case 'rolled_back':
        return OtaEventStatus.ROLLED_BACK;
      default:
        return null;
    }
  }

  private trimVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().slice(0, 32);
    return value.length > 0 ? value : null;
  }

  private async logEvent(
    deviceUuid: string,
    status: OtaEventStatus,
    data: {
      targetVersion?: string | null;
      runningVersion?: string | null;
      message?: string | null;
      ip?: string | null;
    },
  ): Promise<void> {
    try {
      await this.events.insert({
        deviceId: deviceUuid,
        status,
        targetVersion: data.targetVersion ?? null,
        runningVersion: data.runningVersion ?? null,
        message: data.message?.slice(0, 1000) ?? null,
        ipAddress: data.ip?.slice(0, 45) ?? null,
      });
    } catch (error) {
      /*
       * ⚠️ Hodisa yozilmagani butun amalni TO'XTATMAYDI: u — jurnal,
       * qaror emas. Aks holda jurnal jadvalidagi muammo
       * yangilanishni ham, hisobotni ham butunlay to'sib qo'yardi.
       */
      this.logger.warn(
        'OTA hodisasini yozib bo‘lmadi: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
