import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../../database/entities/alert.entity';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { Device } from '../../database/entities/device.entity';
import {
  EscalationRule,
  Incident,
  IncidentEvent,
  IncidentNotification,
} from '../../database/entities/incident.entities';
import { Room } from '../../database/entities/room.entity';
import { User } from '../../database/entities/user.entity';
import { AccessModule } from '../access/access.module';
import { AlertsModule } from '../alerts/alerts.module';
import { GeoModule } from '../geo/geo.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { ResponsiblesModule } from '../responsibles/responsibles.module';
import { EscalationRulesService } from './escalation-rules.service';
import { IncidentEngineService } from './incident-engine.service';
import { IncidentNotifierService } from './incident-notifier.service';
import { IncidentWatcherJob } from './incident-watcher.job';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

/**
 * XAVF QATLAMI — texnik ogohlantirishlar (`alerts`) USTIDA.
 *
 * ⚠️ `AlertsModule` ga BIR TOMONLAMA bog'liq: ogohlantirish servisi XAVF
 * haqida hech narsa bilmaydi, faqat «shu obyektda o'zgarish bo'ldi»
 * signalini chiqaradi (`AlertsService.changes$`). Teskari bog'liqlik
 * telemetriya oqimini XAVF ga bog'lab qo'yardi: XAVF dagi xato o'lchov
 * saqlanishini to'xtatmasligi kerak.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Incident,
      IncidentEvent,
      IncidentNotification,
      EscalationRule,
      Alert,
      Room,
      Device,
      Boiler,
      Organization,
      User,
    ]),
    AccessModule,
    AlertsModule,
    GeoModule,
    MonitoringModule,
    ResponsiblesModule,
  ],
  controllers: [IncidentsController],
  providers: [
    IncidentsService,
    IncidentEngineService,
    IncidentNotifierService,
    EscalationRulesService,
    IncidentWatcherJob,
  ],
  exports: [IncidentEngineService, IncidentsService],
})
export class IncidentsModule {}
