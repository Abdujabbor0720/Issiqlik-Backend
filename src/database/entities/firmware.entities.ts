import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
  OtaEventStatus,
  RolloutStatus,
  RolloutTargetType,
} from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { Device } from './device.entity';
import { User } from './user.entity';

/**
 * PROSHIVKA OTA BO'LIMI — bitta faylda, chunki bu TO'RT jadval
 * bitta jarayonni tasvirlaydi: reliz yuklandi → tarqatish boshlandi →
 * qurilmalar hisobot berdi → yaroqsiz versiya bloklandi.
 */

/** OTA bo'limi hajm chegarasi, bayt (`min_spiffs.csv` dagi app0/app1). */
export const OTA_PARTITION_MAX_BYTES = 1_966_080;

/**
 * `.bin` ICHIDAGI VERSIYA BELGISI.
 *
 * ⚠️⚠️ Bu satr PROSHIVKADA QOTIRILGAN (`ota.cpp:30`):
 *   const char FW_VERSION_MARK[] = "XONOBOD_FW_VERSION=" FW_VERSION ";";
 * Server yuklangan faylning versiyasini AYNAN shu belgidan o'qiydi.
 * Nomi o'zgartirilsa, mavjud `.bin` fayllar tanilmay qoladi va
 * proshivkani ham qayta yig'ish kerak bo'ladi — shuning uchun
 * loyiha nomi «Issiqlik» bo'lsa ham, belgi O'ZGARMAYDI.
 */
export const FW_VERSION_MARKER = 'XONOBOD_FW_VERSION=';

/**
 * YUKLANGAN PROSHIVKA RELIZI.
 *
 * ⚠️⚠️ FAYLNING O'ZI BAZADA EMAS, faqat yo'li. Sabab: 1.9 MB lik
 * ikkilik fayl `bytea` sifatida saqlansa, har bir yuklab olishda
 * butun fayl bazadan ilovaga, keyin qurilmaga ko'chirilardi va
 * 100 qurilma bir vaqtda yangilanganda baza xotirasi tugardi.
 * Fayl diskda, oqim bilan beriladi.
 *
 * ⚠️⚠️ FAYL WEB ROOT'DAN TASHQARIDA turishi SHART (§6): proshivka
 * ichida qurilma tokeni bo'lishi mumkin. Shuning uchun u statik
 * papkada emas, `FIRMWARE_DIR` da saqlanadi va faqat token
 * tekshirilgandan keyin beriladi.
 */
@Entity('firmware_releases')
@Index('UQ_firmware_releases_version', ['version'], { unique: true })
@Index('UQ_firmware_releases_sha256', ['sha256'], { unique: true })
export class FirmwareRelease extends BaseEntity {
  /**
   * Versiya — `.bin` ICHIDAN o'qilgan, qo'lda kiritilgan EMAS.
   *
   * ⚠️ Qo'lda kiritilgan raqamga ishonilsa, administrator eski faylni
   * yangi raqam bilan yuklab, «hammasi 2.0.2 da» deb hisobot berardi —
   * qurilmalarda esa 2.0.1 ishlab turardi va xato topilmasdi.
   * Shuning uchun yuklash paytida `FW_VERSION_MARKER` dan o'qilgan
   * versiya kiritilgani bilan solishtiriladi va mos kelmasa RAD etiladi.
   */
  @Column({ type: 'varchar', length: 32 })
  version!: string;

  /** Diskdagi to'liq yo'l (`FIRMWARE_DIR` ichida). */
  @Column({ type: 'varchar', length: 500, name: 'file_path' })
  filePath!: string;

  /**
   * SHA-256, 64 kichik hex — SERVERDA hisoblangan.
   *
   * ⚠️⚠️ Qurilma faylni yuklab olayotganda oqim bo'yicha o'zi ham
   * SHA-256 hisoblaydi va mos kelmasa yozilgan qismni BEKOR qiladi
   * (`ota.cpp` dagi `install`). Demak bu qiymat — yarim yuklangan
   * yoki buzilgan proshivkaning qurilmaga yozilishiga qarshi
   * YAGONA himoya. Yuklash paytida fayldan hisoblanadi, tashqaridan
   * qabul qilinmaydi.
   */
  @Column({ type: 'varchar', length: 64 })
  sha256!: string;

  /**
   * Hajm, bayt.
   *
   * ⚠️ Qurilma `Content-Length` ni shu qiymat bilan AYNAN solishtiradi
   * (`ota.cpp`: `if (len != size) return "hajm mos emas"`). Bir bayt
   * farq ham yangilanishni to'xtatadi.
   */
  @Column({ type: 'integer' })
  size!: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', name: 'uploaded_by_id', nullable: true })
  uploadedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploaded_by_id' })
  uploadedBy!: User | null;

  /**
   * Arxivlangan reliz boshqa tarqatilmaydi.
   *
   * ⚠️ O'CHIRILMAYDI: qurilmalarda o'sha versiya hali ishlab turgan
   * bo'lishi mumkin va OTA tarixi («2.0.1 ga yangilandi») reliz
   * yozuvisiz o'qilmas bo'lib qolardi.
   */
  @Column({ type: 'boolean', name: 'is_archived', default: false })
  isArchived!: boolean;
}

/**
 * TARQATISH (rollout) — «qaysi versiyani kimga berish».
 *
 * ⚠️⚠️ BIR VAQTDA FAQAT BITTA `active` TARQATISH bo'lishi BAZADA
 * kafolatlangan (qisman unique indeks). Ikkitasi bo'lsa, bitta
 * qurilmaga ikki xil versiya taklif qilinib, u ularni navbatma-navbat
 * o'rnatib cheksiz halqaga tushardi.
 */
@Entity('firmware_rollouts')
@Index('UQ_firmware_rollouts_one_active', ['status'], {
  unique: true,
  where: `"status" = 'active'`,
})
@Index('IDX_firmware_rollouts_release', ['releaseId'])
export class FirmwareRollout extends BaseEntity {
  @Column({ type: 'uuid', name: 'release_id' })
  releaseId!: string;

  @ManyToOne(() => FirmwareRelease, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'release_id' })
  release!: FirmwareRelease;

  @Column({
    type: 'enum',
    enum: RolloutStatus,
    default: RolloutStatus.ACTIVE,
  })
  status!: RolloutStatus;

  @Column({
    type: 'enum',
    enum: RolloutTargetType,
    name: 'target_type',
  })
  targetType!: RolloutTargetType;

  /**
   * Maqsad ro'yxati — `targetType` ga qarab tuman, obyekt turi yoki
   * qurilma UUID lari.
   *
   * ⚠️ `jsonb` va BO'SH MASSIV sukut bo'yicha: `targetType = 'all'`
   * da ro'yxat kerak emas va `null` bo'lsa, har bir o'qigan joyda
   * `?? []` yozish kerak bo'lardi — bittasi esdan chiqsa, tarqatish
   * «hech kimga» yoki «hammaga» bo'lib ketardi.
   */
  @Column({ type: 'jsonb', name: 'target_ids', default: () => `'[]'::jsonb` })
  targetIds!: string[];

  /**
   * SINOV REJIMI — bir vaqtda ko'pi bilan shuncha qurilma yangilanadi.
   *
   * ⚠️⚠️ IKKI VAZIFASI BOR:
   *   1) `1` — «avval bitta qurilmada sinab ko'rish» (§9.3). Yaroqsiz
   *      proshivka butun viloyatni bir zumda halqaga solmaydi;
   *   2) kanalni himoya qilish — 1.9 MB × 200 qurilma bir vaqtda
   *      yuklab olsa, hosting ulanishi to'lib, telemetriya ham
   *      o'tmay qolardi.
   *
   * `null` — chegara yo'q.
   */
  @Column({ type: 'integer', name: 'max_devices', nullable: true })
  maxDevices!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy!: User | null;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}

/**
 * BLOKLASH — «bu versiyani bu qurilmaga boshqa bermaymiz».
 *
 * ⚠️⚠️ BUSIZ PARK «QAYTISH HALQASI» GA TUSHADI. Yaroqsiz proshivka:
 * yuklab oladi → o'rnatadi → tasdiqlanmaydi → bootloader eskisiga
 * qaytaradi → 30 daqiqadan keyin AYNI versiyani YANA yuklab oladi.
 * Cheksiz, va bu vaqtda qurilma harorat o'lchashdan ko'proq
 * yangilanish bilan band bo'ladi.
 *
 * ⚠️ Kalit `(deviceId, version)` — TARQATISH ID'si EMAS. Shu versiya
 * uchun yangi tarqatish yasalsa ham blok kuchda qoladi; aks holda
 * «qayta urinish» tugmasini bosmasdan, shunchaki yangi tarqatish
 * ochib, buzuq versiyani qaytarib bo'lardi.
 */
@Entity('firmware_blocks')
@Index('UQ_firmware_blocks_device_version', ['deviceId', 'version'], {
  unique: true,
})
export class FirmwareBlock extends BaseEntity {
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device!: Device;

  @Column({ type: 'varchar', length: 32 })
  version!: string;

  /**
   * Ketma-ket xatolar soni.
   *
   * ⚠️ MUVAFFAQIYATDA NOLGA QAYTARILADI: «ketma-ket 3 marta» (§9.4)
   * degani aynan ketma-ket. Umumiy hisob bo'lsa, oylar davomida
   * turli sabablarga ko'ra uch marta xato qilgan sog'lom qurilma
   * abadiy bloklanib qolardi.
   */
  @Column({ type: 'integer', name: 'fail_count', default: 0 })
  failCount!: number;

  /**
   * Blok KUCHDAMI.
   *
   * ⚠️ `failCount` dan ALOHIDA maydon: `rolled_back` kelsa, blok
   * BIRINCHI marta ham qo'yiladi (qaytish — eng og'ir dalil), xato
   * esa uch marta sanaladi. Bitta maydon bo'lsa, bu ikki qoidani
   * bitta sonda ifodalashga to'g'ri kelib, kod o'qilmas bo'lardi.
   */
  @Column({ type: 'boolean', name: 'is_blocked', default: false })
  isBlocked!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;
}

/**
 * OTA HODISASI — qurilma hisobotlari va server takliflari.
 *
 * ⚠️ FAQAT YOZILADI, o'zgartirilmaydi (append-only). Tarqatish
 * jarayoni ekrani shu jadvaldan HISOBLANADI, alohida «holat»
 * jadvali yuritilmaydi: ikkinchi joyda holat saqlansa, u hodisalar
 * bilan rost-yolg'on bo'lib ajralib ketardi va ekranda «o'rnatildi»,
 * tarixda esa «xato» turardi.
 */
@Entity('ota_events')
@Index('IDX_ota_events_device_time', ['deviceId', 'createdAt'])
@Index('IDX_ota_events_version_time', ['targetVersion', 'createdAt'])
export class OtaEvent extends BaseEntity {
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device!: Device;

  @Column({ type: 'enum', enum: OtaEventStatus })
  status!: OtaEventStatus;

  /** Qaysi versiyaga o'tilmoqda (`offered`, `installed` uchun). */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'target_version',
    nullable: true,
  })
  targetVersion!: string | null;

  /**
   * Hisobot yuborilgan paytda qurilmada ISHLAYOTGAN versiya.
   *
   * ⚠️ `rolled_back` da bu ESKI versiya bo'ladi (qurilma qaytib
   * ketgan) — `targetVersion` esa o'rnatilmagan yangisi. Ikkisini
   * bitta maydonda saqlash «nima bo'ldi?» degan savolni javobsiz
   * qoldirardi.
   */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'running_version',
    nullable: true,
  })
  runningVersion!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  message!: string | null;

  @Column({
    type: 'varchar',
    length: 45,
    name: 'ip_address',
    nullable: true,
  })
  ipAddress!: string | null;
}
