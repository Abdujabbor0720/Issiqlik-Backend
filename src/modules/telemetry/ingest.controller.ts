import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { DeviceThrottlerGuard } from './device-throttler.guard';
import { parseDeviceRequest } from './dto/ingest.dto';
import type { IngestResult } from './telemetry.service';
import { TelemetryService } from './telemetry.service';

/**
 * ESP32 UCHUN QOTIRILGAN MANZILLAR.
 *
 * ⚠️⚠️ BU KONTROLLERNING BARCHA YO'LLARI GLOBAL PREFIKSDAN
 * TASHQARIDA (`main.ts` dagi `exclude`). Ular proshivkaga QOTIRIB
 * yozilgan va o'nlab plata dalada turadi:
 *
 *   • `POST /api/data` — bizning eski `modul1` proshivkasi:
 *       const char* API_URL = "http://localhost:3000/api/data";
 *
 *   • `POST /index.php/api/integrations/telemetry` — Xonobod v2.0.0:
 *       #define SERVER_URL "https://" SERVER_HOST
 *                          "/index.php/api/integrations/telemetry"
 *
 * ⚠️ `/index.php/` — PHP hostingi izi: XUSS serverida Apache rewrite
 * yoqilmagani uchun manzilga shu bo'lak kiritilgan (`config.h:11`
 * izohi). Bizda PHP YO'Q va u ishga tushmaydi — bu shunchaki yo'l
 * bo'lagi. Uni «toza» qilish uchun proshivkani qayta yig'ib, har bir
 * qurilmani USB bilan yozish kerak bo'lardi; shuning uchun server
 * manzilni QANDAY bo'lsa shunday qabul qiladi.
 *
 * ⚠️⚠️ BARCHA YO'L AYNI SERVISNI chaqiradi. Ikkita mustaqil ishlov
 * yozilsa, token tekshiruvi yoki harorat tasnifi ulardan faqat
 * bittasida tuzatilib qolardi — va qaysi qurilma qaysi manzilga
 * yuborganiga qarab tizim boshqacha ishlardi.
 *
 * ⚠️ `@RawResponse()`: javob `{success,data,timestamp}` konvertiga
 * o'ralmaydi. Proshivkadagi JSON o'quvchi juda sodda (`net.cpp` dagi
 * `jsonString`/`jsonBool`) va qisqa javob uning uchun arzonroq.
 */
@ApiTags('Telemetriya (ESP32)')
@ApiExcludeController()
/*
 * ⚠️⚠️ IKKI CHELAK BIRGA: global `ThrottlerGuard` (IP bo'yicha, keng —
 * `@Throttle` bilan 2000/daqiqa) va shu guard (`device_id` bo'yicha,
 * tor — 20/daqiqa). Faqat IP bo'yicha cheklansa, bitta buzuq plata
 * NAT ortidan bazani to'ldirardi; faqat qurilma bo'yicha cheklansa,
 * identifikatorsiz so'rovlar cheklovsiz qolardi.
 */
@UseGuards(DeviceThrottlerGuard)
@Controller()
export class IngestController {
  constructor(private readonly service: TelemetryService) {}

  /**
   * ESKI PROSHIVKA (`modul1`) — `x-api-key` + bitta `temperature`.
   *
   * ⚠️ SAQLANADI va olib tashlanmaydi (§10: «Shu davrda ikkala format
   * ham ishlashi kerak»).
   */
  @Public()
  @RawResponse()
  /*
   * ⚠️ ALOHIDA, KENG limit: umumiy limit (daqiqasiga 300) butun IP
   * uchun va bitta NAT ortidagi o'nlab qurilma uni darhol tugatardi.
   * Bu yerda esa daqiqasiga 2000 — qurilmalar soniga mo'ljallangan.
   *
   * ⚠️ Bu CHELAK IP BO'YICHA. Qurilma bo'yicha tor chelak alohida
   * guard'da (§4: «Har bir device_id va IP uchun rate limit qo'y») —
   * ikkalasi BIRGA ishlaydi.
   */
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post('api/data')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ESP32 dan harorat qabul qilish (eski manzil)' })
  legacyIngest(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<IngestResult> {
    return this.handle(req, body);
  }

  /**
   * ESP32 v2.0.0 — PROSHIVKADA QOTIRILGAN manzil.
   *
   * ⚠️⚠️ YO'LNI O'ZGARTIRMANG. U `config.h:12` da turadi va
   * `net.cpp:6` dagi `isOwnServerUrl()` uni qat'iy tekshiradi.
   * O'zgartirilsa, har bir qurilmani qaytadan proshivka qilish
   * kerak bo'ladi.
   *
   * ⚠️ `201` qaytariladi (§11 dagi `curl` sinovi aynan shuni kutadi),
   * `200` EMAS. Proshivka ikkalasini ham 2xx deb qabul qiladi
   * (`ota.cpp` dagi `otaTelemetryResult`), lekin texnik topshiriqda
   * aniq yozilgan: «201 bo'lishi kerak».
   */
  @Public()
  @RawResponse()
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post('index.php/api/integrations/telemetry')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'ESP32 v2.0.0 telemetriyasi (qotirilgan manzil)' })
  integrationIngest(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<IngestResult> {
    return this.handle(req, body);
  }

  /**
   * ⚠️ Prefikssiz NUSXA: ayrim hostingda (nginx + PHP-FPM) `/index.php`
   * bo'lagi serverga yetib kelmasligi mumkin — proksi uni yo'q qilib
   * yuboradi. Ikkinchi yo'l hech narsaga turmaydi va shu holatda
   * tizimni ishlashda saqlaydi.
   */
  @Public()
  @RawResponse()
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post('api/integrations/telemetry')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'ESP32 v2.0.0 telemetriyasi (prefikssiz)' })
  integrationIngestBare(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<IngestResult> {
    return this.handle(req, body);
  }

  /**
   * Qurilma uchun «server tirikmi» tekshiruvi.
   *
   * ⚠️ Tokensiz (`@Public()`) va ATAYLAB bo'sh: faqat server vaqtini
   * qaytaradi. Bu yerga qurilma yoki kotyol haqida biror ma'lumot
   * qo'shilsa, u autentifikatsiyasiz oshkor bo'lardi.
   */
  @Public()
  @RawResponse()
  @Get('api/data/health')
  @ApiOperation({ summary: 'Qurilma uchun tirikligini tekshirish' })
  health(): { ok: true; serverTime: string } {
    return { ok: true, serverTime: new Date().toISOString() };
  }

  /**
   * ⚠️ Yuk `parseDeviceRequest()` da o'qiladi — `@Body() dto: IngestDto`
   * EMAS. Global pipe'da `forbidNonWhitelisted: true` turibdi va u
   * proshivkadagi har bir qo'shimcha maydonni (`rssi`, `uptime`,
   * `heap`) xato deb qaytarardi — qurilma esa nima bo'lganini
   * tushunmasdan 400 olib turardi.
   */
  private async handle(req: Request, body: unknown): Promise<IngestResult> {
    const parsed = await parseDeviceRequest(req.headers, body, req.query);

    return this.service.ingest(parsed.dto, parsed.apiKey, parsed.raw, {
      ip: req.ip ?? req.socket.remoteAddress ?? null,
      firmwareVersion: parsed.firmwareVersion,
      moduleTypeHeader: parsed.moduleTypeHeader,
    });
  }
}
