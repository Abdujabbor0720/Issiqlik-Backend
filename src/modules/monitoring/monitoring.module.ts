import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import {
  MonitoringHoliday,
  MonitoringSchedule,
} from '../../database/entities/monitoring.entities';
import { AccessModule } from '../access/access.module';
import { MonitoringController } from './monitoring.controller';
import { MonitoringScheduleService } from './monitoring-schedule.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MonitoringSchedule,
      MonitoringHoliday,
      Boiler,
      Organization,
      ObjectType,
    ]),
    AccessModule,
  ],
  controllers: [MonitoringController],
  providers: [MonitoringScheduleService],
  // ⚠️ XAVF dvigateli jadvalni shu servisdan o'qiydi.
  exports: [MonitoringScheduleService],
})
export class MonitoringModule {}
