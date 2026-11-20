import {
  Body,
  Controller,
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
  IncidentCommentDto,
  IncidentOptionalNoteDto,
  IncidentQueryDto,
  IncidentReportQueryDto,
  IncidentRequiredNoteDto,
  NotificationQueryDto,
  RecurringQueryDto,
  ReplaceEscalationRulesDto,
} from './dto/incident.dto';
import { EscalationRulesService } from './escalation-rules.service';
import { IncidentsService } from './incidents.service';

/**
 * XAVF — mas'ullar paneli.
 *
 * ⚠️⚠️ O'CHIRISH ENDPOINTI YO'Q va bu ataylab (texnik topshiriq §6:
 * «hodisani oddiy foydalanuvchi o'chira olmasin»). Hodisa faqat
 * holatlar orqali yakunlanadi, tarixi esa append-only.
 *
 * ⚠️ Statik yo'llar (`summary`, `recurring`, `report`, `notifications`,
 * `escalation-rules`) `:id` dan OLDIN e'lon qilingan.
 */
@ApiTags('XAVF (hodisalar)')
@ApiBearerAuth('bearer')
@Controller('incidents')
export class IncidentsController {
  constructor(
    private readonly service: IncidentsService,
    private readonly rules: EscalationRulesService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({ summary: 'XAVF ro‘yxati (sukut: faqat faollar)' })
  list(@Query() query: IncidentQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({ summary: 'Panel kartalari (tuman / tashkilot / viloyat)' })
  summary(@CurrentUser() user: AuthUser) {
    return this.service.summary(user);
  }

  @Get('recurring')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({ summary: 'Takrorlanayotgan muammolar' })
  recurring(@Query() query: RecurringQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.recurring(query, user);
  }

  @Get('report')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({
    summary: 'Davr hisoboti (qabul / bartaraf vaqti, eskalatsiya)',
  })
  report(
    @Query() query: IncidentReportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.report(query, user);
  }

  @Get('notifications/my')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({
    summary: 'Mening ogohlantirishlarim (o‘qilmaganlar soni bilan)',
  })
  myNotifications(
    @Query() query: NotificationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.myNotifications(query, user);
  }

  @Post('notifications/read-all')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.service.markAllRead(user);
  }

  @Post('notifications/:id/read')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @HttpCode(HttpStatus.OK)
  markRead(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.markRead(params.id, user);
  }

  @Get('escalation-rules')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({ summary: 'Eskalatsiya qoidalari' })
  escalationRules() {
    return this.rules.list();
  }

  @Put('escalation-rules')
  @RequirePermissions(PERMISSIONS.ESCALATION_MANAGE)
  @ApiOperation({
    summary: 'Eskalatsiya qoidalarini almashtirish (butun ro‘yxat)',
  })
  replaceEscalationRules(
    @Body() dto: ReplaceEscalationRulesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.rules.replace(dto, actor);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INCIDENTS_VIEW)
  @ApiOperation({
    summary: 'Ogohlantirish kartasi: tarix, javobgarlar, eskalatsiya',
  })
  detail(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.detail(params.id, user);
  }

  @Post(':id/acknowledge')
  @RequirePermissions(PERMISSIONS.INCIDENTS_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Qabul qilish (NEW → ACKNOWLEDGED)' })
  acknowledge(
    @Param() params: IdParamDto,
    @Body() dto: IncidentOptionalNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.transition(params.id, 'acknowledge', dto.note, actor);
  }

  @Post(':id/start')
  @RequirePermissions(PERMISSIONS.INCIDENTS_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Chora ko‘rilmoqda (→ IN_PROGRESS), izoh majburiy' })
  start(
    @Param() params: IdParamDto,
    @Body() dto: IncidentRequiredNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.transition(params.id, 'start', dto.note, actor);
  }

  @Post(':id/resolve')
  @RequirePermissions(PERMISSIONS.INCIDENTS_ACT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bartaraf etildi (→ RESOLVED), bajarilgan ishlar majburiy',
  })
  resolve(
    @Param() params: IdParamDto,
    @Body() dto: IncidentRequiredNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.transition(params.id, 'resolve', dto.note, actor);
  }

  @Post(':id/close')
  @RequirePermissions(PERMISSIONS.INCIDENTS_CLOSE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tekshirilgan holda yopish (RESOLVED → CLOSED)' })
  close(
    @Param() params: IdParamDto,
    @Body() dto: IncidentOptionalNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.transition(params.id, 'close', dto.note, actor);
  }

  @Post(':id/reopen')
  @RequirePermissions(PERMISSIONS.INCIDENTS_CLOSE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tekshiruvdan o‘tmadi — qayta ochish (RESOLVED → IN_PROGRESS)',
  })
  reopen(
    @Param() params: IdParamDto,
    @Body() dto: IncidentRequiredNoteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.transition(params.id, 'reopen', dto.note, actor);
  }

  @Post(':id/comments')
  @RequirePermissions(PERMISSIONS.INCIDENTS_ACT)
  @ApiOperation({ summary: 'Izoh yoki bajarilgan ish qo‘shish' })
  comment(
    @Param() params: IdParamDto,
    @Body() dto: IncidentCommentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.comment(params.id, dto, actor);
  }
}
