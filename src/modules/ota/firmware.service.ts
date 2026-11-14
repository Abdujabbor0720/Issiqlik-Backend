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
  OtaEventStatus,
  RolloutStatus,
  RolloutTargetType,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Device } from '../../database/entities/device.entity';
import {
  FW_VERSION_MARKER,
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  OTA_PARTITION_MAX_BYTES,
  OtaEvent,
} from '../../database/entities/firmware.entities';
import type { CreateRolloutDto } from './dto/firmware.dto';

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

export interface ReleaseRow {
  id: string;
  version: string;
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
   *   4) ichida `XONOBOD_FW_VERSION=x.y.z;` belgisi bormi;
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

    // ─── 4–5. Ichidagi versiya belgisi ───
    const markerVersion = this.readVersionMarker(buffer);
    if (!markerVersion) {
      throw new BadRequestException(
        `Fayl ichida «${FW_VERSION_MARKER}x.y.z;» belgisi topilmadi — ` +
          'bu proshivka OTA uchun yig‘ilmagan',
      );
    }

    /*
     * ⚠️⚠️ QO'LDA KIRITILGAN VERSIYAGA ISHONILMAYDI. §9.2 aynan shuni
     * talab qiladi: «qo'lda kiritilgan versiya bilan mos kelmasa, rad
     * et». Busiz administrator eski faylni yangi raqam bilan yuklab,
     * «hammasi 2.0.2 da» deb hisobot berardi — qurilmalarda esa
     * 2.0.1 ishlab turardi va xato topilmasdi.
     */
    const declared = declaredVersion?.trim();
    if (declared && declared !== markerVersion) {
      throw new BadRequestException(
        `Versiya mos emas: fayl ichida «${markerVersion}», ` +
          `kiritilgani «${declared}»`,
      );
    }

    const version = markerVersion;
    if (!VERSION_PATTERN.test(version)) {
      throw new BadRequestException(
        `Versiya formati noto‘g‘ri: «${version}» (kutilgan: x.y.z)`,
      );
    }

    // ─── 6. SHA-256 — SERVERDA hisoblanadi ───
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // ─── 7. Takror ───
    const clash = await this.releases.findOne({
      where: [{ version }, { sha256 }],
      select: { id: true, version: true, sha256: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.version === version
          ? `«${version}» versiyasi allaqachon yuklangan`
          : `Aynan shu fayl «${clash.version}» versiyasi sifatida yuklangan`,
      );
    }

    // ─── Saqlash ───
    const dir = resolve(
      this.config.get<string>('firmware.dir') ?? './storage/firmware',
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const fileName = `firmware-${version}.bin`;
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
        `Proshivka yuklandi: ${version} (${buffer.length} bayt, ` +
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

    try {
      const saved = await this.rollouts.save(
        this.rollouts.create({
          releaseId: release.id,
          status: RolloutStatus.ACTIVE,
          targetType: dto.targetType,
          targetIds: ids,
          maxDevices: dto.maxDevices ?? null,
          note: dto.note?.trim() || null,
          createdById: user.id,
        }),
      );

      const targetCount = await this.countTargets(saved);
      this.logger.log(
        `Tarqatish boshlandi: ${release.version} → ${dto.targetType} ` +
          `(${targetCount} qurilma` +
          (dto.maxDevices ? `, sinov: ${dto.maxDevices}` : '') +
          ')',
      );
      return { id: saved.id, targetCount };
    } catch (error) {
      const code = (
        error as { code?: unknown; driverError?: { code?: unknown } }
      )?.driverError?.code;
      if (code === '23505') {
        throw new ConflictException(
          'Allaqachon faol tarqatish bor — avval uni to‘xtatish kerak',
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
        where: { status: RolloutStatus.ACTIVE },
        select: { id: true },
      });
      if (other && other.id !== id) {
        throw new ConflictException(
          'Boshqa tarqatish faol — avval uni to‘xtatish kerak',
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

  async listRollouts(): Promise<
    Array<{
      id: string;
      version: string;
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

  /**
   * `.bin` ICHIDAN VERSIYANI O'QISH.
   *
   * ⚠️⚠️ Belgi proshivkada QOTIRILGAN (`ota.cpp:30`):
   *   const char FW_VERSION_MARK[] = "XONOBOD_FW_VERSION=" FW_VERSION ";";
   * Shuning uchun u `.bin` ning ichida ODDIY MATN bo'lib yotadi va
   * uni `latin1` sifatida qidirish mumkin.
   *
   * ⚠️ `latin1` ATAYLAB, `utf8` EMAS: ikkilik faylda har qanday bayt
   * bo'lishi mumkin va `utf8` dekodlash yaroqsiz ketma-ketliklarni
   * `U+FFFD` bilan almashtirib, belgini ikkiga bo'lib tashlashi
   * mumkin. `latin1` esa bayt↔belgi mosligini BUZMAYDI.
   */
  private readVersionMarker(buffer: Buffer): string | null {
    const text = buffer.toString('latin1');
    const at = text.indexOf(FW_VERSION_MARKER);
    if (at < 0) return null;

    const start = at + FW_VERSION_MARKER.length;
    const end = text.indexOf(';', start);
    // ⚠️ Chegara: versiya 32 belgidan uzun bo'lishi mumkin emas —
    //    aks holda buzilgan faylda butun fayl «versiya» bo'lib ketardi.
    if (end < 0 || end - start > 32) return null;

    const version = text.slice(start, end).trim();
    return version.length > 0 ? version : null;
  }

  private toRow(row: FirmwareRelease, uploadedBy: string | null): ReleaseRow {
    return {
      id: row.id,
      version: row.version,
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

  /**
   * Tarqatish maqsadiga kiradigan qurilmalar.
   *
   * ⚠️ `OtaService.targetDeviceIds` bilan AYNI mantiq. Ikki nusxa
   * bo'lgani yomon, lekin bu yerda u faqat KO'RSATISH uchun
   * (jarayon ekrani, «nechta qurilmaga tegadi»), u yerda esa
   * QAROR uchun (tarqatish tugadimi). Bir-biridan ajralib ketmasligi
   * uchun ikkalasi ham AYNI SQL shartlarini ishlatadi va
   * o'zgartirilganda ikkalasi birga o'zgaradi.
   */
  private async targetDeviceIds(rollout: FirmwareRollout): Promise<string[]> {
    const ids = rollout.targetIds ?? [];

    if (rollout.targetType === RolloutTargetType.DEVICES) {
      if (ids.length === 0) return [];
      const rows = await this.devices.find({
        where: { id: In(ids), isActive: true },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    const qb = this.devices
      .createQueryBuilder('device')
      .select('device.id', 'id')
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
}
