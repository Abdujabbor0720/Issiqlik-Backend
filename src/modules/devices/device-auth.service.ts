import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, DeviceType } from '../../common/constants/enums';
import { Device } from '../../database/entities/device.entity';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { decideDeviceType } from '../../helpers/device-profile.helper';
import { AuditService } from '../audit/audit.service';
import { DeviceKeyService } from './device-key.service';

export type TokenKind = 'personal' | 'shared';

/**
 * Autentifikatsiyadan keyin servislarga beriladigan qurilma ko'rinishi.
 *
 * ⚠️ `apiKeyHash` bu yerda YO'Q: u faqat tekshiruv uchun o'qiladi va
 * qurilma obyekti telemetriya servisi bo'ylab tarqaladi — hash tasodifan
 * jurnalga yoki javobga tushib qolmasligi kerak.
 */
export type AuthenticatedDevice = Pick<
  Device,
  | 'id'
  | 'deviceId'
  | 'boilerId'
  | 'isActive'
  | 'institutionHint'
  | 'allowSharedToken'
  | 'firmwareVersion'
  | 'districtId'
  | 'organizationId'
  | 'reportedDistrict'
  | 'deviceType'
  | 'reportedMfy'
  | 'reportedInstitution'
  | 'reportedObjectType'
  | 'lastTokenKind'
>;

const AUTH_SELECT = {
  id: true,
  deviceId: true,
  apiKeyHash: true,
  allowSharedToken: true,
  institutionHint: true,
  firmwareVersion: true,
  boilerId: true,
  isActive: true,
  districtId: true,
  organizationId: true,
  reportedDistrict: true,
  deviceType: true,
  reportedMfy: true,
  reportedInstitution: true,
  reportedObjectType: true,
  lastTokenKind: true,
} as const;

export interface DeviceAuthResult {
  device: AuthenticatedDevice;
  tokenKind: TokenKind;
}

/**
 * So'rov haqidagi qo'shimcha ma'lumot — FAQAT «Yangi qurilmalar»
 * ro'yxati uchun. Ro'yxatdagi qurilmaning joylashuviga bu yerda TEGILMAYDI.
 */
export interface DeviceRequestMeta {
  ip: string | null;
  firmwareVersion: string | null;
  /** Eski proshivkaning `institution_id` (`maktab-4`). */
  institutionHint?: string | null;
  /** Aytilgan (`X-Device-Type`) yoki tanadan aniqlangan tur. */
  deviceType?: DeviceType | null;
  /** Plata aytgan joylashuv — allaqachon TEKSHIRILGAN (tanilgan kalitlar). */
  reportedDistrictKey?: string | null;
  reportedObjectType?: string | null;
  reportedInstitution?: string | null;
}

/**
 * KUTISH RO'YXATI CHEGARASI.
 *
 * ⚠️ Begona odam tasodifiy identifikatorlar bilan so'rov yuborib, jadvalni
 * cheksiz to'ldirishi mumkin. Chegaraga yetganda YANGI qator yozilmaydi,
 * mavjudlari esa yangilanaveradi.
 */
const PENDING_DEVICES_LIMIT = 200;

/** Bir xil ogohlantirish bitta qurilma uchun shundan tez-tez yozilmaydi. */
const TYPE_WARN_INTERVAL_MS = 30 * 60_000;

/**
 * QURILMA AUTENTIFIKATSIYASI — telemetriya ham, OTA ham SHU YERDAN o'tadi.
 *
 * Javob kodlari (qurilma xatti-harakati shunga bog'liq, §4):
 *   • 401 — token yo'q yoki xato;
 *   • 403 — qurilma ro'yxatda yo'q → «Yangi qurilmalar» ro'yxatiga yoziladi.
 *
 * ⚠️⚠️ AVTOMATIK RO'YXATGA OLISH YO'Q. Ro'yxatda yo'q `device_id` HAR DOIM
 * 403 oladi — hatto to'g'ri umumiy token bilan ham. Qurilmani faqat admin
 * «Yangi qurilmalar» dan bir bosishda ro'yxatga oladi va joylashuvini
 * tasdiqlaydi. Busiz umumiy token sizib chiqsa, begona odam viloyat
 * paneliga istalgancha soxta qurilma qo'sha olardi.
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);
  private readonly typeWarnedAt = new Map<string, number>();

  constructor(
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(PendingDevice)
    private readonly pending: Repository<PendingDevice>,
    private readonly keys: DeviceKeyService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async authenticate(
    deviceId: string | null | undefined,
    token: string | null,
    meta: DeviceRequestMeta,
  ): Promise<DeviceAuthResult> {
    // ⚠️ Token BIRINCHI: tokensiz so'rov hech qachon 403 / kutish ro'yxatiga yetmaydi.
    if (!token) {
      throw new UnauthorizedException('Qurilma tokeni yuborilmagan');
    }
    if (!deviceId) {
      throw new UnauthorizedException('Qurilma identifikatori yuborilmagan');
    }

    const device = await this.devices.findOne({
      where: { deviceId },
      select: AUTH_SELECT,
    });

    if (!device) {
      await this.notePending(deviceId, token, meta);
      throw new ForbiddenException(
        'Qurilma ro‘yxatda yo‘q — panelda «Yangi qurilmalar» bo‘limidan tasdiqlanishi kerak',
      );
    }

    const tokenKind = this.verifyToken(token, device);
    if (!tokenKind) {
      throw new UnauthorizedException(
        'Qurilma identifikatori yoki kaliti noto‘g‘ri',
      );
    }

    if (!device.isActive) {
      throw new UnauthorizedException('Qurilma faolsizlantirilgan');
    }

    // ⚠️ Faqat O'ZGARGANDA yoziladi — har signalda UPDATE bo'lmasligi uchun.
    if (device.lastTokenKind !== tokenKind) {
      await this.devices
        .update(device.id, { lastTokenKind: tokenKind })
        .catch(() => undefined);
      if (tokenKind === 'shared') {
        this.logger.warn(
          `Qurilma ${device.deviceId} UMUMIY token bilan ulandi — ` +
            'shaxsiy token berish tavsiya qilinadi',
        );
      }
      device.lastTokenKind = tokenKind;
    }

    const { apiKeyHash: _hash, ...safe } = device;
    void _hash;
    return { device: safe, tokenKind };
  }

  /**
   * QURILMA TURINI SAQLASH (`decideDeviceType` qoidasi bilan).
   *
   * ⚠️⚠️ Bitta kotyolga bitta KOTYOL moduli: xona moduli «kotyol» bo'lib
   * qolsa va kotyolda boshqa kotyol moduli bo'lsa, tur o'zgartirilmaydi.
   *
   * @returns Tur haqiqatan o'zgardimi.
   */
  async applyDeviceType(
    device: AuthenticatedDevice,
    input: { declared: DeviceType | null; inferred: DeviceType | null },
  ): Promise<boolean> {
    const decision = decideDeviceType({ ...input, stored: device.deviceType });
    if (decision.warning) this.warnType(device.deviceId, decision.warning);
    const next = decision.next;
    if (!next) return false;

    const previous = device.deviceType;
    try {
      const qb = this.devices
        .createQueryBuilder()
        .update(Device)
        .set({ deviceType: next })
        .where('id = :id', { id: device.id })
        .andWhere('device_type = :previous', { previous });

      if (next === DeviceType.KOTYOL && device.boilerId) {
        qb.andWhere(
          `NOT EXISTS (SELECT 1 FROM devices other
             WHERE other.boiler_id = :boilerId
               AND other.device_type = 'kotyol'
               AND other.id <> :id)`,
          { boilerId: device.boilerId, id: device.id },
        );
      }

      const result = await qb.execute();
      if (!result.affected) {
        this.logger.warn(
          `Qurilma ${device.deviceId}: tur «${next}» yozilmadi — ` +
            'ulangan kotyolda boshqa kotyol moduli bor yoki tur parallel o‘zgargan',
        );
        return false;
      }
    } catch (error) {
      this.logger.warn(
        `Qurilma ${device.deviceId}: turini yozib bo‘lmadi — ` +
          (isUniqueViolation(error)
            ? 'kotyolda boshqa kotyol moduli bor'
            : error instanceof Error
              ? error.message
              : String(error)),
      );
      return false;
    }

    device.deviceType = next;
    await this.audit
      .log({
        action: AuditAction.UPDATE,
        entityName: 'Device',
        entityId: device.id,
        summary: `Qurilma ${device.deviceId} turi: ${previous} → ${next} (qurilma o‘zi aytdi)`,
        before: { deviceType: previous },
        after: { deviceType: next },
      })
      .catch(() => undefined);
    return true;
  }

  /** Umumiy token yoqilganmi (`.env` da `DEVICE_SHARED_TOKEN`). */
  sharedTokenEnabled(): boolean {
    return this.sharedToken().length > 0;
  }

  private sharedToken(): string {
    return this.config.get<string>('telemetry.sharedDeviceToken')?.trim() ?? '';
  }

  private isSharedToken(token: string): boolean {
    const shared = this.sharedToken();
    if (!shared) return false;
    return this.keys.matches(token, this.keys.hash(shared));
  }

  private verifyToken(
    token: string,
    device: Pick<Device, 'apiKeyHash' | 'allowSharedToken'>,
  ): TokenKind | null {
    if (this.keys.matches(token, device.apiKeyHash)) return 'personal';
    // ⚠️ Ruxsat berilmagan qurilmada umumiy token UMUMAN tekshirilmaydi.
    if (!device.allowSharedToken) return null;
    return this.isSharedToken(token) ? 'shared' : null;
  }

  private warnType(deviceId: string, message: string): void {
    const key = `${deviceId}|${message}`;
    const now = Date.now();
    const last = this.typeWarnedAt.get(key);
    if (last !== undefined && now - last < TYPE_WARN_INTERVAL_MS) return;
    if (this.typeWarnedAt.size > 5_000) this.typeWarnedAt.clear();
    this.typeWarnedAt.set(key, now);
    this.logger.warn(`Qurilma ${deviceId}: ${message}`);
  }

  /**
   * «YANGI QURILMALAR» RO'YXATIGA YOZISH.
   *
   * ⚠️⚠️ HAR SO'ROVDA YANGI QATOR EMAS — `device_id` UNIQUE, hisoblagich
   * oshiriladi. Token O'ZI emas, faqat hash'i saqlanadi: ro'yxatga olishda u
   * qurilmaning shaxsiy kaliti bo'ladi va dalada turgan plata o'z tokenini
   * o'zgartirmasdan ishlay boshlaydi.
   *
   * ⚠️ Bir xil `device_id` bilan BOSHQA token kelsa — `token_conflict`:
   * kimdir haqiqiy plata identifikatoridan foydalanayotgan bo'lishi mumkin
   * va bunday so'rov bir bosishda ro'yxatga olinmaydi.
   *
   * ⚠️ XATOSI YUTILADI: bu yozuv faqat ma'lumot, qurilma baribir 403 oladi.
   */
  private async notePending(
    deviceId: string,
    token: string,
    meta: DeviceRequestMeta,
  ): Promise<void> {
    try {
      const now = new Date();
      const shared = this.isSharedToken(token);
      const tokenHash = this.keys.hash(token);
      const fields: Partial<PendingDevice> = {
        lastSeenAt: now,
        lastIpAddress: meta.ip?.slice(0, 45) ?? null,
        firmwareVersion: meta.firmwareVersion ?? null,
        tokenKind: shared ? 'shared' : 'personal',
        tokenHash: shared ? null : tokenHash,
        tokenPreview: shared ? null : this.keys.preview(token),
      };
      // ⚠️ Kelmagan maydon oxirgi ma'lum qiymatni O'CHIRMAYDI.
      if (meta.institutionHint) fields.institutionHint = meta.institutionHint;
      if (meta.deviceType) fields.deviceType = meta.deviceType;
      if (meta.reportedDistrictKey)
        fields.reportedDistrict = meta.reportedDistrictKey;
      if (meta.reportedObjectType)
        fields.reportedObjectType = meta.reportedObjectType;
      if (meta.reportedInstitution)
        fields.reportedInstitution = meta.reportedInstitution;

      const existing = await this.pending.findOne({
        where: { deviceId },
        select: { id: true, tokenHash: true, tokenKind: true },
      });

      if (existing) {
        const conflict =
          existing.tokenKind !== null &&
          (existing.tokenKind !== fields.tokenKind ||
            (fields.tokenKind === 'personal' &&
              existing.tokenHash !== null &&
              existing.tokenHash !== tokenHash));
        await this.pending.update(existing.id, {
          ...fields,
          ...(conflict ? { tokenConflict: true } : {}),
          attempts: (): string => '"attempts" + 1',
        });
        if (conflict) {
          this.logger.warn(
            `«Yangi qurilma» ${deviceId}: OLDINGIDAN BOSHQA token bilan keldi — ` +
              'bir bosishda ro‘yxatga olish o‘chirildi',
          );
        }
        return;
      }

      const open = await this.pending.count({ where: { isDismissed: false } });
      if (open >= PENDING_DEVICES_LIMIT) {
        this.logger.warn(
          `Kutish ro‘yxati to‘ldi (${PENDING_DEVICES_LIMIT}) — ${deviceId} yozilmadi`,
        );
        return;
      }

      await this.pending.insert({ ...fields, deviceId, attempts: 1 });
      this.logger.warn(
        `YANGI QURILMA so‘rayapti: ${deviceId}` +
          (meta.deviceType ? ` (${meta.deviceType})` : '') +
          (meta.reportedDistrictKey
            ? `, tuman: ${meta.reportedDistrictKey}`
            : ''),
      );
    } catch (error) {
      if (isUniqueViolation(error)) return;
      this.logger.warn(
        'Kutish ro‘yxatiga yozib bo‘lmadi: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
