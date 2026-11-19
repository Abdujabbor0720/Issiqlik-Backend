import { Exclude } from 'class-transformer';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { DeviceType } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { numericTransformer } from './column-transformers';
import { Organization } from './catalog.entities';
import { District } from './district.entity';

/**
 * ESP32 MODULI.
 *
 * Qurilma `POST /api/data` ga `deviceId` va API kaliti bilan murojaat
 * qiladi. Kalit — qurilmaning yagona «paroli», shuning uchun u bilan
 * paroldek muomala qilinadi.
 */
@Entity('devices')
export class Device extends BaseEntity {
  /**
   * Qurilma identifikatori — proshivkadagi `DEVICE_ID` («modul1»).
   *
   * ⚠️ UUID EMAS, qisqa matn: u mikrokontroller kodiga QO'LDA yoziladi
   * va UUID bilan har montajchi bitta belgini adashtirardi. Yagonaligi
   * esa baza darajasida kafolatlanadi.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'device_id' })
  deviceId!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  name!: string | null;

  /**
   * API KALITINING HASH'I — kalitning O'ZI saqlanmaydi.
   *
   * ⚠️ Baza nusxasi (backup, dump, sizib chiqqan log) qo'lga tushsa,
   * undagi qiymat bilan soxta telemetriya yuborib bo'lmaydi. Hash —
   * SHA-256, bcrypt EMAS: tekshiruv HAR SIGNALDA bo'ladi (2000 qurilma
   * × har 30 soniya), bcrypt esa ataylab sekin va serverni yiqitardi.
   * Kalit tasodifiy 32 bayt bo'lgani uchun lug'at hujumi ma'nosiz —
   * bcrypt bu yerda himoya qo'shmaydi.
   */
  @Exclude()
  @Index()
  @Column({ type: 'varchar', length: 64, name: 'api_key_hash' })
  apiKeyHash!: string;

  /**
   * Kalitning oxirgi 6 belgisi — ro'yxatda «qaysi kalit» ni ajratish uchun.
   * ⚠️ To'liq kalit FAQAT yaratilgan/yangilangan paytda, BIR MARTA
   * qaytariladi: keyin uni tizimdan o'qib bo'lmaydi.
   */
  @Column({ type: 'varchar', length: 12, name: 'api_key_preview' })
  apiKeyPreview!: string;

  /**
   * Qaysi kotyolga biriktirilgan.
   *
   * ⚠️ `null` bo'lishi mumkin: qurilma omborda yoki hali o'rnatilmagan.
   * Bunday qurilmadan kelgan signal RAD ETILMAYDI, balki saqlanadi va
   * «biriktirilmagan» deb belgilanadi — montajchi qurilmani ulab,
   * keyin kabinetdan biriktiradi va o'sha paytgacha kelgan ma'lumot
   * yo'qolmaydi.
   */
  @Index()
  @Column({ type: 'uuid', name: 'boiler_id', nullable: true })
  boilerId!: string | null;

  @ManyToOne(() => Boiler, (boiler) => boiler.devices, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt!: Date | null;

  @Column({
    type: 'varchar',
    length: 45,
    name: 'last_ip_address',
    nullable: true,
  })
  lastIpAddress!: string | null;

  @Column({
    type: 'varchar',
    length: 40,
    name: 'firmware_version',
    nullable: true,
  })
  firmwareVersion!: string | null;

  /** Qabul qilingan signallar soni — qurilma «gapiryaptimi» degan savolga javob. */
  @Column({ type: 'bigint', name: 'readings_count', default: 0 })
  readingsCount!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  // ───────────────── ESP32 v2.0.0 ─────────────────

  /**
   * PROSHIVKA AYTGAN MUASSASA (`institution_id`: `maktab-4`).
   *
   * ⚠️⚠️ BU QIYMATGA ISHONILMAYDI va u hech qachon ma'lumotni
   * yo'naltirish uchun ishlatilmaydi. Kotyol FAQAT `boilerId` orqali
   * aniqlanadi (texnik topshiriq §3: «institution_id ga ko'r-ko'rona
   * ishonma»). Aks holda istalgan qurilma tanasida boshqa muassasa
   * nomini yozib, o'sha binoning ma'lumotini buzib ketardi.
   *
   * ⚠️ Saqlanishining YAGONA sababi — MOS KELMASLIKNI ko'rsatish:
   * bu qiymat biriktirilgan kotyolga to'g'ri kelmasa, demak plata
   * boshqa binoga o'rnatilgan yoki sozlashda xato qilingan. Shunda
   * kabinetda ogohlantirish chiqadi, ma'lumot esa buzilmaydi.
   */
  @Column({
    type: 'varchar',
    length: 64,
    name: 'institution_hint',
    nullable: true,
  })
  institutionHint!: string | null;

  /**
   * TUMAN — PLATA O'ZI YUBORADI, KABINETDA O'ZGARTIRILMAYDI.
   *
   * ⚠️⚠️ Biznes qarori (2026-11-14): montajchi plata menyusida tumanni
   * tanlaydi, keyin u hech kim tomonidan tahrirlanmaydi. Modul faqat
   * shu tumandagi kotyolga biriktiriladi va biriktirilmagan modulni
   * faqat shu tuman mas'uli ko'radi. Plata boshqa tumanni yuborsa,
   * eski tumandagi kotyoldan avtomatik ajratiladi.
   *
   * ⚠️ `null` — eski proshivka (tuman yubormaydi): tuman biriktirilgan
   * kotyoldan olinadi. DTO'larda bu maydon YO'Q — ataylab.
   */
  @Index('IDX_devices_district_id')
  @Column({ type: 'uuid', name: 'district_id', nullable: true })
  districtId!: string | null;

  @ManyToOne(() => District, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'district_id' })
  district!: District | null;

  /**
   * Plata yuborgan XOM tuman qiymati — server taniy olmagan holatni
   * ko'rsatish uchun («`9999999` yuboryapti — bunday tuman yo'q»).
   */
  @Column({
    type: 'varchar',
    length: 64,
    name: 'reported_district',
    nullable: true,
  })
  reportedDistrict!: string | null;

  /**
   * UMUMIY TOKENGA RUXSAT — SUKUT BO'YICHA `false`.
   *
   * ⚠️⚠️ Texnik topshiriq (§4) barcha qurilmada BITTA umumiy
   * `DEVICE_TOKEN` ishlatishni taklif qiladi va o'zi ham xavfdan
   * ogohlantiradi: bitta plata qo'lga tushsa, HAMMA muassasa nomidan
   * soxta harorat yuborish mumkin. 16 tumanli viloyatda bu qabul
   * qilinmaydi, shuning uchun tizim shaxsiy tokenlar bilan ishlaydi.
   *
   * ⚠️ `false` — sukutdagi holat, ya'ni YANGI qurilma umumiy token
   * bilan HECH QACHON o'tmaydi. Agar sukut `true` bo'lsa, ro'yxatga
   * qo'shilgan har bir qurilma avtomatik eng zaif usulga ruxsat olib
   * qolardi va buni hech kim sezmasdi.
   *
   * ⚠️ `true` qilish — ONGLI, bitta qurilma uchun qaror (ko'chish
   * davrida, shaxsiy token hali yozilmaganda). Har ishlatilishida
   * jurnalga ogohlantirish yoziladi.
   */
  @Column({ type: 'boolean', name: 'allow_shared_token', default: false })
  allowSharedToken!: boolean;

  /**
   * OTA tekshiruvi oxirgi marta QACHON bo'lgan.
   *
   * ⚠️ `lastSeenAt` DAN FARQLI: qurilmada datchik yoki kotyol
   * biriktirilmagan bo'lsa, u telemetriya YUBORMAYDI, lekin OTA
   * tekshiruvini davom ettiradi. Bitta maydon bo'lsa, bunday qurilma
   * «o'lgan» bo'lib ko'rinardi — holbuki u tirik va yangilanishga
   * tayyor.
   */
  @Column({ type: 'timestamptz', name: 'last_check_at', nullable: true })
  lastCheckAt!: Date | null;

  /**
   * Shaxsiy token QACHON berilgan.
   *
   * ⚠️ Tokenning O'ZI emas, faqat VAQTI. «Bu qurilmada hali ham
   * zavod/umumiy kaliti turibdimi?» degan savolga javob beradi va
   * kabinetda «tokeni yangilanmagan qurilmalar» ro'yxatini chiqarish
   * imkonini beradi.
   */
  @Column({ type: 'timestamptz', name: 'token_issued_at', nullable: true })
  tokenIssuedAt!: Date | null;

  // ───────────────── Xona moduli (DHT22) ─────────────────

  /**
   * MODUL TURI — PLATA O'ZI AYTADI (`X-Module-Type` / `device_type`), aytmasa
   * — yukining shaklidan: faqat xona harorati yuboradigan plata `room`.
   *
   * ⚠️⚠️ OTA shu maydon bo'yicha ajratiladi: `boiler` relizi faqat `boiler`
   * modullariga, `room` relizi faqat `room` modullariga. Kabinetda
   * o'zgartirilmaydi — aks holda bitta bosish qozonxona proshivkasini xona
   * moduliga yo'llab yuborardi.
   */
  @Column({
    type: 'varchar',
    length: 16,
    name: 'device_type',
    default: DeviceType.KOTYOL,
  })
  deviceType!: DeviceType;

  /**
   * PLATA AYTGAN JOYLASHUV — FAQAT KO'RSATISH UCHUN (`institutionHint` bilan
   * AYNI doktrina). Montajchi plata menyusida tanlaydi; tuman mas'uli
   * yuzlab biriktirilmagan modul orasidan O'Z binosidagisini shular bo'yicha
   * topadi. Ma'lumot yo'naltirishda ISHLATILMAYDI.
   *
   * ⚠️ Kelmagan maydon O'CHIRILMAYDI — oxirgi ma'lum qiymat qoladi.
   */
  @Column({
    type: 'varchar',
    length: 120,
    name: 'reported_mfy',
    nullable: true,
  })
  reportedMfy!: string | null;

  @Column({
    type: 'varchar',
    length: 120,
    name: 'reported_institution',
    nullable: true,
  })
  reportedInstitution!: string | null;

  /** «Kataloglar → Obyekt turlari» kodi (`school`), xom ko'rinishda. */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'reported_object_type',
    nullable: true,
  })
  reportedObjectType!: string | null;

  /**
   * OXIRGI XONA HARORATI — QURILMA darajasida.
   *
   * ⚠️ Xona yozuvi (`rooms`) faqat kotyolga BIRIKTIRILGAN modulda yaratiladi
   * (xona binoga tegishli). Biriktirilmagan modul ham «tirik va nimani
   * o'lchayapti» ekani ko'rinishi kerak — aks holda montajchi uni qaysi
   * binoga ulashni tekshira olmasdi.
   */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'last_room_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  lastRoomTemperature!: number | null;

  /** Havo namligi, % (DHT22). Yuborilmasa `null`. */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'last_humidity',
    nullable: true,
    transformer: numericTransformer,
  })
  lastHumidity!: number | null;

  @Column({
    type: 'timestamptz',
    name: 'last_room_reading_at',
    nullable: true,
  })
  lastRoomReadingAt!: Date | null;

  // ───────────────── Paneldagi joylashuv va token ─────────────────

  /**
   * PANELDAGI MUASSASA (katalog yozuvi) — kotyolga biriktirilmagan modul
   * uchun.
   *
   * ⚠️⚠️ JOYLASHUVNING YAGONA MANBAI — PANEL. Qurilma yuborgan
   * `district` / `object_type` / `institution_name` bu yerga
   * TO'G'RIDAN-TO'G'RI yozilmaydi: panelda bo'sh bo'lsa TAKLIF
   * (`reported*`) bo'lib turadi va admin tasdiqlaydi; to'la bo'lsa
   * e'tiborsiz qoldiriladi (jurnalga ogohlantirish).
   *
   * Amaldagi joylashuv: kotyolga ulangan bo'lsa — kotyolniki
   * (`boiler.organization_id`, `boiler.district_id`), aks holda shu maydon
   * va `districtId` (`helpers/device-location.helper.ts`).
   */
  @Index('IDX_devices_organization_id')
  @Column({ type: 'uuid', name: 'organization_id', nullable: true })
  organizationId!: string | null;

  @ManyToOne(() => Organization, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization!: Organization | null;

  /**
   * OXIRGI SO'ROVDA ISHLATILGAN TOKEN TURI — `personal` (shaxsiy kalit) yoki
   * `shared` (umumiy `DEVICE_SHARED_TOKEN`). «Qurilmalar» sahifasidagi
   * «token turi» ustuni. Faqat O'ZGARGANDA yoziladi.
   */
  @Column({
    type: 'varchar',
    length: 16,
    name: 'last_token_kind',
    nullable: true,
  })
  lastTokenKind!: 'personal' | 'shared' | null;
}
