import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { BoilerSetupService } from './boiler-setup.service';
import { BoilerSetupDto } from './dto/boiler-setup.dto';

/**
 * ⚠️ Alohida kontroller (`/boiler-setup`), `BoilersController` ichida
 * EMAS: bu yo'l qurilmalar moduliga bog'liq va u kotyollar modulini
 * import qiladi. Teskarisi aylanma bog'liqlik bo'lardi.
 */
@ApiTags('Kotyol + modul')
@ApiBearerAuth('bearer')
@Controller('boiler-setup')
export class BoilerSetupController {
  constructor(private readonly service: BoilerSetupService) {}

  /**
   * ⚠️ Faqat `boilers.create` — modul qismining ruxsati servisda
   * (`assertDevicePermission`) rejimga qarab tekshiriladi.
   */
  @Post()
  @RequirePermissions(PERMISSIONS.BOILERS_CREATE)
  @ApiOperation({
    summary: 'Kotyol + ESP32 moduli (+ yangi muassasa) — bitta tranzaksiyada',
  })
  setup(@Body() dto: BoilerSetupDto, @CurrentUser() user: AuthUser) {
    return this.service.setup(dto, user);
  }
}
