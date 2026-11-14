import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { Device } from '../../database/entities/device.entity';
import { PendingDevice } from '../../database/entities/pending-device.entity';
import { TelemetryReading } from '../../database/entities/telemetry-reading.entity';
import { AlertsModule } from '../alerts/alerts.module';
import { DevicesModule } from '../devices/devices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoomsModule } from '../rooms/rooms.module';
import { DeviceThrottlerGuard } from './device-throttler.guard';
import { IngestController } from './ingest.controller';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TelemetryReading, Device, Boiler, PendingDevice]),
    DevicesModule,
    AlertsModule,
    RealtimeModule,
    RoomsModule,
  ],
  controllers: [IngestController, TelemetryController],
  /*
   * ⚠️ `DeviceThrottlerGuard` sanoqchisini XOTIRADA saqlaydi, demak u
   * YAGONA nusxa (singleton) bo'lishi SHART. `@UseGuards(Class)` bilan
   * Nest uni konteynerdan oladi — shuning uchun u provider sifatida
   * ro'yxatda turishi va `exports` da bo'lishi kerak (OTA moduli ham
   * AYNI nusxani ishlatadi, aks holda har modul o'z hisobini yuritib,
   * chegara ikki baravarga chiqardi).
   */
  providers: [TelemetryService, DeviceThrottlerGuard],
  exports: [TelemetryService, DeviceThrottlerGuard],
})
export class TelemetryModule {}
