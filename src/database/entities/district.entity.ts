import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { Region } from './region.entity';

/**
 * TUMAN / SHAHAR — xaritaning asosiy kesimi.
 *
 * ⚠️ Geometriya (`geometry`) AYNAN shu jadvalda, alohida «geo» xizmatida
 * emas: xaritadagi har bir ko'pburchak ustida kotyollar soni yoziladi va
 * ikkalasi bitta so'rovda olinishi kerak. Ajratilsa, frontend ikkita
 * manbani ID bo'yicha qo'lda birlashtirardi va bitta nomi o'zgargan
 * tuman jimgina «0 kotyol» bo'lib qolardi.
 */
@Entity('districts')
export class District extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  /** To'liq nom: «Jalaquduq tumani». */
  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** Xaritadagi qisqa yorliq: «Jalaquduq». */
  @Column({ type: 'varchar', length: 120, name: 'short_name' })
  shortName!: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  soato!: string | null;

  /** `city` — shahar, `district` — tuman. Xaritada yorliq shunga qarab. */
  @Column({ type: 'varchar', length: 24, default: 'district' })
  kind!: string;

  @Index()
  @Column({ type: 'uuid', name: 'region_id' })
  regionId!: string;

  @ManyToOne(() => Region, (region) => region.districts, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'region_id' })
  region!: Region;

  @Column({ type: 'double precision', name: 'center_lat' })
  centerLat!: number;

  @Column({ type: 'double precision', name: 'center_lng' })
  centerLng!: number;

  /**
   * GeoJSON geometriyasi (`Polygon` yoki `MultiPolygon`).
   *
   * ⚠️ PostGIS ISHLATILMAYDI va bu ataylab: tizimda birorta FAZOVIY
   * so'rov yo'q (kesishuv, masofa, ichida-tashqarida). Chegara faqat
   * CHIZISH uchun kerak, uni esa `jsonb` sifatida o'qib brauzerga
   * uzatish yetarli. PostGIS qo'shilsa, deploy har bir serverga
   * kengaytma o'rnatishni talab qilardi.
   */
  @Column({ type: 'jsonb', nullable: true })
  geometry!: Record<string, unknown> | null;

  @OneToMany(() => Boiler, (boiler) => boiler.district)
  boilers!: Boiler[];
}
