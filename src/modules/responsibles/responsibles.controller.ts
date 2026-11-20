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
  CreateAssignmentDto,
  CreateResponsibleDto,
  ResponsibleQueryDto,
  UpdateAssignmentDto,
  UpdateResponsibleDto,
} from './dto/responsible.dto';
import { ResponsiblesService } from './responsibles.service';

/**
 * JAVOBGAR SHAXSLAR REYESTRI.
 *
 * ⚠️ O'CHIRISH ENDPOINTI YO'Q: shaxs faolsizlantiriladi (`isActive`),
 * faqat biriktirish olib tashlanadi — o'tgan XAVF hodisalari javobgarni
 * muhrlab olgan.
 */
@ApiTags('Javobgar shaxslar')
@ApiBearerAuth('bearer')
@Controller('responsibles')
export class ResponsiblesController {
  constructor(private readonly service: ResponsiblesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_VIEW)
  @ApiOperation({
    summary: 'Reyestr (telefon — `responsibles.contacts` bilan)',
  })
  list(@Query() query: ResponsibleQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  @Get('coverage')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_VIEW)
  @ApiOperation({ summary: 'Asosiy javobgari yo‘q muassasalar' })
  coverage(@CurrentUser() user: AuthUser) {
    return this.service.coverage(user);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_VIEW)
  findOne(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.findOne(params.id, user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_MANAGE)
  @ApiOperation({ summary: 'Javobgar shaxs qo‘shish' })
  create(@Body() dto: CreateResponsibleDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_MANAGE)
  @ApiOperation({ summary: 'Tahrirlash / faolsizlantirish' })
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateResponsibleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(params.id, dto, actor);
  }

  @Post(':id/assignments')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_MANAGE)
  @ApiOperation({ summary: 'Muassasa yoki obyektga biriktirish' })
  addAssignment(
    @Param() params: IdParamDto,
    @Body() dto: CreateAssignmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.addAssignment(params.id, dto, actor);
  }

  @Patch('assignments/:id')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_MANAGE)
  updateAssignment(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAssignmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.updateAssignment(params.id, dto, actor);
  }

  @Delete('assignments/:id')
  @RequirePermissions(PERMISSIONS.RESPONSIBLES_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAssignment(
    @Param() params: IdParamDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.removeAssignment(params.id, actor);
  }
}
