import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { OTA_PARTITION_MAX_BYTES } from '../../database/entities/firmware.entities';
import {
  CreateRolloutDto,
  UpdateRolloutStatusDto,
  UploadFirmwareDto,
} from './dto/firmware.dto';
import { FirmwareService } from './firmware.service';

/**
 * PROSHIVKA VA TARQATISH — ADMIN KABINETI.
 *
 * ⚠️ `firmware.rollout` ruxsati `firmware.upload` dan AJRATILGAN:
 * fayl yuklash hech kimga tegmaydi (u shunchaki diskda yotadi),
 * tarqatish esa butun viloyat parkiga yangi kod yuboradi. Ikkisi
 * bitta kalit ostida bo'lsa, fayl yuklash huquqi bergan odam
 * jimgina tarqatish huquqini ham bergan bo'lardi.
 */
@ApiTags('Proshivka (OTA)')
@ApiBearerAuth('bearer')
@Controller('firmware')
export class FirmwareController {
  constructor(private readonly service: FirmwareService) {}

  // ───────────────── Relizlar ─────────────────

  @Get('releases')
  @RequirePermissions(PERMISSIONS.FIRMWARE_VIEW)
  @ApiOperation({ summary: 'Yuklangan proshivka relizlari' })
  listReleases() {
    return this.service.listReleases();
  }

  /**
   * `.bin` FAYLNI YUKLASH.
   *
   * ⚠️⚠️ FAYL XOTIRADA (`memoryStorage` — sukut bo'yicha) qabul
   * qilinadi, diskka VAQTINCHA yozilmaydi. Sabab: SHA-256 ni
   * hisoblash va versiya belgisini qidirish uchun baribir butun
   * bufer kerak, hajm esa ≤ 1.9 MB — ya'ni xotira xavfi yo'q.
   * Vaqtincha fayl ishlatilsa, u xato holatlarda diskda qolib
   * ketardi va uni tozalaydigan hech narsa bo'lmasdi.
   *
   * ⚠️ `limits.fileSize` — IKKINCHI himoya qavati. Servis ham
   * tekshiradi, lekin bu yerda chegara TARMOQ darajasida ishlaydi:
   * 500 MB lik fayl yuborilsa, u butunlay qabul qilinmasdan to'xtaydi
   * va serverning xotirasi to'lmaydi.
   */
  @Post('releases')
  @RequirePermissions(PERMISSIONS.FIRMWARE_UPLOAD)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: OTA_PARTITION_MAX_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        version: { type: 'string', example: '2.0.1' },
        note: { type: 'string' },
        moduleType: { type: 'string', enum: ['boiler', 'room'] },
      },
      required: ['file'],
    },
  })
  @ApiOperation({ summary: 'Yangi proshivka yuklash (.bin)' })
  upload(
    @UploadedFile()
    file: { buffer: Buffer; size: number; originalname: string },
    @Body() dto: UploadFirmwareDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.upload(
      file,
      dto.version,
      dto.note,
      user,
      dto.moduleType,
    );
  }

  /**
   * ⚠️ `DELETE` emas, ARXIVLASH: qurilmalarda o'sha versiya hali
   * ishlab turgan bo'lishi mumkin va OTA tarixi reliz yozuvisiz
   * o'qilmas bo'lib qolardi. HTTP usuli `DELETE` qoldirilgan, chunki
   * foydalanuvchi uchun bu «olib tashlash» amali.
   */
  @Delete('releases/:id')
  @RequirePermissions(PERMISSIONS.FIRMWARE_UPLOAD)
  @ApiOperation({ summary: 'Relizni arxivlash (o‘chirilmaydi)' })
  archive(@Param() params: IdParamDto) {
    return this.service.archiveRelease(params.id);
  }

  // ───────────────── Tarqatish ─────────────────

  @Get('rollouts')
  @RequirePermissions(PERMISSIONS.FIRMWARE_VIEW)
  @ApiOperation({ summary: 'Tarqatishlar ro‘yxati' })
  listRollouts() {
    return this.service.listRollouts();
  }

  @Post('rollouts')
  @RequirePermissions(PERMISSIONS.FIRMWARE_ROLLOUT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tarqatishni boshlash' })
  createRollout(@Body() dto: CreateRolloutDto, @CurrentUser() user: AuthUser) {
    return this.service.createRollout(dto, user);
  }

  /**
   * ⚠️ «To'xtatish» tugmasi (§9.3) aynan shu: `paused`. Keyin
   * `active` bilan davom ettirish yoki `cancelled` bilan butunlay
   * bekor qilish mumkin.
   */
  @Patch('rollouts/:id/status')
  @RequirePermissions(PERMISSIONS.FIRMWARE_ROLLOUT)
  @ApiOperation({
    summary: 'Tarqatishni to‘xtatish / davom ettirish / bekor qilish',
  })
  setStatus(@Param() params: IdParamDto, @Body() dto: UpdateRolloutStatusDto) {
    return this.service.setRolloutStatus(params.id, dto.status);
  }

  @Get('rollouts/:id/progress')
  @RequirePermissions(PERMISSIONS.FIRMWARE_VIEW)
  @ApiOperation({ summary: 'Tarqatish jarayoni — har bir qurilma holati' })
  progress(@Param() params: IdParamDto) {
    return this.service.rolloutProgress(params.id);
  }

  // ───────────────── Bloklar ─────────────────

  @Get('blocks')
  @RequirePermissions(PERMISSIONS.FIRMWARE_VIEW)
  @ApiOperation({ summary: 'Bloklangan versiyalar (qaytgan / 3 marta xato)' })
  listBlocks() {
    return this.service.listBlocks();
  }

  /**
   * «QAYTA URINISH» tugmasi (§9.4).
   *
   * ⚠️ `FIRMWARE_ROLLOUT` ruxsati kerak, `FIRMWARE_VIEW` emas: blokni
   * olib tashlash — qurilmaga YAROQSIZ deb belgilangan proshivkani
   * qayta taklif qilishga ruxsat berish, ya'ni tarqatish darajasidagi
   * qaror.
   */
  @Delete('blocks/:id')
  @RequirePermissions(PERMISSIONS.FIRMWARE_ROLLOUT)
  @ApiOperation({ summary: 'Blokni olib tashlash — qayta urinish' })
  clearBlock(@Param() params: IdParamDto) {
    return this.service.clearBlock(params.id);
  }
}
