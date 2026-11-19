import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DeviceType,
  OtaEventStatus,
  RolloutStatus,
  RolloutTargetType,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Device } from '../../database/entities/device.entity';
import {
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  OTA_PARTITION_MAX_BYTES,
  OtaEvent,
} from '../../database/entities/firmware.entities';
import {
  inspectFirmwareMarkers,
  readFirmwareMarkers,
  resolveFirmwareIdentity,
  type FirmwareInspection,
} from '../../helpers/firmware-marker.helper';
import type { CreateRolloutDto } from './dto/firmware.dto';
import { applyRolloutTarget } from './rollout-target';

/**
 * ESP32 OBRAZINING BIRINCHI BAYTI.
 *
 * ⚠️ Har bir ESP32 proshivka obrazi `0xE9` bilan boshlanadi (ESP-IDF
 * image magic). Tekshiruv arzon, lekin eng ko'p uchraydigan xatoni
 * ushlaydi: `.elf`, `.bin.gz` yoki butunlay boshqa fayl yuklab
 * qo'yish. Usiz yaroqsiz fayl butun parkka tarqatilib, har bir
 * qurilma uni yuklab olib, SHA-256 ni hisoblab, keyin tashlardi.
 */
const ESP32_IMAGE_MAGIC = 0xe9;

/** `x.y.z` — faqat shu ko'rinish qabul qilinadi. */
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Xabarlarda modul turining nomi. */
const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  [DeviceType.KOTYOL]: 'qozonxona moduli',
  [DeviceType.XONA]: 'xona moduli',
};

export interface ReleaseRow {
  id: string;
  version: string;
  /** `kotyol` | `xona` — `.bin` ichidagi `ANDIJON_FW_MODULE=` belgisidan yoki qo'lda. */
  deviceType: DeviceType;
  typeSource: 'marker' | 'manual';
  markerPrefix: string | null;
  size: number;
  sha256: string;
  note: string | null;
  isArchived: boolean;
  createdAt: Date;
  uploadedBy: string | null;
}

/**
 * PROSHIVKA RELIZLARI VA TARQATISH — ADMIN TOMONI.
 *
 * ⚠️ Qurilma tomoni (`OtaService`) dan ALOHIDA: u yerda har 30
 * daqiqada minglab so'rov keladi va kod ataylab sodda; bu yerda esa
 * kuniga bir necha marta bosiladigan tugmalar va ularning har biri
 * qaytarib bo'lmaydigan qaror.
 */
@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);

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
    private readonly config: ConfigService,
  ) {}

  // ═══════════════════════ RELIZLAR ═══════════════════════

  /**
   * `.bin` FAYLNI QABUL QILISH.
   *
   * Tekshiruvlar ketma-ketligi (§9.2) — ARZONDAN QIMMATGA:
   *   1) fayl bormi va bo'sh emasmi;
   *   2) birinchi bayt `0xE9`;
   *   3) hajmi OTA bo'limiga sig'adimi;
   *   4) ichida `ANDIJON_FW_VERSION=x.y.z;` (eski fayllarda boshqa prefiks)
   *      va `ANDIJON_FW_MODULE=kotyol|xona;` belgilari (`firmware-marker.helper`);
   *   5) belgidagi versiya kiritilgani bilan mos keladimi;
   *   6) SHA-256 hisoblanadi;
   *   7) bazada takror yo'qmi.
   *
   * ⚠️⚠️ FAYL BAZAGA YOZILGANDAN KEYIN diskka saqlanadi va baza
   * yozuvi muvaffaqiyatsiz bo'lsa fayl O'CHIRILADI. Teskari tartibda
   * (avval diskka, keyin bazaga) qilinsa, baza xatosi diskda
   * «yetim» fayllar qoldirardi va keyingi yuklashda ular bilan
   * to'qnashuv chiqardi.
   */
  async upload(
    file: { buffer: Buffer; size: number; originalname: string } | undefined,
    declaredVersion: string | undefined,
    note: string | undefined,
    user: AuthUser,
    declaredType?: DeviceType,
  ): Promise<ReleaseRow> {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Proshivka fayli yuborilmagan');
    }

    const buffer = file.buffer;

    // ─── 2. ESP32 obrazi ───
    if (buffer[0] !== ESP32_IMAGE_MAGIC) {
      throw new BadRequestException(
        'Bu ESP32 proshivkasi emas: fayl 0xE9 bayti bilan boshlanishi kerak',
      );
    }

    // ─── 3. OTA bo'limiga sig'adimi ───
    if (buffer.length > OTA_PARTITION_MAX_BYTES) {
      throw new BadRequestException(
        `Fayl juda katta: ${buffer.length} bayt, ` +
          `OTA bo‘limi esa ${OTA_PARTITION_MAX_BYTES} bayt`,
      );
    }

    // ─── 4–5. Versiya belgisi (ANDIJON ustun) va MODUL TURI ───
    let identity: ReturnType<typeof resolveFirmwareIdentity>;
    try {
      identity = resolveFirmwareIdentity(
        readFirmwareMarkers(buffer),
        declaredType ?? null,
        declaredVersion?.trim() || null,
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
    const { version, deviceType } = identity;
    if (!VERSION_PATTERN.test(version)) {
      throw new BadRequestException(
        `Versiya formati noto‘g‘ri: «${version}» (kutilgan: x.y.z)`,
      );
    }

    // ─── 6. SHA-256 — SERVERDA hisoblanadi ───
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // ─── 7. Takror ───
    const clash = await this.releases.findOne({
      where: [{ version, deviceType }, { sha256 }],
      select: { id: true, version: true, sha256: true, deviceType: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.version === version && clash.deviceType === deviceType
          ? `«${version}» versiyasi (${DEVICE_TYPE_LABEL[deviceType]}) allaqachon yuklangan`
          : `Aynan shu fayl «${clash.version}» versiyasi sifatida yuklangan`,
      );
    }

    // ─── Saqlash ───
    const dir = resolve(
      this.config.get<string>('firmware.dir') ?? './storage/firmware',
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });

    /*
     * ⚠️ Xona relizi ALOHIDA nom bilan: versiya har tur ichida yagona, ya'ni
     * xona 2.0.0 va qozonxona 2.0.0 birga bo'lishi mumkin. Qozonxona
     * nomi O'ZGARMAYDI — mavjud fayllar shu nom bilan yozilgan.
     */
    // ⚠️ Turi fayl nomida ham: ikki tur bir xil versiya raqamini olishi mumkin.
    const fileName = `firmware-${deviceType}-${version}.bin`;
    const fullPath = resolve(dir, fileName);

    /*
     * ⚠️ `flag: 'wx'` — fayl ALLAQACHON bo'lsa xato beradi, ustiga
     * yozmaydi. Bazada yozuv yo'q, lekin diskda fayl bor degani —
     * oldingi yuklash yarim qolgan. Ustiga jimgina yozilsa, o'sha
     * eski (ehtimol yaroqsiz) fayl yangi versiya nomi bilan
     * tarqatilardi.
     */
    try {
      await writeFile(fullPath, buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'EEXIST') {
        throw new ConflictException(
          `Diskda «${fileName}» fayli allaqachon bor — ` +
            'oldingi yuklash yarim qolgan, administrator tekshirishi kerak',
        );
      }
      throw error;
    }

    try {
      const saved = await this.releases.save(
        this.releases.create({
          version,
          deviceType,
          typeSource: identity.typeSource,
          markerPrefix: identity.prefix,
          // ⚠️ Faqat FAYL NOMI saqlanadi, to'liq yo'l EMAS: papka
          //    `.env` bilan ko'chishi mumkin va to'liq yo'l bazada
          //    qotib qolsa, ko'chgandan keyin hamma reliz «yo'q»
          //    bo'lib qolardi.
          filePath: fileName,
          sha256,
          size: buffer.length,
          note: note?.trim() || null,
          uploadedById: user.id,
        }),
      );

      this.logger.log(
        `Proshivka yuklandi: ${version} [${deviceType}, ${identity.typeSource}] (${buffer.length} bayt, ` +
          `sha256 ${sha256.slice(0, 12)}…)`,
      );
      return this.toRow(saved, null);
    } catch (error) {
      /*
       * ⚠️ Baza yozuvi yiqilsa, fayl O'CHIRILADI: aks holda diskda
       * yozuvsiz fayl qolib, keyingi yuklash `EEXIST` bilan to'xtardi
       * va administrator sababini tushunmasdi.
       */
      await unlink(fullPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * YUKLASHDAN OLDIN KO'RISH — panel tur tanlovini to'ldirishi uchun.
   *
   * ⚠️ Faylni SAQLAMAYDI va bazaga yozmaydi: faqat `upload` bilan AYNI
   * tekshiruvlarni (0xE9, hajm, belgilar) bajarib, natijani qaytaradi.
   */
  inspect(
    file: { buffer: Buffer; size: number; originalname: string } | undefined,
  ): FirmwareInspection & {
    size: number;
    sha256: string;
    isEsp32Image: boolean;
    fitsPartition: boolean;
    maxSize: number;
  } {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Proshivka fayli yuborilmagan');
    }
    const buffer = file.buffer;
    const inspected = inspectFirmwareMarkers(readFirmwareMarkers(buffer));
    const isEsp32Image = buffer[0] === ESP32_IMAGE_MAGIC;
    const fitsPartition = buffer.length <= OTA_PARTITION_MAX_BYTES;
    return {
      ...inspected,
      error: !isEsp32Image
        ? 'Bu ESP32 proshivkasi emas: fayl 0xE9 bayti bilan boshlanishi kerak'
        : !fitsPartition
          ? `Fayl juda katta: ${buffer.length} bayt (chegara ${OTA_PARTITION_MAX_BYTES})`
          : inspected.error,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      isEsp32Image,
      fitsPartition,
      maxSize: OTA_PARTITION_MAX_BYTES,
    };
  }

  async listReleases(): Promise<ReleaseRow[]> {
    const rows = await this.releases.find({
      relations: { uploadedBy: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toRow(row, row.uploadedBy?.fullName ?? null));
  }

  /**
   * RELIZNI ARXIVLASH.
   *
   * ⚠️ O'CHIRILMAYDI: qurilmalarda o'sha versiya hali ishlab turgan
   * bo'lishi mumkin va OTA tarixi («2.0.1 ga yangilandi») reliz
   * yozuvisiz o'qilmas bo'lib qolardi. Arxivlangan reliz boshqa
   * tarqatilmaydi va yuklab olinmaydi.
   */
  async archiveRelease(id: string): Promise<{ archived: true }> {
    const release = await this.releases.findOne({ where: { id } });
    if (!release) throw new NotFoundException('Reliz topilmadi');

    const active = await this.rollouts.findOne({
      where: { releaseId: id, status: RolloutStatus.ACTIVE },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException(
        'Bu reliz hozir tarqatilmoqda — avval tarqatishni to‘xtatish kerak',
      );
    }

    await this.releases.update(id, { isArchived: true });
    return { archived: true };
  }

  // ═══════════════════════ TARQATISH ═══════════════════════

  /**
   * TARQATISHNI BOSHLASH.
   *
   * ⚠️⚠️ BIR VAQTDA FAQAT BITTA faol tarqatish — BAZADA kafolatlangan
   * (`UQ_firmware_rollouts_one_active`). Bu yerda ham tekshiriladi,
   * lekin faqat TUSHUNARLI XABAR berish uchun: haqiqiy himoya
   * bazada, chunki ikki administrator bir vaqtda tugmani bossa,
   * ilovadagi tekshiruv ikkalasini ham o'tkazib yuborardi.
   */
  async createRollout(
    dto: CreateRolloutDto,
    user: AuthUser,
  ): Promise<{ id: string; targetCount: number }> {
    const release = await this.releases.findOne({
      where: { id: dto.releaseId },
    });
    if (!release) throw new NotFoundException('Reliz topilmadi');
    if (release.isArchived) {
      throw new ConflictException('Arxivlangan relizni tarqatib bo‘lmaydi');
    }

    const ids = dto.targetIds ?? [];
    if (dto.targetType !== RolloutTargetType.ALL && ids.length === 0) {
      throw new BadRequestException(
        'Maqsad ro‘yxati bo‘sh — kimga tarqatilishini tanlash kerak',
      );
    }

    /*
     * ⚠️⚠️ QO'LDA TANLANGAN QURILMALAR — relizning turiga mos bo'lishi
     * SHART. OTA mos kelmaganiga baribir bermaydi, lekin tarqatish
     * «tugamagan» bo'lib abadiy osilib qolardi va administrator sababini
     * ko'rmasdi. Shuning uchun xato shu yerda, aniq aytiladi.
     */
    if (dto.targetType === RolloutTargetType.DEVICES) {
      const mismatched = await this.devices.find({
        where: { id: In(ids) },
        select: { id: true, deviceId: true, deviceType: true },
      });
      const wrong = mismatched.filter(
        (device) => device.deviceType !== release.deviceType,
      );
      if (wrong.length > 0) {
        throw new BadRequestException(
          `Bu reliz ${DEVICE_TYPE_LABEL[release.deviceType]} uchun, tanlanganlar ` +
            `orasida boshqa turdagi modul bor: ` +
            wrong
              .slice(0, 5)
              .map((device) => device.deviceId)
              .join(', ') +
            (wrong.length > 5 ? ` va yana ${wrong.length - 5}` : ''),
        );
      }
    }

    try {
      const saved = await this.rollouts.save(
        this.rollouts.create({
          releaseId: release.id,
          deviceType: release.deviceType,
          status: RolloutStatus.ACTIVE,
          targetType: dto.targetType,
          targetIds: ids,
          /*
           * ⚠️⚠️ SUKUT — 1 TA QURILMADA SINOV (§5.5). Keyingi bosqichlar
           * `setRolloutLimit` bilan (10 → 50 → cheklovsiz). Chegara
           * aytilmasa butun viloyat bir zumda yangilanib, yaroqsiz
           * proshivka hamma platani birdan halqaga solardi.
           */
          maxDevices: dto.maxDevices === undefined ? 1 : dto.maxDevices,
          note: dto.note?.trim() || null,
          createdById: user.id,
        }),
      );

      const targetCount = await this.countTargets(saved);
      this.logger.log(
        `Tarqatish boshlandi: ${release.version} → ${dto.targetType} ` +
          `(${targetCount} qurilma` +
          `, bosqich: ${dto.maxDevices === undefined ? 1 : (dto.maxDevices ?? '∞')}` +
          ')',
      );
      return { id: saved.id, targetCount };
    } catch (error) {
      const code = (
        error as { code?: unknown; driverError?: { code?: unknown } }
      )?.driverError?.code;
      if (code === '23505') {
        throw new ConflictException(
          `${DEVICE_TYPE_LABEL[release.deviceType]} uchun allaqachon faol tarqatish ` +
            'bor — avval uni to‘xtatish kerak',
        );
      }
      throw error;
    }
  }

  /**
   * TARQATISH HOLATINI O'ZGARTIRISH.
   *
   * ⚠️ `paused` va `cancelled` AJRATILGAN: to'xtatilganini davom
   * ettirish mumkin, bekor qilingani esa tarixda qoladi. Bitta holat
   * bo'lsa, administrator «to'xtatdim» deb o'ylab, aslida qaytarib
   * bo'lmas qarorni qabul qilardi.
   */
  async setRolloutStatus(
    id: string,
    status: RolloutStatus,
  ): Promise<{ status: RolloutStatus }> {
    const rollout = await this.rollouts.findOne({ where: { id } });
    if (!rollout) throw new NotFoundException('Tarqatish topilmadi');

    if (
      rollout.status === RolloutStatus.DONE ||
      rollout.status === RolloutStatus.CANCELLED
    ) {
      throw new ConflictException(
        'Tugagan yoki bekor qilingan tarqatishni o‘zgartirib bo‘lmaydi',
      );
    }

    if (status === RolloutStatus.ACTIVE) {
      const other = await this.rollouts.findOne({
        where: { status: RolloutStatus.ACTIVE, deviceType: rollout.deviceType },
        select: { id: true },
      });
      if (other && other.id !== id) {
        throw new ConflictException(
          `${DEVICE_TYPE_LABEL[rollout.deviceType]} uchun boshqa tarqatish faol — ` +
            'avval uni to‘xtatish kerak',
        );
      }
    }

    await this.rollouts.update(id, {
      status,
      ...(status === RolloutStatus.CANCELLED || status === RolloutStatus.DONE
        ? { finishedAt: new Date() }
        : {}),
    });

    this.logger.log(`Tarqatish ${id}: holat → ${status}`);
    return { status };
  }

  /**
   * BOSQICHNI KENGAYTIRISH — bir vaqtda nechta qurilma yangilanadi.
   *
   * ⚠️ Chegara hisobi «taklif qilingan / o'rnatilgan / tasdiqlangan»
   * qurilmalar soni bo'yicha (`OtaService.hasFreeSlot`): 1 → 10 qilinsa,
   * sinovdagi qurilma qayta hisoblanmaydi, yana 9 tasiga taklif ochiladi.
   * `null` — cheklovsiz (oxirgi bosqich).
   */
  async setRolloutLimit(
    id: string,
    maxDevices: number | null,
  ): Promise<{ maxDevices: number | null }> {
    const rollout = await this.rollouts.findOne({ where: { id } });
    if (!rollout) throw new NotFoundException('Tarqatish topilmadi');
    if (
      rollout.status === RolloutStatus.DONE ||
      rollout.status === RolloutStatus.CANCELLED
    ) {
      throw new ConflictException(
        'Tugagan yoki bekor qilingan tarqatishni o‘zgartirib bo‘lmaydi',
      );
    }
    await this.rollouts.update(id, { maxDevices });
    this.logger.log(`Tarqatish ${id}: bosqich → ${maxDevices ?? 'cheklovsiz'}`);
    return { maxDevices };
  }

  async listRollouts(): Promise<
    Array<{
      id: string;
      version: string;
      deviceType: DeviceType;
      status: RolloutStatus;
      targetType: RolloutTargetType;
      targetIds: string[];
      maxDevices: number | null;
      note: string | null;
      createdAt: Date;
      finishedAt: Date | null;
    }>
  > {
    const rows = await this.rollouts.find({
      relations: { release: true },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      version: row.release?.version ?? '—',
      deviceType: row.deviceType,
      status: row.status,
      targetType: row.targetType,
      targetIds: row.targetIds ?? [],
      maxDevices: row.maxDevices,
      note: row.note,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
  }

  /**
   * TARQATISH JARAYONI — har bir qurilma uchun holat (§9.5).
   *
   * ⚠️⚠️ HOLAT ALOHIDA JADVALDA SAQLANMAYDI, `ota_events` dan
   * HISOBLANADI. Ikkinchi joyda holat yuritilsa, u hodisalar bilan
   * rost-yolg'on bo'lib ajralib ketardi: ekranda «o'rnatildi»,
   * tarixda esa «xato» turardi.
   *
   * ⚠️ «Kutilmoqda» — maqsadga kiradigan, lekin birorta hodisasi
   * yo'q qurilma. Uni ro'yxatdan tushirib qoldirish eng muhim
   * savolni javobsiz qoldirardi: «nechta qurilma hali
   * yangilanmagan?».
   */
  async rolloutProgress(id: string): Promise<{
    version: string;
    status: RolloutStatus;
    total: number;
    counts: Record<string, number>;
    devices: Array<{
      deviceId: string;
      name: string | null;
      state: string;
      message: string | null;
      at: Date | null;
    }>;
  }> {
    const rollout = await this.rollouts.findOne({
      where: { id },
      relations: { release: true },
    });
    if (!rollout) throw new NotFoundException('Tarqatish topilmadi');

    const version = rollout.release?.version ?? '';
    const targetIds = await this.targetDeviceIds(rollout);

    const devices =
      targetIds.length === 0
        ? []
        : await this.devices.find({
            where: { id: In(targetIds) },
            select: { id: true, deviceId: true, name: true },
            order: { deviceId: 'ASC' },
          });

    /*
     * ⚠️ Har bir qurilmaning OXIRGI hodisasi olinadi. `DISTINCT ON`
     * — PostgreSQL imkoniyati va u window funksiyadan arzonroq;
     * indeks `(device_id, created_at DESC)` aynan shu so'rov uchun
     * yasalgan.
     */
    /*
     * ⚠️ `query()` `any` qaytaradi — natija ANIQ tipga bog'lanadi.
     * Tipsiz qoldirilsa, ustun nomi o'zgarganda (masalan `at` →
     * `created_at`) kompilyator jim qolib, ekranda bo'sh ustun
     * paydo bo'lardi.
     */
    type LatestRow = {
      deviceUuid: string;
      status: string;
      message: string | null;
      at: Date;
    };

    const latest: LatestRow[] =
      targetIds.length === 0
        ? []
        : await this.events.query<LatestRow[]>(
            `SELECT DISTINCT ON (device_id)
               device_id AS "deviceUuid", status, message, created_at AS "at"
             FROM ota_events
             WHERE target_version = $1 AND device_id = ANY($2::uuid[])
             ORDER BY device_id, created_at DESC`,
            [version, targetIds],
          );

    const byDevice = new Map<
      string,
      { status: string; message: string | null; at: Date }
    >(
      latest.map((row) => [
        row.deviceUuid,
        { status: row.status, message: row.message, at: row.at },
      ]),
    );

    const counts: Record<string, number> = {
      pending: 0,
      [OtaEventStatus.OFFERED]: 0,
      [OtaEventStatus.INSTALLED]: 0,
      [OtaEventStatus.OK]: 0,
      [OtaEventStatus.FAILED]: 0,
      [OtaEventStatus.ROLLED_BACK]: 0,
    };

    const rows = devices.map((device) => {
      const event = byDevice.get(device.id);
      const state = event?.status ?? 'pending';
      counts[state] = (counts[state] ?? 0) + 1;
      return {
        deviceId: device.deviceId,
        name: device.name,
        state,
        message: event?.message ?? null,
        at: event?.at ?? null,
      };
    });

    return {
      version,
      status: rollout.status,
      total: devices.length,
      counts,
      devices: rows,
    };
  }

  // ═══════════════════════ BLOKLAR ═══════════════════════

  async listBlocks(): Promise<
    Array<{
      id: string;
      deviceId: string;
      version: string;
      failCount: number;
      isBlocked: boolean;
      reason: string | null;
      createdAt: Date;
    }>
  > {
    const rows = await this.blocks.find({
      relations: { device: true },
      order: { updatedAt: 'DESC' },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device?.deviceId ?? '—',
      version: row.version,
      failCount: row.failCount,
      isBlocked: row.isBlocked,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
  }

  /**
   * «QAYTA URINISH» TUGMASI (§9.4).
   *
   * ⚠️ Blok O'CHIRILADI, `is_blocked = false` qilinmaydi: xato hisobi
   * ham nolga qaytishi kerak. Faqat bayroq o'chirilsa, `fail_count`
   * 3 da qolib, keyingi birinchi xato darhol qayta bloklab qo'yardi
   * — ya'ni «qayta urinish» amalda bir martalik bo'lib qolardi.
   */
  async clearBlock(id: string): Promise<{ cleared: true }> {
    const block = await this.blocks.findOne({ where: { id } });
    if (!block) throw new NotFoundException('Blok topilmadi');
    await this.blocks.delete(id);
    this.logger.log(`Blok olib tashlandi: ${block.version}`);
    return { cleared: true };
  }

  // ═══════════════════════ Yordamchilar ═══════════════════════

  private toRow(row: FirmwareRelease, uploadedBy: string | null): ReleaseRow {
    return {
      id: row.id,
      version: row.version,
      deviceType: row.deviceType,
      typeSource: row.typeSource,
      markerPrefix: row.markerPrefix,
      size: row.size,
      sha256: row.sha256,
      note: row.note,
      isArchived: row.isArchived,
      createdAt: row.createdAt,
      uploadedBy,
    };
  }

  private async countTargets(rollout: FirmwareRollout): Promise<number> {
    const ids = await this.targetDeviceIds(rollout);
    return ids.length;
  }

  private async targetDeviceIds(rollout: FirmwareRollout): Promise<string[]> {
    const qb = this.devices
      .createQueryBuilder('device')
      .select('device.id', 'id');
    if (!applyRolloutTarget(qb, rollout)) return [];
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }
}
