import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { District } from './district.entity';

/**
 * VILOYAT.
 *
 * ⚠️ Tizim hozir faqat Andijon bilan ishlaydi, lekin viloyat ALOHIDA
 * jadval: tumanlar to'g'ridan-to'g'ri ildizga bog'lansa, ikkinchi viloyat
 * qo'shilganda xarita chegaralari, statistika va foydalanuvchi kesimi
 * — uchalasi ham qaytadan yozilishi kerak bo'lardi.
 */
@Entity('regions')
export class Region extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  /** SOATO kodi — davlat klassifikatori bo'yicha. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  soato!: string | null;

  @Column({ type: 'double precision', name: 'center_lat', nullable: true })
  centerLat!: number | null;

  @Column({ type: 'double precision', name: 'center_lng', nullable: true })
  centerLng!: number | null;

  /**
   * Xarita chegaralovchi to'rtburchagi: `[minLng, minLat, maxLng, maxLat]`.
   * ⚠️ Frontend xaritani shunga moslaydi (`fitBounds`). Serverda hisoblanadi,
   * chunki geometriya ham shu yerda: brauzer 250 KB geojson'ni o'qib,
   * har ochilishda chegara hisoblab o'tirmasligi kerak.
   */
  @Column({ type: 'jsonb', nullable: true })
  bbox!: number[] | null;

  @OneToMany(() => District, (district) => district.region)
  districts!: District[];
}
