import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { AlertsService } from './alerts.service';
import { AcknowledgeDto, AlertQueryDto } from './dto/alert.dto';

@ApiTags('Ogohlantirishlar')
@ApiBearerAuth('bearer')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ALERTS_VIEW)
  @ApiOperation({ summary: 'Ogohlantirishlar (sukut: faqat ochiqlar)' })
  list(@Query() query: AlertQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  @Post(':id/acknowledge')
  @RequirePermissions(PERMISSIONS.ALERTS_ACK)
  @ApiOperation({ summary: 'Ko‘rib chiqildi deb belgilash' })
  acknowledge(
    @Param() params: IdParamDto,
    @Body() dto: AcknowledgeDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.acknowledge(params.id, dto.note, actor);
  }
}
