import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../../database/entities/device.entity';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { DeviceKeyService } from './device-key.service';

/** Token qanday tekshirilgani — jurnal va kabinet uchun. */
export type TokenKind = 'personal' | 'shared';

/** Autentifikatsiya natijasida kerak bo'ladigan minimal to'plam. */
export type AuthenticatedDevice = Pick<
  Device,
  | 'id'
  | 'deviceId'
  | 'boilerId'
  | 'isActive'
  | 'institutionHint'
  | 'allowSharedToken'
  | 'firmwareVersion'
>;

export interface DeviceAuthResult {
  device: AuthenticatedDevice;
  tokenKind: TokenKind;
}

/** So'rov bilan birga kelgan qo'shimcha ma'lumot. */
export interface DeviceRequestMeta {
  ip: string | null;
  firmwareVersion: string | null;
  institutionHint?: string | null;
}

/**
 * KUTISH RO'YXATI CHEGARASI.
 *
 * ⚠️⚠️ BUSIZ JADVAL HUJUM VOSITASIGA AYLANARDI: begona odam har
 * so'rovda YANGI tasodifiy `device_id` yuborib, jadvalni cheksiz
 * to'ldirib, diskni to'ldirib qo'yishi mumkin bo'lardi (har bir yangi
 * identifikator — yangi qator). Chegaraga yetgandan keyin yangi
 * yozuvlar QABUL QILINMAYDI, faqat jurnalga tushadi.
 */
const PENDING_DEVICES_LIMIT = 200;

/**
 * QURILMA AUTENTIFIKATSIYASI — BUTUN TIZIMDA YAGONA joy.
 *
 * ⚠️⚠️ NIMA UCHUN ALOHIDA SERVIS. Qurilma serverga IKKI XIL maqsadda
 * murojaat qiladi va ularni IKKI XIL modul qabul qiladi:
 *   • telemetriya  → `TelemetryService.ingest`;
 *   • OTA          → `OtaService.check / download / report`.
 * Agar har biri tokenni O'ZICHA tekshirsa, ikki nusxa bir-biridan
 * asta-sekin ajralib ketardi — va bu ODDIY xato emas, XAVFSIZLIK
 * xatosi bo'lardi: masalan umumiy token taqiqlangani telemetriyada
 * tuzatilib, OTA'da ochiq qolishi mumkin edi. OTA esa ancha
 * xavflisi: u orqali qurilmaga YANGI KOD yuboriladi.
 *
 * ⚠️ Shu sababli bu yerda faqat QAROR qabul qilinadi, biznes mantig'i
 * yo'q: servis qurilmani topadi, tokenni tekshiradi va mos HTTP
 * xatosini tashlaydi.
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  constructor(
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(PendingDevice)
    private readonly pending: Repository<PendingDevice>,
    private readonly keys: DeviceKeyService,
    private readonly config: ConfigService,
  ) {}

  /**
   * QURILMANI TANIB OLISH.
   *
   * @throws UnauthorizedException (401) — token yo'q, noto'g'ri yoki
   *   qurilma faolsizlantirilgan.
   * @throws ForbiddenException (403) — qurilma ro'yxatda yo'q; so'rov
   *   kutish ro'yxatiga yoziladi.
   */
  async authenticate(
    deviceId: string | null | undefined,
    token: string | null,
    meta: DeviceRequestMeta,
  ): Promise<DeviceAuthResult> {
    if (!token) {
      throw new UnauthorizedException('Qurilma tokeni yuborilmagan');
    }
    if (!deviceId) {
      /*
       * ⚠️ 400 EMAS, 401: identifikatorsiz so'rov autentifikatsiyadan
       * o'tmaydi va uni «yuk formati buzuq» deb ko'rsatish qurilmaga
       * «o'lchovni tashla» degan noto'g'ri ishora berardi.
       */
      throw new UnauthorizedException('Qurilma identifikatori yuborilmagan');
    }

    const device = await this.devices.findOne({
      where: { deviceId },
      select: {
        id: true,
        deviceId: true,
        apiKeyHash: true,
        allowSharedToken: true,
        institutionHint: true,
        firmwareVersion: true,
        boilerId: true,
        isActive: true,
      },
    });

    /*
     * ⚠️⚠️ RO'YXATDA YO'Q QURILMA → 403 va KUTISH RO'YXATIGA yoziladi.
     *
     * Texnik topshiriq (§3) aynan shuni talab qiladi: «Ro'yxatda yo'q
     * device_id → 403 va dashboardda "yangi qurilma so'rayapti"
     * belgisi». Montajchi platani o'rnatib ketgan, kabinetda esa u
     * hali ro'yxatga kiritilmagan bo'lishi mumkin — signallari izsiz
     * yo'qolmasligi kerak.
     *
     * ⚠️ OSHKORLIK HAQIDA ONGLI KELISHUV: 403 (qurilma yo'q) va 401
     * (token xato) farq qilgani uchun, to'g'ri token egasi qaysi
     * identifikatorlar bazada borligini bilib olishi mumkin.
     * Identifikator MAC'dan olinadi (`esp32-` + 12 hex ≈ 2⁴⁸ variant)
     * — uni taxmin qilib bo'lmaydi, bilgani bilan ham tokensiz hech
     * narsa qilolmaydi. Kabinetdagi «yangi qurilma» bildirishnomasi
     * esa dala ishi uchun ZARUR.
     */
    if (!device) {
      await this.notePending(deviceId, meta);
      throw new ForbiddenException(
        'Qurilma ro‘yxatda yo‘q — kabinetda tasdiqlanishi kerak',
      );
    }

    const tokenKind = this.verifyToken(token, device);

    /*
     * ⚠️ «Qurilma topilmadi» va «kalit noto'g'ri» uchun xabar BIR XIL
     * bo'lib qolaveradi — bu yerda qurilma MAVJUD, demak farq faqat
     * tokendagi. Noaniq xabar brute-force urinishlarini
     * qiyinlashtiradi.
     */
    if (!tokenKind) {
      throw new UnauthorizedException(
        'Qurilma identifikatori yoki kaliti noto‘g‘ri',
      );
    }

    /*
     * ⚠️⚠️ UMUMIY TOKEN HAR ISHLATILISHIDA JURNALGA YOZILADI.
     * U — ko'chish davri uchun vaqtincha yechim va uning qachon,
     * qaysi qurilmada ishlatilgani KO'RINIB turishi kerak: aks holda
     * «hammasi shaxsiy tokenga o'tdi» deb o'ylab, aslida o'nlab
     * qurilma eng zaif usulda ishlab turardi.
     *
     * ⚠️ TOKENNING O'ZI YOZILMAYDI (§4: «Tokenlar va maxfiy
     * ma'lumotlar logga yozilmasin») — faqat qurilma identifikatori.
     */
    if (tokenKind === 'shared') {
      this.logger.warn(
        `Qurilma ${device.deviceId} UMUMIY token bilan ulandi — ` +
          'shaxsiy token berilishi kerak',
      );
    }

    if (!device.isActive) {
      throw new UnauthorizedException('Qurilma faolsizlantirilgan');
    }

    return { device, tokenKind };
  }

  /**
   * TOKENNI TEKSHIRISH — shaxsiy, keyin (ruxsat bo'lsa) umumiy.
   *
   * ⚠️⚠️ TARTIB MUHIM: shaxsiy token BIRINCHI tekshiriladi. Texnik
   * topshiriq (§4) shuni talab qiladi: «qurilmaning token_hash'i
   * bo'lsa → faqat shaxsiy token». Bizda `api_key_hash` ustuni
   * `NOT NULL`, ya'ni har bir qurilmada shaxsiy token BOR — demak
   * umumiy token faqat shaxsiysi mos kelmaganda va faqat ONGLI
   * ravishda ruxsat berilgan qurilmada ishlaydi.
   *
   * ⚠️ Taqqoslash HAR DOIM `DeviceKeyService.matches` orqali: u
   * vaqt bo'yicha DOIMIY (`timingSafeEqual`). Oddiy `===` javob
   * vaqtidan tokenni belgima-belgi tanlab olish imkonini berardi.
   */
  private verifyToken(
    token: string,
    device: Pick<Device, 'apiKeyHash' | 'allowSharedToken'>,
  ): TokenKind | null {
    if (this.keys.matches(token, device.apiKeyHash)) return 'personal';

    // ⚠️ Ruxsat berilmagan qurilmada umumiy token UMUMAN tekshirilmaydi.
    if (!device.allowSharedToken) return null;

    const shared =
      this.config.get<string>('telemetry.sharedDeviceToken')?.trim() ?? '';
    // ⚠️ `.env` da bo'sh bo'lsa — mexanizm butunlay o'chiq.
    if (!shared) return null;

    return this.keys.matches(token, this.keys.hash(shared)) ? 'shared' : null;
  }

  /**
   * RO'YXATDAN O'TMAGAN QURILMANI BELGILASH.
   *
   * ⚠️⚠️ XATO YUTILADI va bu ATAYLAB: bu funksiya 403 javobini
   * BERMAYDI, u faqat kabinet uchun izoh qoldiradi. Agar yozish
   * xatosi yuqoriga ko'tarilsa, qurilma 403 o'rniga 500 olardi va
   * «keyinroq qayta yuboraman» deb tushunardi — natijada notanish
   * qurilma serverga cheksiz urinib turardi.
   */
  private async notePending(
    deviceId: string,
    meta: DeviceRequestMeta,
  ): Promise<void> {
    try {
      const now = new Date();
      const ip = meta.ip?.slice(0, 45) ?? null;
      const firmware = meta.firmwareVersion ?? null;
      const hint = meta.institutionHint ?? null;

      const existing = await this.pending.findOne({
        where: { deviceId },
        select: { id: true },
      });

      if (existing) {
        await this.pending.update(existing.id, {
          lastSeenAt: now,
          lastIpAddress: ip,
          firmwareVersion: firmware,
          institutionHint: hint,
          // ⚠️ Yangi qator EMAS, hisoblagich oshiriladi.
          attempts: (): string => '"attempts" + 1',
        });
        return;
      }

      /*
       * ⚠️⚠️ CHEGARA — JADVALNI HUJUMDAN HIMOYA QILADI. Chegaraga
       * yetilsa, yangi yozuv qabul qilinmaydi — lekin jurnalga
       * tushadi, ya'ni holat ko'rinmay qolmaydi.
       */
      const open = await this.pending.count({ where: { isDismissed: false } });
      if (open >= PENDING_DEVICES_LIMIT) {
        this.logger.warn(
          `Kutish ro‘yxati to‘ldi (${PENDING_DEVICES_LIMIT}) — ` +
            `${deviceId} yozilmadi`,
        );
        return;
      }

      await this.pending.insert({
        deviceId,
        institutionHint: hint,
        firmwareVersion: firmware,
        lastIpAddress: ip,
        attempts: 1,
        lastSeenAt: now,
      });

      this.logger.warn(
        `YANGI QURILMA so‘rayapti: ${deviceId}` + (hint ? ` (${hint})` : ''),
      );
    } catch (error) {
      /*
       * ⚠️ Poyga holati: ikki so'rov bir vaqtda kelib, ikkalasi ham
       * «yozuv yo'q» deb ko'rsa, ikkinchisi unique indeksga uriladi.
       * Bu xato EMAS — natija aynan kerakli: bitta qator bor.
       */
      const code = (
        error as { code?: unknown; driverError?: { code?: unknown } }
      )?.driverError?.code;
      if (code === '23505') return;

      this.logger.warn(
        'Kutish ro‘yxatiga yozib bo‘lmadi: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
