import { Alert } from './alert.entity';
import { AuditLog } from './audit-log.entity';
import { Boiler } from './boiler.entity';
import {
  BoilerBrand,
  Firm,
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
import { PendingDevice } from './pending-device.entity';
import { RefreshToken } from './refresh-token.entity';
import { Region } from './region.entity';
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
  User,
  RefreshToken,
  BoilerBrand,
  Firm,
  ObjectType,
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
];

export {
  Alert,
  AuditLog,
  Boiler,
  BoilerBrand,
  Device,
  District,
  Firm,
  FirmwareBlock,
  FirmwareRelease,
  FirmwareRollout,
  ObjectType,
  OtaEvent,
  PendingDevice,
  Organization,
  RefreshToken,
  Region,
  Room,
  RoomReading,
  SystemSetting,
  TelemetryReading,
  User,
};
