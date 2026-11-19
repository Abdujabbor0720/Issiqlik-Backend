import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { DeviceType } from '../../common/constants/enums';
import { Public } from '../../common/decorators/public.decorator';
import { parseDeviceType } from '../../helpers/device-profile.helper';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import {
  extractApiKey,
  extractDeviceId,
  extractFirmwareVersion,
  extractDeviceTypeHeader,
} from '../telemetry/dto/ingest.dto';
import { DeviceThrottlerGuard } from '../telemetry/device-throttler.guard';
import type { OtaCheckResponse } from './ota.service';
import { OtaService } from './ota.service';

/**
 * QURILMA UCHUN OTA — `/ota/index.php`.
 *
 * ⚠️⚠️ YO'L VA QUERY PARAMETRLARI PROSHIVKADA QOTIRILGAN:
 *   #define OTA_URL "https://" SERVER_HOST "/ota/index.php"
 *   GET  {OTA_URL}?a=check&device_id=…&version=…&inst=…
 *   GET  {OTA_URL}?a=download&v=2.0.1
 *   POST {OTA_URL}?a=report
 * `a` parametri BITTA yo'lda uch xil amalni ajratadi — bu REST
 * uslubi emas, lekin kontrakt shunday (§5: «?a=check / ?a=download /
 * ?a=report query parametrlari saqlansin»).
 *
 * ⚠️ Yo'l global prefiksdan chiqarilgan (`main.ts` dagi `exclude`) va
 * kompressiya shu yo'l uchun ATAYLAB o'chirilgan: `.bin` gzip
 * qilinsa, `Content-Length` yo'qolib, qurilma faylni rad etardi.
 */
@ApiTags('Masofadan yangilash (OTA)')
@ApiExcludeController()
@UseGuards(DeviceThrottlerGuard)
@Controller()
export class OtaController {
  private readonly logger = new Logger(OtaController.name);

  constructor(
    private readonly service: OtaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `GET /ota/index.php?a=check|download`
   *
   * ⚠️⚠️ IKKI AMAL BITTA METODDA, chunki ularning YO'LI VA USULI
   * (`GET`) bir xil — faqat `a` parametri farq qiladi. Nest'da bir
   * xil yo'lga ikki `@Get` e'lon qilib bo'lmaydi: birinchisi
   * ikkinchisini soyada qoldirardi va `?a=download` jimgina
   * tekshiruv javobini (`{"update":false}`) olib, qurilma «hajm mos
   * emas» deb yangilanishni abadiy to'xtatardi.
   */
  @Public()
  @RawResponse()
  /*
   * ⚠️ Kengroq IP chelagi: tekshiruv 30 daqiqada bir keladi, lekin
   * bitta NAT ortida o'nlab qurilma bo'lishi mumkin. Qurilma bo'yicha
   * tor chelak `DeviceThrottlerGuard` da.
   */
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Get('ota/index.php')
  @ApiOperation({ summary: 'OTA: yangilanishni tekshirish / faylni olish' })
  async get(
    @Req() req: Request,
    @Res() res: Response,
    @Query('a') action: string | undefined,
    @Query('device_id') deviceIdQuery: string | undefined,
    @Query('version') versionQuery: string | undefined,
    @Query('v') fileVersion: string | undefined,
    /*
     * ⚠️ `type=kotyol|xona` — YANGI (kotyol v2.1.0, xona v1.1.0). Eski
     * proshivkada yo'q: unda tur `X-Device-Type` sarlavhasidan, u ham
     * bo'lmasa `devices.device_type` dan olinadi.
     *
     * ⚠️ `inst=` (URL-encoded muassasa NOMI) ATAYLAB O'QILMAYDI: u erkin
     * matn va identifikator sifatida ishlatilmaydi (§5.1).
     */
    @Query('type') typeQuery: string | undefined,
  ): Promise<void> {
    const ctx = this.contextOf(req, deviceIdQuery, typeQuery);

    if (action === 'download') {
      await this.download(res, ctx, fileVersion ?? null);
      return;
    }

    if (action === 'check' || action === undefined) {
      const result = await this.service.check(
        ctx.deviceId,
        ctx.token,
        this.trim(versionQuery) ?? ctx.firmwareVersion,
        {
          ip: ctx.ip,
          firmwareVersion: ctx.firmwareVersion,
          deviceType: ctx.deviceType,
        },
      );
      this.sendFlatJson(res, result);
      return;
    }

    throw new BadRequestException('Noma‘lum amal');
  }

  /**
   * `POST /ota/index.php?a=report`
   *
   * ⚠️ `@HttpCode(200)`: §7 faqat «2xx qaytar» deydi va qurilma
   * aynan shuni tekshiradi (`ota.cpp`: `code >= 200 && code < 300`
   * bo'lsa hisobotni xotiradan o'chiradi). 2xx kelmasa, u hisobotni
   * SAQLAB turadi va keyinroq qayta yuboradi.
   */
  @Public()
  @RawResponse()
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post('ota/index.php')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OTA: qurilma holati hisoboti' })
  async report(
    @Req() req: Request,
    @Body() body: unknown,
    @Query('a') action: string | undefined,
    @Query('device_id') deviceIdQuery: string | undefined,
  ): Promise<{ ok: true }> {
    if (action !== undefined && action !== 'report') {
      throw new BadRequestException('Noma‘lum amal');
    }

    const raw =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    /*
     * ⚠️ Tanadagi `device_id` SARLAVHA bilan solishtirilmaydi (telemetriyada
     * solishtiriladi): `ota.cpp` dagi `sendReport` ikkalasini ham AYNI
     * `deviceId` o'zgaruvchisidan yasaydi, lekin hisobot — JURNAL
     * yozuvi, ma'lumot yo'naltirish emas. Uni 400 bilan rad etish
     * nosozlik haqidagi xabarni butunlay yo'qotardi — holbuki hisobot
     * aynan nosozlikni aytish uchun yuboriladi.
     */
    const ctx = this.contextOf(
      req,
      deviceIdQuery ?? this.asText(raw.device_id),
    );

    return this.service.report(
      ctx.deviceId,
      ctx.token,
      {
        status: this.asText(raw.status) ?? '',
        version: this.asText(raw.version),
        target: this.asText(raw.target),
        message: this.asText(raw.message),
      },
      {
        ip: ctx.ip,
        firmwareVersion: ctx.firmwareVersion,
        institutionHint: this.asText(raw.institution_id),
        deviceType: ctx.deviceType,
      },
    );
  }

  // ═══════════════════════ Yordamchilar ═══════════════════════

  /**
   * PROSHIVKA FAYLINI OQIM BILAN BERISH.
   *
   * ⚠️⚠️ QURILMA JUDA QAT'IY (`ota.cpp` dagi `install`):
   *   • `code != 200`          → «yuklab olish: <kod>» xatosi;
   *   • `getSize() != size`    → «hajm mos emas» — YA'NI
   *     `Content-Length` AYNAN `release.size` bo'lishi SHART;
   *   • 20 soniya ma'lumot kelmasa → «vaqt tugadi»;
   *   • SHA-256 mos kelmasa    → yozilgan qism bekor qilinadi.
   * Shuning uchun: chunked YO'Q, gzip YO'Q, redirect YO'Q.
   */
  private async download(
    res: Response,
    ctx: DeviceContext,
    version: string | null,
  ): Promise<void> {
    const { release, releaseSlot } = await this.service.authorizeDownload(
      ctx.deviceId,
      ctx.token,
      this.trim(version),
      {
        ip: ctx.ip,
        firmwareVersion: ctx.firmwareVersion,
        deviceType: ctx.deviceType,
      },
    );

    try {
      const path = this.safePath(release.filePath);

      /*
       * ⚠️⚠️ DISKDAGI HAJM BAZADAGI BILAN SOLISHTIRILADI. Fayl qo'lda
       * almashtirilgan yoki yarim ko'chirilgan bo'lsa, biz `size` ni
       * bazadan yuborib, aslida boshqa hajmni oqim qilardik — qurilma
       * esa buni «hajm mos emas» deb rad etib, sababini hech qachon
       * aytolmasdi. Bu yerda esa xato SERVER jurnaliga tushadi.
       */
      const info = await stat(path);
      if (info.size !== release.size) {
        this.logger.error(
          `Proshivka ${release.version}: diskdagi hajm (${info.size}) ` +
            `bazadagidan (${release.size}) farq qiladi — fayl buzilgan`,
        );
        throw new InternalServerErrorException('Proshivka fayli buzilgan');
      }

      res.status(HttpStatus.OK);
      res.setHeader('Content-Type', 'application/octet-stream');
      // ⚠️ AYNAN shu qiymat — qurilma uni `size` bilan solishtiradi.
      res.setHeader('Content-Length', String(release.size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="firmware-${release.version}.bin"`,
      );
      /*
       * ⚠️ Keshlanmaydi: proksi yoki CDN eski faylni ushlab qolsa,
       * qurilma yangi versiya deb eskisini o'rnatib, SHA-256 mos
       * kelmay, cheksiz urinib turardi.
       */
      res.setHeader('Cache-Control', 'no-store');
      // ⚠️ Oraliq proksi javobni o'zgartirmasligi uchun.
      res.setHeader('Content-Encoding', 'identity');

      /*
       * ⚠️ `pipeline` ishlatiladi, `stream.pipe()` EMAS: u xatolarni
       * to'g'ri tarqatadi va qurilma ulanishni uzsa, fayl deskriptori
       * ochiq qolmaydi. Ochiq deskriptorlar to'planib, server «too
       * many open files» bilan yiqilardi.
       */
      await pipeline(createReadStream(path), res);

      this.logger.log(
        `Proshivka ${release.version} berildi: ${ctx.deviceId ?? '—'}`,
      );
    } finally {
      // ⚠️ Navbat o'rni HAR QANDAY holatda bo'shatiladi.
      releaseSlot();
    }
  }

  /**
   * ⚠️⚠️ YO'L TEKSHIRUVI — `FIRMWARE_DIR` DAN CHIQIB KETMASLIK.
   *
   * `file_path` bazadan keladi va u yuklash paytida biz o'zimiz
   * yozgan bo'lsa ham, bu yerda ISHONILMAYDI: baza qatorini skript
   * yoki qo'lda `UPDATE` bilan o'zgartirish mumkin va o'sha paytda
   * `../../.env` kabi yo'l orqali SERVER SIRLARINI qurilma tokeni
   * bilan yuklab olish mumkin bo'lardi.
   */
  private safePath(filePath: string): string {
    const dir = resolve(
      this.config.get<string>('firmware.dir') ?? './storage/firmware',
    );
    const full = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(dir, filePath);

    if (full !== dir && !full.startsWith(dir + '/')) {
      this.logger.error(
        `Proshivka yo‘li papkadan tashqarida: «${filePath}» — rad etildi`,
      );
      throw new InternalServerErrorException('Proshivka fayli topilmadi');
    }
    return full;
  }

  /**
   * TEKIS JSON JAVOB.
   *
   * ⚠️⚠️ `JSON.stringify` ATAYLAB to'g'ridan-to'g'ri ishlatiladi:
   *   • JavaScript `/` ni `\/` ga O'GIRMAYDI (PHP `json_encode` dan
   *     farqli) — §5 dagi «check javobida \/ yo'q» sinovi shu
   *     tufayli o'tadi;
   *   • javobdagi barcha qiymat ASCII (versiya, sha256, manzil, son),
   *     demak `\uXXXX` ham paydo bo'lmaydi.
   * Javobga erkin matn QO'SHILMASLIGI shart — kirillcha harf
   * darhol `\uXXXX` ga aylanib, proshivkaning JSON o'quvchisi uni
   * o'qiy olmasdi.
   */
  private sendFlatJson(res: Response, payload: OtaCheckResponse): void {
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload));
  }

  private contextOf(
    req: Request,
    deviceIdFallback: string | null | undefined,
    typeQuery?: string,
  ): DeviceContext {
    const headers = req.headers as Record<string, unknown>;
    return {
      /*
       * ⚠️ SARLAVHA USTUN: `X-Device-Id` barcha so'rovlarda bor
       * (`net.cpp:21`). Query parametri — zaxira: u server
       * loglariga tushadi, shuning uchun unga tayanmaslik yaxshi.
       */
      deviceId: extractDeviceId(headers) ?? this.trim(deviceIdFallback),
      token: extractApiKey(headers, {}, req.query),
      firmwareVersion: extractFirmwareVersion(headers),
      /*
       * ⚠️ Ustuvorlik: `type=` → `X-Device-Type` → (yo'q bo'lsa `null`, tur
       * bazadan olinadi). Eski proshivkada ikkalasi ham yo'q.
       */
      deviceType:
        parseDeviceType(typeQuery) ??
        parseDeviceType(extractDeviceTypeHeader(headers)),
      ip: req.ip ?? req.socket.remoteAddress ?? null,
    };
  }

  private trim(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const out = value.trim();
    return out.length > 0 ? out.slice(0, 64) : null;
  }

  private asText(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
      ? value.trim().slice(0, 1000)
      : null;
  }
}

interface DeviceContext {
  deviceId: string | null;
  token: string | null;
  firmwareVersion: string | null;
  deviceType: DeviceType | null;
  ip: string | null;
}
