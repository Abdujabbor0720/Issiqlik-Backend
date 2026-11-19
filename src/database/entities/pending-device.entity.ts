import { Column, Entity, Index } from 'typeorm';
import type { DeviceType } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';

/**
 * RO'YXATDAN O'TMAGAN QURILMA — «yangi qurilma so'rayapti».
 *
 * ⚠️⚠️ NIMA UCHUN KERAK. Montajchi platani qozonxonaga o'rnatib,
 * Wi-Fi'ni sozlab ketadi; kabinetda esa uni ro'yxatga kiritish
 * esdan chiqishi mumkin. Qurilma har daqiqada serverga uriladi va
 * 403 oladi. Bu jadval bo'lmasa, uning signallari IZSIZ yo'qolardi
 * va «nega bu bino xaritada yo'q?» degan savolga javob topish uchun
 * server loglarini qidirishga to'g'ri kelardi.
 *
 * ⚠️⚠️ BU JADVAL AUTENTIFIKATSIYA EMAS. Bu yerga tushgan qurilma
 * HECH QANDAY ma'lumot yubora olmaydi: u faqat ro'yxatga olish
 * SO'ROVI. Administrator uni qo'lda tasdiqlab, kotyolga biriktirib,
 * token berishi kerak. Avtomatik qabul qilish («o'zi qo'shilsin»)
 * ataylab QILINMAGAN — aks holda istalgan odam o'z ESP32'sini
 * ulab, viloyat ma'lumotlariga soxta qozonxona qo'shib qo'yardi.
 */
@Entity('pending_devices')
@Index('UQ_pending_devices_device_id', ['deviceId'], { unique: true })
@Index('IDX_pending_devices_open', ['lastSeenAt'], {
  where: '"is_dismissed" = false',
})
export class PendingDevice extends BaseEntity {
  /** Qurilma aytgan identifikator — `esp32-<12 hex>` (STA MAC). */
  @Column({ type: 'varchar', length: 64, name: 'device_id' })
  deviceId!: string;

  /** Proshivkada tanlangan muassasa — montajchi qaysi binoni belgilagani. */
  @Column({
    type: 'varchar',
    length: 64,
    name: 'institution_hint',
    nullable: true,
  })
  institutionHint!: string | null;

  @Column({
    type: 'varchar',
    length: 40,
    name: 'firmware_version',
    nullable: true,
  })
  firmwareVersion!: string | null;

  /**
   * ⚠️ IP SAQLANADI, chunki aynan u «bu plata qaysi tumanda?» degan
   * savolga birinchi ishorani beradi — qurilma identifikatori esa
   * MAC'dan olingan va joy haqida hech narsa aytmaydi.
   */
  @Column({
    type: 'varchar',
    length: 45,
    name: 'last_ip_address',
    nullable: true,
  })
  lastIpAddress!: string | null;

  /**
   * Necha marta urinib ko'rgani.
   *
   * ⚠️⚠️ HAR SO'ROVDA YANGI QATOR YOZILMAYDI — `device_id` UNIQUE va
   * bu hisoblagich oshiriladi. Aks holda minutda bir marta so'rov
   * yuboruvchi bitta notanish qurilma kuniga 1440 qator yozib,
   * jadvalni suiiste'mol vositasiga aylantirardi: begona odam
   * tasodifiy identifikatorlar bilan uni cheksiz to'ldirib,
   * diskni to'ldirib qo'yishi mumkin bo'lardi.
   *
   * ⚠️ Shu bilan birga `attempts` ma'lumot ham beradi: 3 marta
   * urinib qolgan qurilma — ehtimol sinov; 2000 marta urinib
   * turgani esa dalada o'rnatilgan va kutib turgan plata.
   */
  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  /**
   * «Bu menga kerak emas» deb belgilangan.
   *
   * ⚠️ O'CHIRILMAYDI, belgilanadi: o'chirilsa, qurilma keyingi
   * so'rovda yana ro'yxatda paydo bo'lib, bildirishnoma abadiy
   * qaytib turardi. Begona yoki sinov platasi esa bir marta rad
   * etilgach, ko'rinmasligi kerak.
   */
  @Column({ type: 'boolean', name: 'is_dismissed', default: false })
  isDismissed!: boolean;

  /**
   * Qurilma turi — `X-Device-Type` sarlavhasidan, bo'lmasa tanadan
   * (`room_temperature_c` bor → `xona`, kotyol harorati bor → `kotyol`).
   */
  @Column({ type: 'varchar', length: 16, name: 'device_type', nullable: true })
  deviceType!: DeviceType | null;

  /** Plata aytgan tuman — FAQAT tanilgan kalit (`districts.key`). */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'reported_district',
    nullable: true,
  })
  reportedDistrict!: string | null;

  /** Plata aytgan obyekt turi — FAQAT katalogdagi kod (`school`). */
  @Column({
    type: 'varchar',
    length: 32,
    name: 'reported_object_type',
    nullable: true,
  })
  reportedObjectType!: string | null;

  /** Plata aytgan muassasa nomi (`institution_name`, erkin matn). */
  @Column({
    type: 'varchar',
    length: 120,
    name: 'reported_institution',
    nullable: true,
  })
  reportedInstitution!: string | null;

  /**
   * QURILMA YUBORGAN TOKENNING HASH'I — «bir bosishda ro'yxatga olish» uchun.
   *
   * ⚠️⚠️ Ro'yxatga olinganda shu hash qurilmaning shaxsiy kaliti bo'ladi:
   * dalada turgan plata o'z tokenini o'zgartirmasdan darhol ishlay boshlaydi.
   * Token O'ZI saqlanmaydi (SHA-256, `devices.api_key_hash` bilan AYNI).
   */
  @Column({ type: 'varchar', length: 64, name: 'token_hash', nullable: true })
  tokenHash!: string | null;

  @Column({
    type: 'varchar',
    length: 12,
    name: 'token_preview',
    nullable: true,
  })
  tokenPreview!: string | null;

  /** `shared` — umumiy `DEVICE_SHARED_TOKEN`; `personal` — boshqa har qanday token. */
  @Column({ type: 'varchar', length: 16, name: 'token_kind', nullable: true })
  tokenKind!: 'personal' | 'shared' | null;

  /**
   * ⚠️⚠️ BIR XIL `device_id` BILAN TURLI TOKEN KELGAN. Kimdir haqiqiy
   * platanining identifikatorini (MAC) o'g'irlab, o'z tokeni bilan so'rov
   * yuborayotgan bo'lishi mumkin. Bunday so'rov bir bosishda ro'yxatga
   * olinmaydi — kalit qo'lda kiritilishi kerak.
   */
  @Column({ type: 'boolean', name: 'token_conflict', default: false })
  tokenConflict!: boolean;
}
