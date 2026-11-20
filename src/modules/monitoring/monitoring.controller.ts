import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import {
  CreateHolidayDto,
  EffectiveScheduleQueryDto,
  HolidayQueryDto,
  ScheduleQueryDto,
  UpsertScheduleDto,
} from './dto/monitoring.dto';
import { MonitoringScheduleService } from './monitoring-schedule.service';

/**
 * MONITORING JADVALI — «qachon past harorat XAVF hisoblanadi».
 *
 * ⚠️ Ko'rish — hamma XAVF ishtirokchisi (`schedules.view`, o'z vakolati
 * doirasida); o'zgartirish — faqat administrator (`schedules.manage`):
 * texnik topshiriq §2 «administrator har bir obyektga individual jadval
 * belgilay olsin».
 */
@ApiTags('Monitoring jadvali')
@ApiBearerAuth('bearer')
@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly service: MonitoringScheduleService) {}

  @Get('schedules')
  @RequirePermissions(PERMISSIONS.SCHEDULES_VIEW)
  @ApiOperation({
    summary: 'Jadvallar (global, obyekt turi, muassasa, obyekt)',
  })
  list(@Query() query: ScheduleQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  @Get('schedules/effective')
  @RequirePermissions(PERMISSIONS.SCHEDULES_VIEW)
  @ApiOperation({
    summary: 'Obyekt uchun amaldagi jadval va «hozir oyna ichidami»',
  })
  effective(
    @Query() query: EffectiveScheduleQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.effectiveForBoiler(query.boilerId, user);
  }

  @Put('schedules')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Jadvalni saqlash (nishon bo‘yicha upsert)' })
  upsert(@Body() dto: UpsertScheduleDto, @CurrentUser() actor: AuthUser) {
    return this.service.upsert(dto, actor);
  }

  @Delete('schedules/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Individual jadvalni olib tashlash (global emas)' })
  remove(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.remove(params.id, actor);
  }

  @Get('holidays')
  @RequirePermissions(PERMISSIONS.SCHEDULES_VIEW)
  @ApiOperation({ summary: 'Bayram va dam olish kunlari' })
  holidays(@Query() query: HolidayQueryDto) {
    return this.service.listHolidays(query.year);
  }

  @Post('holidays')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Bayram kuni qo‘shish' })
  createHoliday(@Body() dto: CreateHolidayDto, @CurrentUser() actor: AuthUser) {
    return this.service.createHoliday(dto, actor);
  }

  @Delete('holidays/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeHoliday(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.removeHoliday(params.id, actor);
  }
}
