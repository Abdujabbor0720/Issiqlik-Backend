import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { ResponsibilityType } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { Organization } from './catalog.entities';
import { District } from './district.entity';
import { User } from './user.entity';

/**
 * JAVOBGAR SHAXS — XAVF kartasida «kim javob beradi» degan savolning javobi.
 *
 * ⚠️⚠️ FOYDALANUVCHI (`users`) EMAS. Maktab direktori yoki xo'jalik mudiri
 * ko'pincha tizimga umuman kirmaydi, lekin uning F.I.Sh., lavozimi va xizmat
 * telefoni ogohlantirishda turishi SHART — tuman mas'uli unga aynan shu
 * raqam bilan qo'ng'iroq qiladi. Agar javobgar faqat foydalanuvchi bo'lsa,
 * hisobi yo'q direktorni reyestrga kiritib bo'lmasdi.
 *
 * ⚠️ Panelga kiradigan javobgar uchun `userId` (rol `responsible`) —
 * ixtiyoriy bog'lanish: u o'z obyektlarining XAVF hodisalarini ko'radi.
 *
 * ⚠️ O'CHIRILMAYDI — FAOLSIZLANTIRILADI (`isActive`). O'tgan hodisalar
 * kartasida u turadi (`incidents.responsible_snapshot`), reyestrdan
 * yo'qolsa «kim edi» degan savol javobsiz qolardi.
 *
 * ⚠️ `boilers.responsible_name/phone` (eski erkin matn) bilan
 * chalkashtirmang: u qozonxona pasportidagi yozuv bo'lib qoladi, XAVF esa
 * faqat shu reyestrga tayanadi.
 */
@Entity('responsible_persons')
export class ResponsiblePerson extends BaseEntity {
  @Column({ type: 'varchar', length: 160, name: 'full_name' })
  fullName!: string;

  /** Lavozimi: «Xo'jalik ishlari bo'yicha direktor o'rinbosari». */
  @Column({ type: 'varchar', length: 160 })
  position!: string;

  /**
   * TASHKILOTI — qayerda ishlaydi (erkin matn).
   *
   * ⚠️ Katalog yozuvi EMAS: isitish texnigi ko'pincha xizmat ko'rsatuvchi
   * firmadan (DXSH) yoki tuman bo'limidan keladi — muassasa katalogida u
   * yo'q. Bog'lanish esa `responsible_assignments` da, bu faqat yorliq.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  employer!: string | null;

  /** XIZMAT telefoni — ko'rsatish `responsibles.contacts` ruxsatiga bog'liq. */
  @Column({ type: 'varchar', length: 32 })
  phone!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  email!: string | null;

  /**
   * UY TUMANI — reyestrni tuman mas'uli boshqarishi uchun.
   *
   * ⚠️ `null` — viloyat darajasidagi shaxs (masalan, boshqarma texnigi bir
   * nechta tumandagi obyektlarga javob beradi). Tuman mas'uli bunday
   * shaxsni tahrirlay olmaydi, faqat o'z tumanidagi obyektlarga
   * biriktirilganini ko'radi.
   */
  @Index('IDX_responsible_persons_district_id')
  @Column({ type: 'uuid', name: 'district_id', nullable: true })
  districtId!: string | null;

  @ManyToOne(() => District, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'district_id' })
  district!: District | null;

  /** Panelga kiradigan hisob (`responsible` roli) — ixtiyoriy, yagona. */
  @Index('UQ_responsible_persons_user_id', { unique: true })
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;
}

/**
 * BIRIKTIRISH — «shu shaxs shu muassasa (yoki aynan shu qozonxona) uchun
 * shu turdagi javobgar».
 *
 * ⚠️⚠️ NISHON IKKI XIL: muassasa (`organizationId`) YOKI aniq qozonxona
 * (`boilerId`) — bittasi, ikkalasi emas (bazada CHECK). Odatda javobgar
 * MUASSASAGA biriktiriladi va uning barcha qozonxonalariga o'tadi; katta
 * shifoxonada esa har qozonxonaning o'z texnigi bo'ladi.
 *
 * ⚠️ Bitta nishonda BITTA asosiy (`isPrimary`) javobgar — bazada qisman
 * yagona indeks. Ikkita «asosiy» bo'lsa, ogohlantirish kartasida kim
 * birinchi turishi tasodifga qolardi.
 *
 * ⚠️ Biriktirish o'chirilsa (javobgar almashdi) O'TGAN hodisalar
 * buzilmaydi: ular javobgarni o'z ichiga muhrlab olgan.
 */
@Entity('responsible_assignments')
export class ResponsibleAssignment extends BaseEntity {
  @Index('IDX_responsible_assignments_responsible_id')
  @Column({ type: 'uuid', name: 'responsible_id' })
  responsibleId!: string;

  @ManyToOne(() => ResponsiblePerson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'responsible_id' })
  responsible!: ResponsiblePerson;

  @Index('IDX_responsible_assignments_organization_id')
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization!: Organization | null;

  @Index('IDX_responsible_assignments_boiler_id')
  @Column({ type: 'uuid', name: 'boiler_id', nullable: true })
  boilerId!: string | null;

  @ManyToOne(() => Boiler, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler | null;

  @Column({
    type: 'varchar',
    length: 24,
    name: 'responsibility_type',
    default: ResponsibilityType.OTHER,
  })
  responsibilityType!: ResponsibilityType;

  @Column({ type: 'boolean', name: 'is_primary', default: false })
  isPrimary!: boolean;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;
}
