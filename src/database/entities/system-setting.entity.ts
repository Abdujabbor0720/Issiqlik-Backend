import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { requiredNumericTransformer } from './column-transformers';

/**
 * TIZIM SOZLAMALARI — BITTA qator («singleton»).
 *
 * ⚠️ Kalit-qiymat jadvali EMAS. Kalit-qiymat shaklida har bir o'qish
 * `Number(row.value)` ga aylanadi va «chegaralar kamayish tartibida»
 * degan qoidani BIR JOYDA tekshirib bo'lmasdi. Bu yerda esa qator
 * yaxlit: validatsiya bitta DTO da, o'qish bitta so'rovda.
 *
 * ⚠️ `.env` dagi qiymatlar faqat BOSHLANG'ICH: chegarani o'zgartirish
 * uchun serverni qayta ishga tushirish kerak bo'lmasligi kerak —
 * qishda bu bir necha soatlik to'xtash degani.
 */
@Entity('system_settings')
export class SystemSetting extends BaseEntity {
  /**
   * ⚠️ Doimiy `'default'` qiymati + unique indeks: jadvalda IKKINCHI
   * qator paydo bo'lishi STRUKTURAVIY imkonsiz. Aks holda «qaysi
   * sozlama amalda» degan savol bir kuni javobsiz qolardi.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16, default: 'default' })
  scope!: string;

  /** «Faol ishlayotgan» chegarasi, °C (sukut: 50). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'active_min_c',
    default: 50,
    transformer: requiredNumericTransformer,
  })
  activeMinC!: number;

  /** «O'rta ishlayotgan» chegarasi, °C (sukut: 40). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'medium_min_c',
    default: 40,
    transformer: requiredNumericTransformer,
  })
  mediumMinC!: number;

  /** Kritik chegara, °C: bundan past — kotyol sovuq (sukut: 20). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'critical_min_c',
    default: 20,
    transformer: requiredNumericTransformer,
  })
  criticalMinC!: number;

  /** Ortiqcha qizish chegarasi, °C — ogohlantirish uchun (sukut: 95). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'overheat_c',
    default: 95,
    transformer: requiredNumericTransformer,
  })
  overheatC!: number;

  /** Signal kelmasa necha daqiqadan keyin «aloqa yo'q» (sukut: 15). */
  /**
   * SIRKULYATSIYA CHEGARASI, °C — kirish va chiqish AYIRMASI shundan
   * kichik bo'lsa, suv aylanmayapti deb hisoblanadi.
   *
   * ⚠️⚠️ FAQAT ikki datchik ishlaganda qo'llanadi (`probe = 'both'`)
   * va FAQAT kotyol issiq bo'lganda. Sovuq kotyolda ayirma baribir
   * nolga yaqin bo'ladi — unda asosiy muammo «sovuq», «sirkulyatsiya»
   * emas, va ikkinchi xabar birinchisini ko'rinmas qilib qo'yardi.
   */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'min_delta_c',
    default: 3,
    transformer: requiredNumericTransformer,
  })
  minDeltaC!: number;

  @Column({ type: 'int', name: 'offline_after_minutes', default: 15 })
  offlineAfterMinutes!: number;

  /** Hujjatdagi me'yoriy harorat, °C — yangi kotyol uchun sukut (60). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'norm_temperature',
    default: 60,
    transformer: requiredNumericTransformer,
  })
  normTemperature!: number;

  /** Telemetriya necha kun saqlanadi. */
  @Column({ type: 'int', name: 'retention_days', default: 90 })
  retentionDays!: number;

  /** Isitish mavsumi — hisobot sarlavhasi va taqqoslash uchun. */
  @Column({ type: 'varchar', length: 40, name: 'season_label', nullable: true })
  seasonLabel!: string | null;
}
