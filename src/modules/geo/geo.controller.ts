import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { CreateDistrictDto, MapQueryDto } from './dto/geo.dto';
import { GeoService } from './geo.service';

@ApiTags('Hududlar va xarita')
@ApiBearerAuth('bearer')
@Controller('geo')
export class GeoController {
  constructor(private readonly service: GeoService) {}

  @Get('regions')
  @ApiOperation({ summary: 'Viloyatlar' })
  regions() {
    return this.service.regionList();
  }

  @Get('districts')
  @ApiOperation({ summary: 'Tumanlar (filtr uchun, geometriyasiz)' })
  districts(@CurrentUser() user: AuthUser) {
    return this.service.districtList(user);
  }

  /**
   * YANGI TUMAN — faqat `settings.update` (bosh administrator).
   * ⚠️ Kalit proshivka menyusidagi bilan AYNI bo'lishi shart.
   */
  @Post('districts')
  @RequirePermissions(PERMISSIONS.SETTINGS_UPDATE)
  @ApiOperation({
    summary: 'Yangi tuman qo‘shish (kalit proshivka bilan bir xil)',
  })
  createDistrict(@Body() dto: CreateDistrictDto) {
    return this.service.createDistrict(dto);
  }

  @Get('map')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({
    summary: 'Xarita: tuman chegaralari + har tumanning kotyol statistikasi',
  })
  map(@Query() query: MapQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.mapGeoJson(query.districtIds, user);
  }

  @Get('map/points')
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  @ApiOperation({ summary: 'Xaritadagi kotyol nuqtalari' })
  points(@Query() query: MapQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.boilerPoints(query.districtIds, user);
  }

  @Get('districts/:id')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Tuman kesimi' })
  districtDetail(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.districtDetail(params.id, user);
  }
}
