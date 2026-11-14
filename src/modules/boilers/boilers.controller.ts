import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { BoilersService } from './boilers.service';
import { BoilersExportService } from './boilers-export.service';
import {
  ArchiveBoilerDto,
  BoilerQueryDto,
  CreateBoilerDto,
  UpdateBoilerDto,
} from './dto/boiler.dto';

@ApiTags('Kotyollar')
@ApiBearerAuth('bearer')
@Controller('boilers')
export class BoilersController {
  constructor(
    private readonly service: BoilersService,
    private readonly exporter: BoilersExportService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  @ApiOperation({ summary: 'Kotyollar ro‘yxati (filtr + sahifalash)' })
  list(@Query() query: BoilerQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  /**
   * ⚠️ `export` yo'li `:id` DAN OLDIN turadi. Aks holda Express uni
   * `id = "export"` deb o'qib, UUID validatsiyasida yiqilardi —
   * va «eksport ishlamayapti» degan xato sababi topilmasdi.
   */
  @Get('export')
  @RequirePermissions(PERMISSIONS.REPORTS_EXPORT)
  @RawResponse()
  @ApiOperation({ summary: 'Kotyollarni Excel’ga eksport qilish' })
  async export(
    @Query() query: BoilerQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.exporter.toExcel(query, user, res);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  findOne(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.findOne(params.id, user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.BOILERS_CREATE)
  @ApiOperation({ summary: 'Yangi kotyol (qozonxona)' })
  create(@Body() dto: CreateBoilerDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.BOILERS_UPDATE)
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateBoilerDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(params.id, dto, actor);
  }

  @Post(':id/archive')
  @RequirePermissions(PERMISSIONS.BOILERS_DELETE)
  @ApiOperation({ summary: 'Arxivlash (o‘chirish o‘rniga)' })
  archive(
    @Param() params: IdParamDto,
    @Body() dto: ArchiveBoilerDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.archive(params.id, dto.reason, actor);
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.BOILERS_DELETE)
  @ApiOperation({ summary: 'Arxivdan qaytarish' })
  restore(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.restore(params.id, actor);
  }
}
