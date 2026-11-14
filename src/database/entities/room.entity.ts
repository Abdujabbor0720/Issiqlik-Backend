import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import {
  numericTransformer,
  requiredNumericTransformer,
} from './column-transformers';

/**
 * XONA — bino ichidagi havo harorati o'lchanadigan joy.
 *
 * ⚠️⚠️ KOTYOLGA (BINOGA) TEGISHLI, QURILMAGA EMAS. Plata almashtirilsa
 * datchiklar va ularning manzillari (`sensorKey`) o'zgarmaydi; xona
 * qurilmaga bog'langanda esa nomlar («1-sinf») yo'qolib, tarix ikkiga
 * bo'linardi. Batafsil — migratsiya `1763500000000-RoomTemperature`.
 *
 * ⚠️ Xona AVTOMATIK yaratiladi: qurilma noma'lum datchik kaliti bilan
 * o'lchov yuborsa, «Xona N» nomi bilan qator paydo bo'ladi va admin
 * keyin uni nomlaydi. Qo'lda oldindan yaratish talab qilinsa, montajchi
 * har datchik manzilini qog'ozga yozib, kabinetga kiritishi kerak
 * bo'lardi — 500 ta bino uchun bu bajarilmaydigan ish.
 */
@Entity('rooms')
@Index('UQ_rooms_boiler_sensor', ['boilerId', 'sensorKey'], { unique: true })
export class Room extends BaseEntity {
  @Column({ type: 'uuid', name: 'boiler_id' })
  boilerId!: string;

  @ManyToOne(() => Boiler, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler;

  /**
   * DATCHIK KALITI — normallashtirilgan (kichik harf).
   *
   * ⚠️ Odatda DS18B20 ning 64-bitli manzili (`28ff4a2b1c000042`),
   * lekin proshivka istalgan barqaror satrni yuborishi mumkin
   * (`xona_1`). Kalit O'ZGARMAYDI — nomi o'zgaradi.
   */
  @Column({ type: 'varchar', length: 64, name: 'sensor_key' })
  sensorKey!: string;

  /** Ko'rsatiladigan nom: «1-sinf», «Direktor xonasi». */
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  note!: string | null;

  /** Ro'yxatdagi tartib (kichigi yuqorida). */
  @Column({ type: 'int', name: 'sort_order', default: 0 })
  sortOrder!: number;

  /** Datchikdan avtomatik yaratilgan va hali nomlanmagan. */
  @Column({ type: 'boolean', name: 'is_auto_created', default: false })
  isAutoCreated!: boolean;

  /**
   * NAZORATDA — o'rtacha haroratga va ogohlantirishga kiradimi.
   *
   * ⚠️ `false` — qozonxona xonasi yoki ta'mirdagi xona: ko'rinadi,
   * lekin statistikani buzmaydi va yolg'on xabar ochmaydi.
   */
  @Column({ type: 'boolean', name: 'is_monitored', default: true })
  isMonitored!: boolean;

  /** Oxirgi harorat, °C — HAR signalda yangilanadi. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'last_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  lastTemperature!: number | null;

  @Column({ type: 'timestamptz', name: 'last_reading_at', nullable: true })
  lastReadingAt!: Date | null;

  /**
   * TARIXGA oxirgi marta qachon yozilgan.
   *
   * ⚠️ `lastReadingAt` dan FARQLI: tarix siyraklashtiriladi
   * (`room_sample_minutes`), joriy qiymat esa har signalda. Ikkisi
   * bitta maydon bo'lsa, siyraklashtirishni hisoblab bo'lmasdi.
   */
  @Column({ type: 'timestamptz', name: 'last_logged_at', nullable: true })
  lastLoggedAt!: Date | null;
}

/**
 * XONA TARIXI — siyraklashtirilgan (sukut: 10 daqiqada bitta).
 *
 * ⚠️ `BaseEntity` dan meros OLMAYDI: `updated_at` keraksiz (qator hech
 * qachon o'zgarmaydi) va bu jadval tizimdagi eng katta jadvallardan
 * biri — har ortiqcha ustun millionlab qatorga ko'payadi.
 */
@Entity('room_readings')
@Index('IDX_room_readings_room_time', ['roomId', 'recordedAt'])
@Index('IDX_room_readings_recorded_at', ['recordedAt'])
export class RoomReading {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'uuid', name: 'room_id' })
  roomId!: string;

  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room!: Room;

  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    transformer: requiredNumericTransformer,
  })
  temperature!: number;

  @Column({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;
}
