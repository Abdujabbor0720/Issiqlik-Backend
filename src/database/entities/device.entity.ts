import { Exclude } from 'class-transformer';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';

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
}
