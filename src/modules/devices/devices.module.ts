import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import { Device } from '../../database/entities/device.entity';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { BoilersModule } from '../boilers/boilers.module';
import { BoilerSetupController } from './boiler-setup.controller';
import { BoilerSetupService } from './boiler-setup.service';
import { DeviceAuthService } from './device-auth.service';
import { DeviceKeyService } from './device-key.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PendingDevicesService } from './pending-devices.service';

/**
 * ⚠️ `DeviceAuthService` EKSPORT QILINADI: uni telemetriya moduli ham,
 * OTA moduli ham ishlatadi. Qurilma tokenini tekshirish mantig'i
 * BUTUN tizimda bitta joyda bo'lishi — xavfsizlik talabi, qulaylik
 * emas: ikki nusxa bir-biridan ajralib ketganda, umumiy tokenni
 * taqiqlash bir yo'lda ishlab, ikkinchisida ishlamay qolishi mumkin.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Device,
      Boiler,
      PendingDevice,
      Organization,
      ObjectType,
    ]),
    // ⚠️ «Kotyol + modul» kotyol tekshiruvlarini `BoilersService` dan oladi.
    BoilersModule,
  ],
  controllers: [DevicesController, BoilerSetupController],
  providers: [
    BoilerSetupService,
    DevicesService,
    DeviceKeyService,
    DeviceAuthService,
    PendingDevicesService,
  ],
  exports: [
    DevicesService,
    DeviceKeyService,
    DeviceAuthService,
    PendingDevicesService,
  ],
})
export class DevicesModule {}
