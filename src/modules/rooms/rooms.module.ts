import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { Room, RoomReading } from '../../database/entities/room.entity';
import { AlertsModule } from '../alerts/alerts.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Room, RoomReading, Boiler]),
    AlertsModule,
    // ⚠️ `SettingsModule` import qilinmaydi — u `@Global()`.
  ],
  controllers: [RoomsController],
  providers: [RoomsService],
  // ⚠️ Telemetriya (`ingest`) va dashboard (`summary`) undan foydalanadi.
  exports: [RoomsService],
})
export class RoomsModule {}
