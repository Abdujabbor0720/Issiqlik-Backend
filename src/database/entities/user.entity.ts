import { Exclude } from 'class-transformer';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { UserRole } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { District } from './district.entity';

/**
 * FOYDALANUVCHI.
 *
 * ⚠️ Kirish LOGIN bilan, email bilan emas: tizim hududiy va foydalanuvchilar
 * (tuman operatorlari) ko'pincha xizmat emailiga ega emas. Email ixtiyoriy
 * maydon bo'lib qoladi — xabarnoma uchun.
 */
@Entity('users')
export class User extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  login!: string;

  /**
   * ⚠️ `@Exclude()` + `select: false` — IKKI qavat.
   * `select: false` parolni so'rovdan chiqarib tashlaydi, `@Exclude()` esa
   * uni javobdan. Ikkinchisi kerak, chunki autentifikatsiya oqimi parolni
   * ATAYLAB tanlaydi (`addSelect`) va o'sha obyekt tasodifan javobga
   * tushib qolishi mumkin.
   */
  @Exclude()
  @Column({
    type: 'varchar',
    length: 255,
    name: 'password_hash',
    select: false,
  })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 160, name: 'full_name' })
  fullName!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  position!: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.VIEWER })
  role!: UserRole;

  /**
   * MA'LUMOT CHEGARASI — ruxsat emas.
   *
   * ⚠️ `operator` rolidagi foydalanuvchi FAQAT shu tumanning kotyollarini
   * ko'radi. Qiymat `null` bo'lsa chegara yo'q (viloyat darajasi).
   * Tekshiruv guard'da emas, so'rovning `where` ida: guard «ha/yo'q»
   * deydi, bu yerda esa ro'yxatning O'ZI torayishi kerak.
   */
  @Index()
  @Column({ type: 'uuid', name: 'district_id', nullable: true })
  districtId!: string | null;

  @ManyToOne(() => District, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'district_id' })
  district!: District | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', name: 'last_login_at', nullable: true })
  lastLoginAt!: Date | null;

  /**
   * KETMA-KET MUVAFFAQIYATSIZ URINISHLAR.
   *
   * ⚠️ Hisob BLOKLANMAYDI, faqat KECHIKTIRILADI (`auth.service.ts`):
   * bloklash «parolni o'nta noto'g'ri urinish bilan raqibning hisobini
   * yopib qo'yish» hujumiga yo'l ochardi — tuman operatori esa ertalab
   * tizimga kira olmay qolardi.
   */
  @Column({ type: 'int', name: 'failed_attempts', default: 0 })
  failedAttempts!: number;

  @Column({ type: 'timestamptz', name: 'locked_until', nullable: true })
  lockedUntil!: Date | null;
}
