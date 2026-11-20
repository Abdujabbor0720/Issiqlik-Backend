import { Column, Entity } from 'typeorm';
import { ScheduleMode, ScheduleScope } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { numericTransformer } from './column-transformers';

/**
 * MONITORING JADVALI — «qachon past harorat XAVF hisoblanadi».
 *
 * ⚠️⚠️ BITTA JADVAL, TO'RT DARAJA (`scopeType`), kuchlisi yuqorida:
 *   1) `boiler`       — aniq qozonxona (individual jadval);
 *   2) `organization` — muassasa;
 *   3) `object_type`  — obyekt turi bo'yicha sukut (maktab, bog'cha 07:00…);
 *   4) `global`       — umumiy zaxira (24/7), migratsiya yozadi va u
 *                       o'chirilmaydi.
 * Har daraja TO'LIQ jadval: maydonlar darajalar orasida aralashtirilmaydi.
 * Aralashsa, «muassasada faqat soatni o'zgartirdim» degan admin turdan
 * kelgan kunlar bilan kutilmagan jadvalga ega bo'lardi va buni ekranda
 * tushuntirib bo'lmasdi.
 *
 * ⚠️ VAQT — SUTKANING DAQIQASI (0…1439), Toshkent bo'yicha. `time` turi
 * emas: u mintaqa va satr tahlili bilan keladi, solishtirish esa oddiy
 * son bo'lishi kerak. API'da `HH:mm`.
 *
 * ⚠️ `start == end` — «kun bo'yi» (faol kunlarda). `start > end` — tun
 * orqali (22:00…06:00): yarim tundan keyingi qism OLDINGI kunga tegishli.
 *
 * ⚠️ `scopeId` — polimorf (FK yo'q): qaysi jadvalga ishora qilishi
 * `scopeType` ga bog'liq. Mavjudligi saqlashda servisda tekshiriladi;
 * nishoni o'chib ketgan qator zararsiz — u hech kimga tegmaydi.
 */
@Entity('monitoring_schedules')
export class MonitoringSchedule extends BaseEntity {
  @Column({ type: 'varchar', length: 16, name: 'scope_type' })
  scopeType!: ScheduleScope;

  @Column({ type: 'uuid', name: 'scope_id', nullable: true })
  scopeId!: string | null;

  @Column({ type: 'varchar', length: 16, default: ScheduleMode.ALWAYS })
  mode!: ScheduleMode;

  /** ISO hafta kunlari: 1 — dushanba … 7 — yakshanba. */
  @Column({ type: 'smallint', array: true, name: 'active_days' })
  activeDays!: number[];

  /** ISITISH oynasi — kotyol issiq bo'lishi kerak bo'lgan vaqt. */
  @Column({ type: 'smallint', name: 'heating_start_min' })
  heatingStartMin!: number;

  @Column({ type: 'smallint', name: 'heating_end_min' })
  heatingEndMin!: number;

  /** XAVF MONITORINGI oynasi — xona sovuqligi XAVF hisoblanadigan vaqt. */
  @Column({ type: 'smallint', name: 'monitor_start_min' })
  monitorStartMin!: number;

  @Column({ type: 'smallint', name: 'monitor_end_min' })
  monitorEndMin!: number;

  /**
   * MINIMAL XONA HARORATI, °C. `null` — tasdiqlangan umumiy sozlamadan
   * (`system_settings.room_min_c`).
   */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'min_room_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  minRoomTemperature!: number | null;

  /** Bayram kunlari (`monitoring_holidays`) monitoringdan chiqariladimi. */
  @Column({ type: 'boolean', name: 'observe_holidays', default: true })
  observeHolidays!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;
}

/**
 * BAYRAM / DAM OLISH KUNI — butun viloyat uchun (Toshkent kuni).
 *
 * ⚠️ Faqat `observeHolidays = true` jadvallarga ta'sir qiladi: shifoxona
 * bayramda ham isitiladi.
 *
 * ⚠️ `day` — `date` (`'YYYY-MM-DD'` satr, `pg-types.ts` uni Date'ga
 * aylantirmaydi): server mintaqasi kunni siljitmasligi uchun.
 */
@Entity('monitoring_holidays')
export class MonitoringHoliday extends BaseEntity {
  @Column({ type: 'date', unique: true })
  day!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;
}
