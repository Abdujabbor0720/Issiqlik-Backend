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
import { DevicesService } from './devices.service';
import { PendingDevicesService } from './pending-devices.service';
import {
  ConfirmLocationDto,
  CreateDeviceDto,
  RegisterPendingDto,
  DeviceQueryDto,
  UpdateDeviceDto,
} from './dto/device.dto';

@ApiTags('ESP32 qurilmalari')
@ApiBearerAuth('bearer')
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly service: DevicesService,
    private readonly pending: PendingDevicesService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DEVICES_VIEW)
  @ApiOperation({ summary: 'Qurilmalar ro‘yxati' })
  list(@Query() query: DeviceQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  /*
   * ⚠️⚠️ `pending` YO'LLARI `:id` DAN OLDIN turishi SHART. Express
   * yo'llarni E'LON TARTIBIDA solishtiradi: `@Get(':id')` oldin
   * bo'lsa, `/devices/pending` so'rovi unga tushib, `pending` so'zi
   * UUID deb o'qilardi va endpoint hech qachon ishlamasdi (400
   * «noto'g'ri identifikator»).
   */

  @Get('pending')
  @RequirePermissions(PERMISSIONS.DEVICES_VIEW)
  @ApiOperation({
    summary:
      '«Yangi qurilmalar» — ro‘yxatda yo‘q, lekin so‘rov yuborayotganlar',
    description:
      'device_id, tur, plata aytgan tuman/obyekt turi/muassasa, IP, oxirgi vaqt. ' +
      'Tuman mas‘uli faqat o‘z tumanini aytganlarini ko‘radi.',
  })
  listPending(
    @CurrentUser() user: AuthUser,
    @Query('includeDismissed') includeDismissed?: string,
  ) {
    return this.pending.list(user, includeDismissed === 'true');
  }

  @Post('pending/:id/register')
  @RequirePermissions(PERMISSIONS.DEVICES_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bir bosishda ro‘yxatga olish va joylashuvni tasdiqlash',
    description:
      'Maydonlar berilmasa plata aytgan qiymatlar (taklif) olinadi. Qurilma ' +
      'yuborgan shaxsiy token qabul qilinadi — plata o‘zgarishsiz ishlaydi.',
  })
  async registerPending(
    @Param() params: IdParamDto,
    @Body() dto: RegisterPendingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.pending.assertVisible(params.id, actor);
    return this.service.registerPending(params.id, dto, actor);
  }

  @Post('pending/:id/dismiss')
  @RequirePermissions(PERMISSIONS.DEVICES_UPDATE)
  @ApiOperation({ summary: 'So‘rovni rad etish (o‘chirilmaydi, belgilanadi)' })
  async dismissPending(
    @Param() params: IdParamDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.pending.assertVisible(params.id, actor);
    return this.pending.dismiss(params.id);
  }

  @Post('pending/:id/restore')
  @RequirePermissions(PERMISSIONS.DEVICES_UPDATE)
  @ApiOperation({ summary: 'Rad etilgan so‘rovni ro‘yxatga qaytarish' })
  async restorePending(
    @Param() params: IdParamDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.pending.assertVisible(params.id, actor);
    return this.pending.restore(params.id);
  }

  @Get('versions')
  @RequirePermissions(PERMISSIONS.DEVICES_VIEW)
  @ApiOperation({ summary: 'Filtr uchun: proshivka versiyalari va soni' })
  versions(@CurrentUser() user: AuthUser) {
    return this.service.versions(user);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.DEVICES_VIEW)
  findOne(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    // ⚠️ Tuman chegarasi bilan — ro'yxatdagi qoida bilan AYNI.
    return this.service.getRow(params.id, user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DEVICES_CREATE)
  @ApiOperation({
    summary: 'Yangi ESP32 moduli',
    description:
      'Javobda API kalit QAYTADI va u boshqa hech qachon ko‘rsatilmaydi — ' +
      'proshivkaga darhol ko‘chiring.',
  })
  create(@Body() dto: CreateDeviceDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.DEVICES_UPDATE)
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(params.id, dto, actor);
  }

  @Post(':id/location/confirm')
  @RequirePermissions(PERMISSIONS.DEVICES_UPDATE)
  @ApiOperation({
    summary: 'Plata aytgan joylashuv taklifini tasdiqlash',
    description:
      'Faqat panelda BO‘SH maydonlar to‘ldiriladi. Muassasa katalogdan topiladi ' +
      'yoki katalogga qo‘shiladi.',
  })
  confirmLocation(
    @Param() params: IdParamDto,
    @Body() dto: ConfirmLocationDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.confirmLocation(params.id, dto, actor);
  }

  @Post(':id/rotate-key')
  @RequirePermissions(PERMISSIONS.DEVICES_ROTATE_KEY)
  @ApiOperation({
    summary: 'API kalitni almashtirish',
    description:
      '⚠️ Eski kalit DARHOL ishlamay qoladi — qurilma proshivkasi ' +
      'yangilanmaguncha signal yubora olmaydi.',
  })
  rotateKey(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.rotateKey(params.id, actor);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.DEVICES_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param() params: IdParamDto, @CurrentUser() actor: AuthUser) {
    return this.service.remove(params.id, actor);
  }
}
