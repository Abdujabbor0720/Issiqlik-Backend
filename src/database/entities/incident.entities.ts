import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  AlertSeverity,
  EscalationCondition,
  IncidentEventType,
  IncidentKind,
  IncidentStatus,
  NotifyAudience,
} from '../../common/constants/enums';
import { Alert } from './alert.entity';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { Agency, Organization } from './catalog.entities';
import { numericTransformer } from './column-transformers';
import { Device } from './device.entity';
import { District } from './district.entity';
import { Room } from './room.entity';
import { User } from './user.entity';

/** Hodisa paytidagi javobgar — muhrlangan nusxa. */
export interface ResponsibleSnapshot {
  responsibleId: string;
  fullName: string;
  position: string;
  employer: string | null;
  phone: string;
  email: string | null;
  responsibilityType: string;
  isPrimary: boolean;
  /** Biriktirish qayerga: `organization` yoki `boiler`. */
  via: 'organization' | 'boiler';
}

/** Hodisa paytidagi monitoring jadvali — muhrlangan nusxa. */
export interface ScheduleSnapshot {
  source: string;
  mode: string;
  activeDays: number[];
  heating: string;
  monitor: string;
  minRoomTemperature: number;
  observeHolidays: boolean;
}

/**
 * XAVF — NAZORAT HODISASI.
 *
 * ⚠️⚠️ OGOHLANTIRISH (`alerts`) BILAN BIR XIL EMAS. Ogohlantirish — texnik
 * signal, avtomatik ochiladi va yopiladi, hech kimga «tegishli» emas. XAVF
 * esa mas'ulning ish varag'i: kim javobgar, kimga yuborildi, kim qabul
 * qildi, nima qilindi, kimga ko'tarildi. Ikkisi bitta jadvalda bo'lsa,
 * kotyol «o'rta» dan «kritik» ga o'tganda mas'ulning yozgan izohlari
 * eski (yopilgan) qator bilan birga ko'rinmay qolardi.
 *
 * ⚠️⚠️ YO'NALTIRISH MUHRLANADI (`districtId`, `agencyId`, nomlar,
 * javobgarlar, jadval). Muassasa keyin boshqa boshqarmaga o'tkazilsa,
 * o'tgan hodisa «qaysi idoraga yuborilgan edi» degan savolga AYNAN
 * o'sha paytdagi javobni beradi.
 *
 * ⚠️ O'CHIRILMAYDI (endpoint yo'q, FK'lar `RESTRICT`).
 */
@Entity('incidents')
@Index('IDX_incidents_status_detected', ['status', 'detectedAt'])
export class Incident extends BaseEntity {
  /** Inson o'qiydigan tartib raqami («XAVF №128»). Bazada IDENTITY. */
  @Column({ type: 'bigint', insert: false, update: false })
  number!: string;

  /**
   * DUBLIKAT KALITI: `tur:qozonxona[:xona|:qurilma]`.
   *
   * ⚠️⚠️ Bitta kalit bo'yicha BITTA faol hodisa — bazada qisman yagona
   * indeks (`UQ_incidents_active_key`). Bir vaqtda kelgan ikki signal,
   * cron va tezkor yo'l, ikkita server nusxasi — hammasi bir hodisani
   * ochmoqchi bo'lsa, ikkinchisi jimgina rad etiladi.
   */
  @Column({ type: 'varchar', length: 200, name: 'dedupe_key' })
  dedupeKey!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: IncidentKind;

  @Column({ type: 'varchar', length: 16 })
  severity!: AlertSeverity;

  @Column({ type: 'varchar', length: 16, default: IncidentStatus.NEW })
  status!: IncidentStatus;

  @Column({ type: 'varchar', length: 300 })
  title!: string;

  // ───────────────── Qayerda ─────────────────

  @Index('IDX_incidents_boiler_id')
  @Column({ type: 'uuid', name: 'boiler_id' })
  boilerId!: string;

  @ManyToOne(() => Boiler, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler;

  @Column({ type: 'uuid', name: 'room_id', nullable: true })
  roomId!: string | null;

  @ManyToOne(() => Room, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'room_id' })
  room!: Room | null;

  @Column({ type: 'varchar', length: 120, name: 'room_name', nullable: true })
  roomName!: string | null;

  @Column({ type: 'uuid', name: 'device_id', nullable: true })
  deviceId!: string | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'device_id' })
  device!: Device | null;

  /** «Xona sensori №2» — qurilma nomi yoki identifikatori, muhrlangan. */
  @Column({
    type: 'varchar',
    length: 160,
    name: 'device_label',
    nullable: true,
  })
  deviceLabel!: string | null;

  @Index('IDX_incidents_organization_id')
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  @ManyToOne(() => Organization, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization!: Organization | null;

  @Column({
    type: 'varchar',
    length: 180,
    name: 'organization_name',
    nullable: true,
  })
  organizationName!: string | null;

  @Index('IDX_incidents_district_id')
  @Column({ type: 'uuid', name: 'district_id' })
  districtId!: string;

  @ManyToOne(() => District, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'district_id' })
  district!: District;

  @Index('IDX_incidents_agency_id')
  @Column({ type: 'uuid', name: 'agency_id', nullable: true })
  agencyId!: string | null;

  @ManyToOne(() => Agency, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'agency_id' })
  agency!: Agency | null;

  @Column({
    type: 'varchar',
    length: 180,
    name: 'agency_name',
    nullable: true,
  })
  agencyName!: string | null;

  /** Hodisani boshlab bergan texnik ogohlantirish (bo'lsa). */
  @Column({ type: 'uuid', name: 'source_alert_id', nullable: true })
  sourceAlertId!: string | null;

  @ManyToOne(() => Alert, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'source_alert_id' })
  sourceAlert!: Alert | null;

  // ───────────────── O'lchov ─────────────────

  /** Aniqlangan paytdagi harorat. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  temperature!: number | null;

  /** Oxirgi ma'lum harorat — hodisa davomida yangilanadi. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'current_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  currentTemperature!: number | null;

  /**
   * ENG YOMON qiymat: past harorat turlarida — eng pasti, qizishda — eng
   * yuqorisi. «Eng sovuq payti necha edi» — hisobotdagi asosiy savol.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'extreme_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  extremeTemperature!: number | null;

  /** Belgilangan me'yor (minimal xona harorati / kotyol chegarasi). */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  threshold!: number | null;

  // ───────────────── Vaqt ─────────────────

  /** Muammo BIRINCHI marta aniqlangan lahza — hech qachon o'zgarmaydi. */
  @Column({ type: 'timestamptz', name: 'detected_at' })
  detectedAt!: Date;

  /**
   * Eskalatsiya hisobining boshlanishi: aniqlangan yoki QAYTA OCHILGAN payt.
   * ⚠️ `detectedAt` dan ajratilgan: qayta ochilgan hodisa bir zumda
   * «4 soatdan beri hal qilinmadi» deb eskalatsiya qilinmasligi kerak.
   */
  @Column({ type: 'timestamptz', name: 'opened_at' })
  openedAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  // ───────────────── Muhrlangan kontekst ─────────────────

  @Column({ type: 'jsonb', name: 'schedule_snapshot', nullable: true })
  scheduleSnapshot!: ScheduleSnapshot | null;

  @Column({
    type: 'jsonb',
    name: 'responsible_snapshot',
    default: () => "'[]'",
  })
  responsibleSnapshot!: ResponsibleSnapshot[];

  // ───────────────── Jarayon ─────────────────

  @Column({ type: 'timestamptz', name: 'acknowledged_at', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ type: 'uuid', name: 'acknowledged_by_id', nullable: true })
  acknowledgedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'acknowledged_by_id' })
  acknowledgedBy!: User | null;

  @Column({ type: 'timestamptz', name: 'in_progress_at', nullable: true })
  inProgressAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;

  /** `null` + `resolution = 'auto'` — tizim (harorat tiklandi). */
  @Column({ type: 'uuid', name: 'resolved_by_id', nullable: true })
  resolvedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy!: User | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  resolution!: 'auto' | 'manual' | null;

  @Column({
    type: 'varchar',
    length: 2000,
    name: 'resolution_note',
    nullable: true,
  })
  resolutionNote!: string | null;

  @Column({ type: 'timestamptz', name: 'closed_at', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'uuid', name: 'closed_by_id', nullable: true })
  closedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'closed_by_id' })
  closedBy!: User | null;

  @Column({ type: 'varchar', length: 2000, name: 'close_note', nullable: true })
  closeNote!: string | null;

  // ───────────────── Eskalatsiya va takrorlanish ─────────────────

  /** Oxirgi bajarilgan eskalatsiya darajasi (0 — hali ko'tarilmagan). */
  @Column({ type: 'smallint', name: 'escalation_level', default: 0 })
  escalationLevel!: number;

  @Column({ type: 'timestamptz', name: 'last_escalated_at', nullable: true })
  lastEscalatedAt!: Date | null;

  /** Necha marta qayta ochilgan (harorat chegara atrofida «sakrasa»). */
  @Column({ type: 'int', name: 'reopen_count', default: 0 })
  reopenCount!: number;
}

/**
 * XAVF TARIXI — QAT'IY append-only (`updated_at` yo'q).
 *
 * ⚠️ «Kim, qachon, nima qildi» shu yerda: qabul qilish, izoh, bajarilgan
 * ish, holat o'zgarishi, avtomatik bartaraf, qayta ochilish, eskalatsiya,
 * kimga yuborilgani. Hodisa qatoridagi maydonlar faqat JORIY holat —
 * tarix esa yo'qolmasligi kerak.
 */
@Entity('incident_events')
@Index('IDX_incident_events_incident_time', ['incidentId', 'createdAt'])
export class IncidentEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'uuid', name: 'incident_id' })
  incidentId!: string;

  @ManyToOne(() => Incident, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'incident_id' })
  incident!: Incident;

  @Column({ type: 'varchar', length: 24 })
  type!: IncidentEventType;

  @Column({ type: 'varchar', length: 16, name: 'from_status', nullable: true })
  fromStatus!: IncidentStatus | null;

  @Column({ type: 'varchar', length: 16, name: 'to_status', nullable: true })
  toStatus!: IncidentStatus | null;

  /** `null` — tizim. */
  @Column({ type: 'uuid', name: 'actor_id', nullable: true })
  actorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id' })
  actor!: User | null;

  /** Kim bo'lgani MATN bilan ham — foydalanuvchi o'chirilsa ham qoladi. */
  @Column({ type: 'varchar', length: 200, name: 'actor_label' })
  actorLabel!: string;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  note!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;
}

/**
 * PANEL OGOHLANTIRISHI — har qabul qiluvchiga bitta qator.
 *
 * ⚠️⚠️ `(incident_id, user_id, level)` YAGONA: qayta yuborish, ikki cron
 * nusxasi yoki qayta ochilish bitta odamga bitta darajada IKKINCHI xabar
 * yarata olmaydi («cheksiz takroriy ogohlantirish» yo'q).
 *
 * ⚠️ `userId` o'chirilsa `NULL`, lekin `recipientLabel` qoladi: «kimga
 * yuborilgan edi» degan savol hisob o'chgandan keyin ham javobli.
 */
@Entity('incident_notifications')
@Index('IDX_incident_notifications_user_read', ['userId', 'readAt'])
export class IncidentNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Index('IDX_incident_notifications_incident_id')
  @Column({ type: 'uuid', name: 'incident_id' })
  incidentId!: string;

  @ManyToOne(() => Incident, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'incident_id' })
  incident!: Incident;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({ type: 'varchar', length: 200, name: 'recipient_label' })
  recipientLabel!: string;

  @Column({ type: 'varchar', length: 16 })
  audience!: NotifyAudience;

  /** 0 — dastlabki yuborish, 1+ — eskalatsiya darajasi. */
  @Column({ type: 'smallint', default: 0 })
  level!: number;

  @Column({ type: 'timestamptz', name: 'read_at', nullable: true })
  readAt!: Date | null;
}

/**
 * ESKALATSIYA QOIDASI — administrator sozlaydi.
 *
 * ⚠️⚠️ HAR DARAJA BIR MARTA ishlaydi (`incidents.escalation_level` faqat
 * o'sadi). «Cheksiz takroriy ogohlantirish» shu bilan strukturaviy
 * imkonsiz: qoida soni — xabar sonining yuqori chegarasi.
 *
 * ⚠️ `severity = null` — barcha og'irlik uchun umumiy qoida; aniq
 * og'irlikdagi qoida AYNI darajadagi umumiyni almashtiradi.
 */
@Entity('escalation_rules')
export class EscalationRule extends BaseEntity {
  @Column({ type: 'varchar', length: 16, nullable: true })
  severity!: AlertSeverity | null;

  @Column({ type: 'smallint' })
  level!: number;

  @Column({ type: 'varchar', length: 24 })
  condition!: EscalationCondition;

  /** Hodisa ochilganidan (`openedAt`) necha daqiqa o'tgach. */
  @Column({ type: 'int', name: 'after_minutes' })
  afterMinutes!: number;

  /** Kimga ko'tariladi: `district` | `agency` | `region`. */
  @Column({ type: 'varchar', length: 16 })
  target!: NotifyAudience;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;
}
