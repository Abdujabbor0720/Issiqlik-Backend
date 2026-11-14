import { Column, Entity, Index } from 'typeorm';
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
}
