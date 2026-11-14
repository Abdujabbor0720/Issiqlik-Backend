import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BoilerStatus, FuelType } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { BoilerBrand, Firm, Organization } from './catalog.entities';
import { Device } from './device.entity';
import { District } from './district.entity';
import { numericTransformer } from './column-transformers';

/**
 * KOTYOL (qozonxona obyekti) — tizimning markaziy yozuvi.
 *
 * Bitta qator = bitta QOZONXONA (lot), uning ichida bir nechta kotyol
 * bo'lishi mumkin (`boilerCount`). ESP32 moduli esa qozonxonaga
 * biriktiriladi va chiqish haroratini yuboradi.
 */
@Entity('boilers')
@Index('IDX_boilers_district_status', ['districtId', 'currentStatus'])
export class Boiler extends BaseEntity {
  // ───────────────── Joylashuv ─────────────────

  @Index()
  @Column({ type: 'uuid', name: 'district_id' })
  districtId!: string;

  @ManyToOne(() => District, (district) => district.boilers, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'district_id' })
  district!: District;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  /**
   * Xaritadagi aniq nuqta.
   *
   * ⚠️ Majburiy EMAS: ro'yxat Excel'dan koordinatasiz ham kiritiladi va
   * koordinatasi yo'q kotyol xaritada NUQTA bo'lib chizilmaydi, lekin
   * tuman SANOG'IGA baribir kiradi — aks holda «16 ta kotyol bor-u,
   * xaritada 9 tasi» degan farq paydo bo'lardi.
   */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  lat!: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  lng!: number | null;

  // ───────────────── Hujjat ma'lumotlari ─────────────────

  /**
   * LOT RAQAMI — xarid hujjatidagi raqam.
   * ⚠️ Yagona (unique): bitta lot ikki marta kiritilsa, kotyollar soni
   * ikki baravar bo'lib ko'rinardi.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'lot_number' })
  lotNumber!: string;

  /** DXSH firma — xizmat ko'rsatuvchi. */
  @Index()
  @Column({ type: 'uuid', name: 'firm_id', nullable: true })
  firmId!: string | null;

  @ManyToOne(() => Firm, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'firm_id' })
  firm!: Firm | null;

  /** Tashkilot — kotyol o'rnatilgan obyekt (maktab, shifoxona...). */
  @Index()
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  @ManyToOne(() => Organization, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization!: Organization | null;

  /** Kotyol markasi. */
  @Index()
  @Column({ type: 'uuid', name: 'brand_id', nullable: true })
  brandId!: string | null;

  @ManyToOne(() => BoilerBrand, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'brand_id' })
  brand!: BoilerBrand | null;

  /** Qozonxonadagi kotyollar soni. */
  @Column({ type: 'int', name: 'boiler_count', default: 1 })
  boilerCount!: number;

  /**
   * 60 GRADUSDA NORMA — hujjatdagi me'yoriy ko'rsatkich.
   *
   * ⚠️ Bu HOLAT chegarasi EMAS. Holat chiqish haroratidan, tizim
   * sozlamasidagi chegaralar bo'yicha aniqlanadi (`system_settings`).
   * Bu maydon hujjat ma'lumoti: me'yor bilan FAKTNI solishtirish
   * hisobotda alohida ustun bo'lib chiqadi.
   */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    name: 'norm_at_60',
    nullable: true,
    transformer: numericTransformer,
  })
  normAt60!: number | null;

  @Column({
    type: 'enum',
    enum: FuelType,
    name: 'fuel_type',
    default: FuelType.GAS,
  })
  fuelType!: FuelType;

  /** Quvvat, kVt — ixtiyoriy pasport ma'lumoti. */
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    name: 'capacity_kw',
    nullable: true,
    transformer: numericTransformer,
  })
  capacityKw!: number | null;

  @Column({ type: 'int', name: 'installed_year', nullable: true })
  installedYear!: number | null;

  // ───────────────── Mas'ul ─────────────────

  @Column({
    type: 'varchar',
    length: 160,
    name: 'responsible_name',
    nullable: true,
  })
  responsibleName!: string | null;

  @Column({
    type: 'varchar',
    length: 32,
    name: 'responsible_phone',
    nullable: true,
  })
  responsiblePhone!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  // ───────────────── Joriy holat (denormallashtirilgan) ─────────────────

  /*
   * ⚠️ JORIY HOLAT SHU YERDA SAQLANADI, har so'rovda hisoblanmaydi.
   *
   * Xarita va dashboard butun viloyatni BITTA so'rovda o'qiydi. Agar
   * holat telemetriya jadvalidan hisoblansa, har kotyol uchun oxirgi
   * o'lchovni topish kerak bo'lardi — million qatorli jadvalda bu
   * `DISTINCT ON` yoki window funksiya, ya'ni har sahifa ochilishida
   * sekundlar. Qiymat IKKI joyda yangilanadi va ikkalasi ham AYNI
   * funksiyani chaqiradi (`resolveBoilerStatus`):
   *   1) telemetriya kelganda (`telemetry.service.ts`);
   *   2) holat kuzatuvchisi cron'ida (`status-watcher.job.ts`) — signal
   *      KELMAY QO'YSA holat o'z-o'zidan «offline» ga o'tishi uchun.
   *
   * ⚠️ Ikkinchisisiz qurilma uzilganda kotyol abadiy «faol» bo'lib
   * turardi: oxirgi o'lchov issiq bo'lgan va uni yangilaydigan hech
   * narsa yo'q.
   */
  @Index()
  @Column({
    type: 'enum',
    enum: BoilerStatus,
    name: 'current_status',
    default: BoilerStatus.OFFLINE,
  })
  currentStatus!: BoilerStatus;

  /** Oxirgi o'lchangan chiqish harorati, °C. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'last_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  lastTemperature!: number | null;

  /**
   * Oxirgi o'lchangan KIRISH (obratka) harorati, °C.
   *
   * ⚠️ `null` bo'lishi normal: eski proshivkali qurilmalar kirish
   * haroratini umuman yubormaydi.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'last_inlet_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  lastInletTemperature!: number | null;

  /**
   * Oxirgi o'lchangan CHIQISH harorati — `lastTemperature` bilan AYNI.
   *
   * ⚠️ Nusxa ataylab: `lastTemperature` — tizimning tarixiy ustuni
   * (xarita, KPI kartalari, holat formulasi shunga tayangan), bu esa
   * aniq nomlangan juftlik a'zosi. Ikkisi HAR DOIM teng bo'lishini
   * `telemetry.service.ts` kafolatlaydi — ular bitta joyda, bitta
   * `UPDATE` bilan yoziladi.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'last_outlet_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  lastOutletTemperature!: number | null;

  @Column({ type: 'timestamptz', name: 'last_reading_at', nullable: true })
  lastReadingAt!: Date | null;

  /** Holat oxirgi marta QACHON o'zgargan — «3 soatdan beri sovuq». */
  @Column({ type: 'timestamptz', name: 'status_changed_at', nullable: true })
  statusChangedAt!: Date | null;

  /**
   * Bugungi o'rtacha harorat — kun davomida yangilanib boradi.
   * ⚠️ Faqat KO'RSATISH uchun: hisobot baribir telemetriyadan hisoblanadi.
   * Ro'yxatda esa har qator uchun agregat so'rov yuborib bo'lmaydi.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'today_avg_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  todayAvgTemperature!: number | null;

  // ───────────────── Hayot sikli ─────────────────

  /**
   * ⚠️ Kotyol O'CHIRILMAYDI — ARXIVLANADI. Telemetriya, ogohlantirish va
   * hisobot unga ishora qiladi; qator o'chirilsa, o'tgan mavsum hisoboti
   * jimgina kamayib qolardi.
   */
  @Index()
  @Column({ type: 'boolean', name: 'is_archived', default: false })
  isArchived!: boolean;

  @Column({
    type: 'varchar',
    length: 500,
    name: 'archive_note',
    nullable: true,
  })
  archiveNote!: string | null;

  @OneToMany(() => Device, (device) => device.boiler)
  devices!: Device[];
}
