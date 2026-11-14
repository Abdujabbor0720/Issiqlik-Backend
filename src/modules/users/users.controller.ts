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
  CreateUserDto,
  ResetPasswordDto,
  UpdateUserDto,
  UserQueryDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('Foydalanuvchilar')
@ApiBearerAuth('bearer')
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @ApiOperation({ summary: 'Foydalanuvchilar ro‘yxati' })
  list(@Query() query: UserQueryDto) {
    return this.service.list(query);
  }

  /**
   * ⚠️⚠️ Bu yo'l `:id` DAN OLDIN turishi SHART. Aks holda Express uni
   * `id = "district-responsibles"` deb o'qib, UUID validatsiyasida
   * yiqilardi — va «mas'ullar sahifasi ochilmayapti» degan xatoning
   * sababi marshrutlar TARTIBIDA ekanini hech kim topa olmasdi.
   */
  @Get('district-responsibles')
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @ApiOperation({
    summary: 'Tuman mas‘ullari — har bir tuman va unga biriktirilgan shaxs',
  })
  districtResponsibles() {
    return this.service.districtResponsibles();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  findOne(@Param() params: IdParamDto) {
    return this.service.findOne(params.id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USERS_CREATE)
  @ApiOperation({ summary: 'Yangi foydalanuvchi' })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USERS_UPDATE)
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(params.id, dto, actor);
  }

  @Post(':id/reset-password')
  @RequirePermissions(PERMISSIONS.USERS_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Parolni administrator tomonidan almashtirish' })
  resetPassword(
    @Param() params: IdParamDto,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.resetPassword(params.id, dto.newPassword, actor);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USERS_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.remove(params.id, actor);
  }
}
