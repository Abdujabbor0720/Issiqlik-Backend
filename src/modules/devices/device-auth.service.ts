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
/**
 * UNIQUE INDEKS BUZILISHI (PostgreSQL `23505`).
 *
 * ⚠️ Bu yerda NORMAL holat: ikki so'rov bir vaqtda ayni qurilmani
 * yaratishga urinsa, ikkinchisi shu xatoni oladi. Natija kerakli —
 * qator bazada. Kod IKKI joydan o'qiladi: TypeORM asl `pg` xatosini
 * `driverError` ichiga o'raydi, lekin ayrim yo'llarda u
 * to'g'ridan-to'g'ri obyektda bo'ladi.
 */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  return (
    candidate?.driverError?.code === '23505' || candidate?.code === '23505'
  );
}

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
      /*
       * ⚠️⚠️ AVTOMATIK RO'YXATGA OLISH — faqat UMUMIY TOKEN bilan.
       *
       * Viloyatda yuzlab, keyinchalik mingga yaqin plata bo'ladi.
       * Har biriga qo'lda token yozish amalda imkonsiz: montajchi
       * har plata uchun administratorga murojaat qilishi kerak
       * bo'lardi va o'rnatish ishi shu yerda to'xtab qolardi.
       *
       * Shuning uchun proshivkaga BITTA umumiy token qo'yiladi va
       * qurilma o'zini serverga o'zi tanitadi.
       *
       * ⚠️⚠️ XAVF ONGLI RAVISHDA CHEKLANGAN. Token sizib chiqsa,
       * begona odam soxta qurilma yarata oladi — LEKIN u
       * KOTYOLGA BIRIKTIRILMAGAN bo'ladi (`boilerId: null`).
       * Biriktirilmagan qurilmaning o'lchovi hech qaysi kotyolning
       * holatini, xaritasini yoki hisobotini O'ZGARTIRMAYDI
       * (`telemetry.service.ts` da `if (device.boilerId)` sharti).
       * Ya'ni eng yomon natija — ro'yxatda keraksiz qator.
       *
       * ⚠️ Umumiy token `.env` da bo'sh bo'lsa, bu tarmoq UMUMAN
       * ishlamaydi va eski xatti-harakat (403 + kutish ro'yxati)
       * saqlanadi. Ya'ni mexanizmni yoqish — ongli qaror.
       */
      const enrolled = await this.tryAutoEnroll(deviceId, token, meta);
      if (enrolled) return { device: enrolled, tokenKind: 'shared' };

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
   * UMUMIY TOKEN BILAN KELGAN NOTANISH QURILMANI RO'YXATGA OLISH.
   *
   * @returns Yaratilgan qurilma, yoki `null` — mexanizm o'chiq,
   *   token mos emas yoki chegara to'lgan.
   */
  private async tryAutoEnroll(
    deviceId: string,
    token: string,
    meta: DeviceRequestMeta,
  ): Promise<AuthenticatedDevice | null> {
    const shared = this.sharedToken();
    // ⚠️ `.env` da bo'sh — mexanizm butunlay o'chiq.
    if (!shared) return null;

    // ⚠️ Vaqt bo'yicha DOIMIY taqqoslash (`timingSafeEqual`).
    if (!this.keys.matches(token, this.keys.hash(shared))) return null;

    /*
     * ⚠️⚠️ CHEGARA — TOKEN SIZIB CHIQQAN HOLAT UCHUN.
     *
     * Busiz tokenni bilgan odam cheksiz soxta qurilma yaratib,
     * jadvalni va diskni to'ldirib qo'yardi. Chegaraga yetilganda
     * yangi qurilma yaratilmaydi, lekin jurnalga YOZILADI — ya'ni
     * holat jimgina o'tib ketmaydi.
     *
     * ⚠️ Chegara FAQAT avtomatik yaratilganlarni sanaydi emas,
     * UMUMIY sonni sanaydi: qo'lda kiritilgan qurilmalar ham
     * parkning bir qismi va haqiqiy chegara — park hajmi.
     */
    const max = this.config.get<number>('telemetry.autoEnrollMax') ?? 0;
    if (max > 0) {
      const total = await this.devices.count();
      if (total >= max) {
        this.logger.error(
          `Avtomatik ro‘yxatga olish chegarasi to‘ldi (${total}/${max}) — ` +
            `${deviceId} yaratilmadi. Chegara: DEVICE_AUTO_ENROLL_MAX`,
        );
        return null;
      }
    }

    /*
     * ⚠️⚠️ SHAXSIY KALIT TASODIFIY YARATILADI va HECH KIMGA
     * KO'RSATILMAYDI. Ustun `NOT NULL`, shuning uchun qiymat
     * baribir kerak — lekin uni hech kim bilmagani ma'qul:
     * qurilma umumiy token bilan ishlaydi, administrator esa
     * xohlagan paytda «Kalitni almashtirish» bilan shaxsiyga
     * o'tkazadi va o'shanda yangi kalit BIR MARTA ko'rsatiladi.
     */
    const personalKey = this.keys.generate();

    try {
      const created = await this.devices.save(
        this.devices.create({
          deviceId,
          name: null,
          // ⚠️⚠️ KOTYOLGA BIRIKTIRILMAYDI. Avtomatik biriktirish
          //    qilinsa, soxta qurilma haqiqiy qozonxonaning
          //    holatini buzib yuborardi. Biriktirish — ONGLI,
          //    administrator qaroriga qoladi.
          boilerId: null,
          apiKeyHash: this.keys.hash(personalKey),
          apiKeyPreview: this.keys.preview(personalKey),
          allowSharedToken: true,
          institutionHint: meta.institutionHint ?? null,
          firmwareVersion: meta.firmwareVersion ?? null,
          lastIpAddress: meta.ip?.slice(0, 45) ?? null,
          note: 'Avtomatik ro‘yxatga olindi (umumiy token)',
          isActive: true,
        }),
      );

      this.logger.log(
        `Yangi qurilma avtomatik ro‘yxatga olindi: ${deviceId}` +
          (meta.institutionHint ? ` (${meta.institutionHint})` : '') +
          ' — kotyolga biriktirilmagan',
      );

      // ⚠️ Kutish ro'yxatida turgan bo'lsa, yopiladi.
      await this.closePendingQuietly(deviceId);

      return created;
    } catch (error) {
      /*
       * ⚠️ POYGA: ikki so'rov bir vaqtda kelib, ikkalasi ham
       * «qurilma yo'q» deb ko'rsa, ikkinchisi unique indeksga
       * uriladi. Bu xato EMAS — qator allaqachon bor, uni o'qib
       * qaytaramiz.
       */
      if (!isUniqueViolation(error)) throw error;

      return this.devices.findOne({
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
    }
  }

  /** `.env` dagi umumiy token (bo'sh bo'lsa — mexanizm o'chiq). */
  private sharedToken(): string {
    return this.config.get<string>('telemetry.sharedDeviceToken')?.trim() ?? '';
  }

  /**
   * ⚠️ Xato YUTILADI: bu tozalash ishi, qurilma yaratilishini
   * to'xtatmasligi kerak.
   */
  private async closePendingQuietly(deviceId: string): Promise<void> {
    try {
      await this.pending.update(
        { deviceId, isDismissed: false },
        { isDismissed: true },
      );
    } catch {
      // jim — kutish ro'yxati faqat ma'lumot uchun
    }
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
      if (isUniqueViolation(error)) return;

      this.logger.warn(
        'Kutish ro‘yxatiga yozib bo‘lmadi: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
