import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { District } from './district.entity';

/**
 * KATALOG YOZUVLARI — uchta jadval, bitta shakl.
 *
 * ⚠️ Nega erkin matn EMAS: «Ferroli», «FERROLI», «Ferolli» — bitta
 * markaning uch yozuvi hisobotni uch qatorga bo'lib yuborardi va
 * «qaysi marka ko'p ishlamayapti» degan savolga javob bo'lmasdi.
 *
 * ⚠️ Nega `enum` ham EMAS: marka, firma va tashkilot ro'yxati hayotda
 * o'zgaradi — yangi firma qo'shish uchun migratsiya va deploy kerak
 * bo'lmasligi kerak. Katalogni admin o'zi to'ldiradi.
 *
 * ⚠️ O'CHIRISH O'RNIGA ARXIVLASH (`isArchived`): eski kotyollar yozuvga
 * ishora qiladi va u o'chirilsa, o'tgan yil hisoboti «noma'lum marka»
 * bilan to'lib ketardi.
 */
abstract class CatalogEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 180 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ type: 'boolean', name: 'is_archived', default: false })
  isArchived!: boolean;
}

/** Kotyol markasi: «Ferroli», «Buderus», «Kiturami». */
@Entity('boiler_brands')
@Index('UQ_boiler_brands_name', ['name'], { unique: true })
export class BoilerBrand extends CatalogEntity {
  /** Ishlab chiqaruvchi davlat — hisobot kesimi uchun. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  country!: string | null;
}

/** DXSH firma — kotyolga xizmat ko'rsatuvchi tashkilot. */
@Entity('firms')
@Index('UQ_firms_name', ['name'], { unique: true })
export class Firm extends CatalogEntity {
  /** STIR (INN) — hujjatlarda shu bo'yicha qidiriladi. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  tin!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({
    type: 'varchar',
    length: 160,
    name: 'director_name',
    nullable: true,
  })
  directorName!: string | null;
}

/**
 * OBYEKT TURI — maktab, bog'cha, shifoxona, kollej, hokimlik…
 *
 * ⚠️⚠️ Ilgari bu `organizations.kind` ustunidagi QOTIRILGAN ro'yxat
 * edi (`'school' | 'hospital' | …`). Yangi tur qo'shish uchun
 * migratsiya, backend relizi va frontend relizi kerak bo'lardi —
 * holbuki «sport maktabi» yoki «tibbiyot punkti» qo'shish ma'muriy
 * qaror, dasturchi ishi emas. Endi u boshqa kataloglar kabi
 * jadvalda va admin uni o'zi to'ldiradi.
 *
 * ⚠️ O'chirish o'rniga ARXIVLASH (`CatalogEntity`): eski tashkilotlar
 * turga ishora qiladi va u o'chirilsa, hisobot «noma'lum tur» bilan
 * to'lib ketardi.
 */
@Entity('object_types')
@Index('UQ_object_types_name', ['name'], { unique: true })
export class ObjectType extends CatalogEntity {
  /**
   * ⚠️ MASHINA KALITI (`school`, `hospital`) — nom emas.
   * Seed va eski ma'lumot aynan shu kalit bo'yicha moslanadi; nom
   * esa tahrirlanadi va unga bog'lanib bo'lmaydi.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code!: string;
}

/**
 * MUASSASA (KATALOG YOZUVI) — kotyol O'RNATILGAN obyekt egasi: maktab,
 * bog'cha, shifoxona…
 *
 * ⚠️⚠️ TUMANGA TEGISHLI (`districtKey`). «12-maktab» har tumanda bor,
 * shuning uchun nom yagonaligi TUMAN ICHIDA
 * (`UQ_organizations_district_name`: `COALESCE(district_key,''), name` —
 * ifodali indeks, dekorator bilan e'lon qilib bo'lmaydi).
 *
 * ⚠️ Qurilma yuborgan `institution_name` bu yerga TO'G'RIDAN-TO'G'RI
 * yozilmaydi: u faqat TAKLIF va admin tasdiqlagandagina katalog yozuviga
 * aylanadi (`DevicesService.confirmLocation`).
 */
@Entity('organizations')
export class Organization extends CatalogEntity {
  /** Tuman kaliti (`districts.key`). `null` — tarixiy, tumani aniqlanmagan yozuv. */
  @Index('IDX_organizations_district_key')
  @Column({
    type: 'varchar',
    length: 32,
    name: 'district_key',
    nullable: true,
  })
  districtKey!: string | null;

  @ManyToOne(() => District, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'district_key', referencedColumnName: 'key' })
  district!: District | null;

  /** Ixtiyoriy MFY. */
  @Column({ type: 'uuid', name: 'mahalla_id', nullable: true })
  mahallaId!: string | null;

  @ManyToOne(() => Mahalla, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'mahalla_id' })
  mahalla!: Mahalla | null;

  /** Obyekt turi — `object_types` katalogidan. */
  @Index()
  @Column({ type: 'uuid', name: 'object_type_id', nullable: true })
  objectTypeId!: string | null;

  @ManyToOne(() => ObjectType, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'object_type_id' })
  objectType!: ObjectType | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;
}

/**
 * MFY (MAHALLA) — tumanning ichki birligi.
 *
 * ⚠️ Ro'yxat `andijon-tumanlar-mfylar.json` dan import qilinadi
 * (`npm run import:mfy`). Qo'lda ham qo'shiladi («Kataloglar → MFYlar»).
 * O'chirilmaydi — arxivlanadi: muassasalar unga ishora qiladi.
 */
@Entity('mahallas')
export class Mahalla extends BaseEntity {
  /** ⚠️ Indeks: `UQ_mahallas_district_name (district_key, lower(name))`. */
  @Column({ type: 'varchar', length: 32, name: 'district_key' })
  districtKey!: string;

  @ManyToOne(() => District, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'district_key', referencedColumnName: 'key' })
  district!: District;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'boolean', name: 'is_archived', default: false })
  isArchived!: boolean;
}
