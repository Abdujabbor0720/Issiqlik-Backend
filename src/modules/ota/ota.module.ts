import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from '../../database/entities/device.entity';
import {
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  OtaEvent,
} from '../../database/entities/firmware.entities';
import { DevicesModule } from '../devices/devices.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { FirmwareController } from './firmware.controller';
import { FirmwareService } from './firmware.service';
import { OtaController } from './ota.controller';
import { OtaService } from './ota.service';

/**
 * MASOFADAN YANGILASH (OTA) MODULI.
 *
 * ⚠️ IKKI KONTROLLER, chunki ikki MUTLAQO boshqa iste'molchi bor:
 *   • `OtaController`      — QURILMA (tokensiz emas: qurilma tokeni
 *     bilan, global prefiksdan tashqarida, qotirilgan yo'llar);
 *   • `FirmwareController` — ADMIN KABINETI (JWT + ruxsat kalitlari).
 * Bitta kontrollerda bo'lsa, `@Public()` va `@RequirePermissions()`
 * bir faylda aralashib, bir kuni qurilma yo'liga admin tekshiruvi
 * (yoki eng yomoni — teskarisi) qo'shilib ketishi mumkin edi.
 *
 * ⚠️ `TelemetryModule` IMPORT QILINADI faqat `DeviceThrottlerGuard`
 * uchun: u xotirada sanoqchi yuritadi, demak YAGONA nusxa bo'lishi
 * shart. Har modul o'z nusxasini yasasa, bitta qurilma ikki chelakdan
 * ovqatlanib, chegara amalda ikki baravarga chiqardi.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FirmwareRelease,
      FirmwareRollout,
      FirmwareBlock,
      OtaEvent,
      Device,
    ]),
    DevicesModule,
    TelemetryModule,
  ],
  controllers: [OtaController, FirmwareController],
  providers: [OtaService, FirmwareService],
  exports: [OtaService, FirmwareService],
})
export class OtaModule {}
