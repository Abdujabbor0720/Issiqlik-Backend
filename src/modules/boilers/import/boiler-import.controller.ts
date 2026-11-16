import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { BoilerImportDto } from './boiler-import.dto';
import {
  BoilerImportService,
  IMPORT_MAX_BYTES,
  type ImportFiles,
} from './boiler-import.service';

/**
 * ⚠️ Fayllar XOTIRADA qabul qilinadi (diskka vaqtincha yozilmaydi) va
 * hajm TARMOQ darajasida cheklanadi — katta fayl to'liq qabul
 * qilinmasdan to'xtaydi (`firmware.controller.ts` bilan AYNI qoida).
 */
const uploadFields = FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
    { name: 'devices', maxCount: 1 },
  ],
  { limits: { fileSize: IMPORT_MAX_BYTES, files: 2 } },
);

const uploadBody = {
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      devices: { type: 'string', format: 'binary' },
      districtId: { type: 'string', format: 'uuid' },
    },
    required: ['file', 'districtId'],
  },
};

@ApiTags('Kotyollar')
@ApiBearerAuth('bearer')
@Controller('boiler-import')
export class BoilerImportController {
  constructor(private readonly service: BoilerImportService) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.BOILERS_CREATE)
  @UseInterceptors(uploadFields)
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({ summary: 'Excel import — reja (bazaga yozmaydi)' })
  preview(
    @UploadedFiles() files: ImportFiles,
    @Body() dto: BoilerImportDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.preview(files ?? {}, dto.districtId, user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.BOILERS_CREATE)
  @UseInterceptors(uploadFields)
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({ summary: 'Excel import — yozish (bitta tranzaksiya)' })
  apply(
    @UploadedFiles() files: ImportFiles,
    @Body() dto: BoilerImportDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.apply(files ?? {}, dto.districtId, user);
  }
}
