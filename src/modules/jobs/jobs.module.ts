import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { RoomsModule } from '../rooms/rooms.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { MaintenanceJob } from './maintenance.job';
import { StatusWatcherJob } from './status-watcher.job';

@Module({
  imports: [
    TypeOrmModule.forFeature([Boiler]),
    AlertsModule,
    TelemetryModule,
    AuthModule,
    RoomsModule,
  ],
  providers: [StatusWatcherJob, MaintenanceJob],
})
export class JobsModule {}
