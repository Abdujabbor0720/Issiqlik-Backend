import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto, TrendQueryDto } from './dto/dashboard.dto';

@ApiTags('Dashboard')
@ApiBearerAuth('bearer')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Asosiy ko‘rsatkichlar (kartalar)' })
  summary(@Query() query: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.summary(query, user);
  }

  @Get('gauges')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({
    summary: 'Muassasalar shkalasi — har kotyolning kirish/chiqish harorati',
  })
  gauges(@Query() query: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.gauges(query, user);
  }

  @Get('districts')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Tumanlar kesimi' })
  districts(@Query() query: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.districtRows(query, user);
  }

  @Get('trend')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Harorat va holat trendi' })
  trend(@Query() query: TrendQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.trend(query, user);
  }

  @Get('attention')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Diqqat talab qiladigan kotyollar' })
  attention(@Query() query: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.attention(query, user);
  }

  @Get('brands')
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  @ApiOperation({ summary: 'Marka kesimi' })
  brands(@Query() query: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.byBrand(query, user);
  }
}
