import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { PERMISSIONS } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { SystemSetting } from '../../database/entities/system-setting.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Sozlamalar')
@ApiBearerAuth('bearer')
@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_VIEW)
  @ApiOperation({ summary: 'Tizim sozlamalari' })
  get(): Promise<SystemSetting> {
    return this.service.get();
  }

  @Put()
  @RequirePermissions(PERMISSIONS.SETTINGS_UPDATE)
  @ApiOperation({ summary: 'Sozlamalarni yangilash' })
  async update(@Body() dto: UpdateSettingsDto): Promise<SystemSetting> {
    /*
     * ⚠️ CHEGARALAR TARTIBI shu yerda tekshiriladi, DTO ichida emas:
     * yangilash QISMAN bo'lishi mumkin (faqat `mediumMinC` yuboriladi)
     * va qoidani tekshirish uchun MAVJUD qiymatlar ham kerak. DTO esa
     * faqat kelgan maydonlarni ko'radi.
     */
    const current = await this.service.get();
    const active = dto.activeMinC ?? current.activeMinC;
    const medium = dto.mediumMinC ?? current.mediumMinC;
    const critical = dto.criticalMinC ?? current.criticalMinC;

    if (!(active > medium && medium > critical)) {
      throw new BadRequestException(
        'Chegaralar kamayish tartibida bo‘lishi kerak: ' +
          '«Faol» > «O‘rta» > «Kritik»',
      );
    }
    return this.service.update(dto);
  }
}
