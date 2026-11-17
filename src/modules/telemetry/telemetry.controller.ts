import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { parseDeviceRequest } from './dto/ingest.dto';
import { TelemetryQueryDto } from './dto/telemetry-query.dto';
import { TelemetryService } from './telemetry.service';

@ApiTags('Telemetriya')
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly service: TelemetryService) {}

  /**
   * ⚠️ Yangi proshivkalar uchun manzil. `IngestController` dagi eski
   * `/api/data` bilan AYNI servisni chaqiradi — ikkita mustaqil
   * ishlov berish yozilsa, kalit tekshiruvi yoki holat hisoblash
   * ulardan faqat bittasida tuzatilib qolardi.
   */
  @Public()
  @RawResponse()
  @Throttle({ default: { limit: 2000, ttl: 60_000 } })
  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ESP32 dan harorat qabul qilish' })
  async ingest(@Req() req: Request, @Body() body: unknown) {
    /*
     * ⚠️⚠️ YUKNI O'QISH `parseDeviceRequest()` DA — bu yerda NUSXA
     * YO'Q. Ilgari aynan shu kod `IngestController` da ham turardi va
     * ikki nusxa bir-biridan asta-sekin ajralib ketish arafasida edi:
     * `X-Device-Id` kimlik tekshiruvi ulardan faqat bittasiga
     * qo'shilsa, qaysi manzilga yuborilganiga qarab tizim boshqacha
     * ishlardi.
     */
    const parsed = await parseDeviceRequest(req.headers, body, req.query);

    return this.service.ingest(parsed.dto, parsed.apiKey, parsed.raw, {
      ip: req.ip ?? req.socket.remoteAddress ?? null,
      firmwareVersion: parsed.firmwareVersion,
      moduleTypeHeader: parsed.moduleTypeHeader,
    });
  }

  @ApiBearerAuth('bearer')
  @Get('series')
  @RequirePermissions(PERMISSIONS.TELEMETRY_VIEW)
  @ApiOperation({ summary: 'Harorat grafigi (soatlik / kunlik agregat)' })
  series(@Query() query: TelemetryQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.series(query, user);
  }

  @ApiBearerAuth('bearer')
  @Get('boilers/:id/recent')
  @RequirePermissions(PERMISSIONS.TELEMETRY_VIEW)
  @ApiOperation({ summary: 'Kotyolning oxirgi o‘lchovlari' })
  recent(@Param() params: IdParamDto, @Query('limit') limit?: string) {
    return this.service.recent(params.id, Number(limit ?? 100) || 100);
  }
}
