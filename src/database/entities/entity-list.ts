import { Alert } from './alert.entity';
import { AuditLog } from './audit-log.entity';
import { Boiler } from './boiler.entity';
import {
  Agency,
  BoilerBrand,
  Firm,
  Mahalla,
  ObjectType,
  Organization,
} from './catalog.entities';
import { Device } from './device.entity';
import { District } from './district.entity';
import {
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  OtaEvent,
} from './firmware.entities';
import {
  EscalationRule,
  Incident,
  IncidentEvent,
  IncidentNotification,
} from './incident.entities';
import { MonitoringHoliday, MonitoringSchedule } from './monitoring.entities';
import { PendingDevice } from './pending-device.entity';
import { RefreshToken } from './refresh-token.entity';
import { Region } from './region.entity';
import {
  ResponsibleAssignment,
  ResponsiblePerson,
} from './responsible.entities';
import { Room, RoomReading } from './room.entity';
import { SystemSetting } from './system-setting.entity';
import { TelemetryReading } from './telemetry-reading.entity';
import { User } from './user.entity';

/**
 * ENTITY RO'YXATI — YAGONA joy.
 *
 * ⚠️ `autoLoadEntities` yoki `entities: ['dist/**\/*.entity.js']` kabi
 * shablon ISHLATILMAYDI. Sabab: TypeORM CLI (migratsiya) va Nest
 * konteyneri entity'larni BOSHQA-BOSHQA yo'l bilan topardi va natijada
 * migratsiya bir sxemani, ilova esa boshqasini ko'rardi. Bu yerda
 * ikkalasi ham AYNI massivni import qiladi.
 */
export const ENTITIES = [
  Region,
  District,
  // ⚠️ `Agency` `User` va `Organization` dan OLDIN: ikkalasi unga `FK` bilan bog'lanadi.
  Agency,
  User,
  RefreshToken,
  BoilerBrand,
  Firm,
  ObjectType,
  Mahalla,
  Organization,
  Boiler,
  Device,
  TelemetryReading,
  // ⚠️ `Room` `Alert` dan OLDIN: ogohlantirish xonaga `FK` bilan bog'lanadi.
  Room,
  RoomReading,
  Alert,
  SystemSetting,
  AuditLog,
  /*
   * ⚠️ TARTIB MUHIM: `FirmwareRelease` `FirmwareRollout` dan OLDIN
   * turadi (rollout unga `FK` bilan bog'lanadi), `PendingDevice` esa
   * mustaqil — hech kimga bog'lanmaydi.
   */
  PendingDevice,
  FirmwareRelease,
  FirmwareRollout,
  FirmwareBlock,
  OtaEvent,
  // ─── XAVF qatlami ───
  ResponsiblePerson,
  ResponsibleAssignment,
  MonitoringSchedule,
  MonitoringHoliday,
  Incident,
  IncidentEvent,
  IncidentNotification,
  EscalationRule,
];

export {
  Agency,
  Alert,
  AuditLog,
  Boiler,
  BoilerBrand,
  Device,
  District,
  EscalationRule,
  Firm,
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  Incident,
  IncidentEvent,
  IncidentNotification,
  Mahalla,
  MonitoringHoliday,
  MonitoringSchedule,
  ObjectType,
  OtaEvent,
  PendingDevice,
  Organization,
  RefreshToken,
  Region,
  ResponsibleAssignment,
  ResponsiblePerson,
  Room,
  RoomReading,
  SystemSetting,
  TelemetryReading,
  User,
};
