import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * QURILMA BO'YICHA RATE LIMIT — IP bo'yicha EMAS.
 *
 * ⚠️⚠️ NIMA UCHUN KERAK. Global `ThrottlerGuard` so'rovlarni IP
 * manzil bo'yicha sanaydi va qurilmalar uchun bu IKKI TOMONDAN ham
 * yaramaydi:
 *
 *   • JUDA QATTIQ: bitta qozonxonada yoki bitta mobil operator NAT'i
 *     ortida o'nlab plata turadi va hammasi BIR IP dan chiqadi.
 *     Daqiqasiga 10 so'rov chegarasi ularning aksariyatini bloklab,
 *     harorat ma'lumotini yo'qotardi.
 *   • JUDA BO'SH: bitta buzuq yoki soxta plata minutda yuzlab so'rov
 *     yuborsa, u IP chegarasiga (daqiqasiga 2000) yetmasdan bazani
 *     keraksiz o'lchov bilan to'ldirardi.
 *
 * Shuning uchun IKKI chelak BIRGA ishlaydi: global, IP bo'yicha —
 * keng (NAT uchun joy qoldiradi); bu guard, `device_id` bo'yicha —
 * tor (§4: «Har bir device_id va IP uchun rate limit qo'y, masalan
 * daqiqasiga 10 ta so'rov»).
 *
 * ⚠️⚠️ `ThrottlerGuard` DAN MEROS OLINMAYDI va bu ONGLI QAROR.
 * `@nestjs/throttler` da har bir guard KONFIGURATSIYADAGI BARCHA
 * nomlangan chelaklarni qo'llaydi. Ya'ni `device` nomli chelak
 * qo'shilsa, uni GLOBAL guard ham qo'llardi — o'zining IP kaliti
 * bilan. Natijada «daqiqasiga 10 so'rov» chegarasi IP ga tushib,
 * aynan biz qochmoqchi bo'lgan holat yuzaga kelardi: bitta NAT
 * ortidagi 20 ta plataning 10 tasi bloklanardi. Shuning uchun bu
 * yerda O'ZIMIZNING, aniq boshqariladigan sanoqchi.
 *
 * ⚠️ Sanoqchi XOTIRADA. Bitta nusxa (instance) uchun to'g'ri ishlaydi;
 * tizim bir necha nusxada ishlatilsa, chegara har nusxada alohida
 * bo'ladi (ya'ni amalda `nusxa × limit`). Bu holat kelganda sanoqchi
 * Redis'ga ko'chiriladi — lekin hozir bitta nusxa ishlaydi va
 * taqsimlangan hisoblagich qo'shish behuda murakkablik bo'lardi.
 */

/** Oyna uzunligi, ms — «daqiqasiga N so'rov». */
const WINDOW_MS = 60_000;

/**
 * Oynada ruxsat etilgan so'rovlar soni.
 *
 * ⚠️ 20, texnik topshiriqdagi 10 EMAS va buning sababi bor: bitta
 * qurilma bir daqiqada BIR NECHTA xil so'rov yuborishi mumkin —
 * telemetriya (60 s da bir), OTA tekshiruvi, OTA hisoboti va qayta
 * urinishlar. 10 da normal ishlayotgan qurilma o'z-o'zidan chegaraga
 * urilib, hisobotini yubora olmay qolishi mumkin edi. 20 — suiiste'mol
 * uchun hamon juda tor (sekundiga 0.33 so'rov).
 */
const MAX_PER_WINDOW = 20;

/**
 * Xotirada saqlanadigan kalitlar soni chegarasi.
 *
 * ⚠️⚠️ BUSIZ SANOQCHI O'ZI HUJUM VOSITASIGA AYLANARDI: begona odam
 * har so'rovda YANGI tasodifiy `device_id` yuborib, map'ni cheksiz
 * o'stirib, serverni xotirasiz qoldirishi mumkin bo'lardi. Chegaraga
 * yetilganda eng eski yozuvlar tozalanadi.
 */
const MAX_TRACKED_KEYS = 20_000;

@Injectable()
export class DeviceThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(DeviceThrottlerGuard.name);

  /** kalit → oynadagi so'rov vaqtlari (ms). */
  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = this.trackerFor(req);
    const now = Date.now();

    const windowStart = now - WINDOW_MS;
    /*
     * ⚠️ SURILUVCHI OYNA, «qadamli» oyna EMAS. Qadamli oynada
     * (har daqiqa hisob nolga tushadi) qurilma oyna chetida ikki
     * baravar so'rov yuborib o'tib ketardi.
     */
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);

    if (recent.length >= MAX_PER_WINDOW) {
      this.hits.set(key, recent);
      this.logger.warn(
        `Rate limit: ${key} daqiqada ${recent.length} so‘rov yubordi`,
      );
      /*
       * ⚠️⚠️ 429 — ATAYLAB. §3: «429/5xx — qurilma keyinroq qayta
       * yuboradi». Ya'ni o'lchov YO'QOLMAYDI: qurilma uni navbatda
       * saqlab, keyin yana yuboradi. Agar bu yerda 400 yoki 422
       * qaytarilsa, proshivka o'lchovni «butunlay yaroqsiz» deb
       * TASHLAB yuborardi.
       */
      throw new HttpException(
        'Juda ko‘p so‘rov — keyinroq qayta yuboring',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.hits.set(key, recent);
    this.prune(windowStart);
    return true;
  }

  /**
   * SANOQ KALITI.
   *
   * ⚠️⚠️ `X-Device-Id` SARLAVHASI BIRINCHI o'rinda: u BARCHA
   * so'rovlarda bor (`net.cpp:21`), shu jumladan OTA'ning `GET`
   * so'rovlarida — u yerda esa TANA umuman yo'q. Faqat tanaga
   * tayanilsa, OTA yo'llari chegarasiz qolardi.
   *
   * ⚠️⚠️ Identifikator topilmasa, IP ga QAYTILADI — chegarasiz
   * QOLDIRILMAYDI. Aks holda sarlavhani YUBORMASLIK orqali cheklovni
   * aylanib o'tish mumkin bo'lardi: eng oson hujum yo'li aynan shu.
   *
   * ⚠️ Kalitga `device:` / `ip:` prefiksi qo'yiladi: ularsiz IP
   * manzili ko'rinishidagi `device_id` (masalan `127.0.0.1`) boshqa
   * mijozning chelagidan ovqatlanishi mumkin bo'lardi.
   */
  private trackerFor(req: Request): string {
    const headers = req.headers as Record<string, unknown>;
    const header = headers['x-device-id'];
    if (typeof header === 'string' && header.trim()) {
      return `device:${header.trim().slice(0, 64)}`;
    }

    // Eski proshivka: identifikator faqat TANADA keladi.
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const field of ['device_id', 'deviceId', 'device', 'id']) {
      const value = body[field];
      if (typeof value === 'string' && value.trim()) {
        return `device:${value.trim().slice(0, 64)}`;
      }
    }

    return `ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
  }

  /**
   * ⚠️ Tozalash FAQAT chegaraga yetilganda bo'ladi, har so'rovda EMAS:
   * 2000 kalitni har signalda aylanib chiqish telemetriyaning eng
   * issiq yo'liga behuda ish qo'shardi.
   */
  private prune(windowStart: number): void {
    if (this.hits.size <= MAX_TRACKED_KEYS) return;

    for (const [key, times] of this.hits) {
      const alive = times.filter((at) => at > windowStart);
      if (alive.length === 0) this.hits.delete(key);
      else this.hits.set(key, alive);
    }

    /*
     * ⚠️ Tozalashdan keyin ham to'lib turgan bo'lsa (ya'ni haqiqatan
     * 20 000 dan ko'p FAOL kalit bor — bu hujum belgisi), eng eskisi
     * majburan olib tashlanadi. `Map` qo'shilish tartibini saqlaydi,
     * shuning uchun birinchi kalitlar eng eskilari.
     */
    if (this.hits.size > MAX_TRACKED_KEYS) {
      const excess = this.hits.size - MAX_TRACKED_KEYS;
      let removed = 0;
      for (const key of this.hits.keys()) {
        this.hits.delete(key);
        if (++removed >= excess) break;
      }
      this.logger.warn(
        `Rate limit sanoqchisi to‘ldi — ${removed} ta eski kalit tozalandi`,
      );
    }
  }
}
