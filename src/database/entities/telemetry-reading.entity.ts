import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BoilerStatus, ProbeKind } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { Device } from './device.entity';
import { numericTransformer } from './column-transformers';

/**
 * TELEMETRIYA O'LCHOVI — ESP32 dan kelgan bitta signal.
 *
 * Bu jadval tizimdagi eng TEZ o'sadigan jadval: 2000 qurilma × har
 * 30 soniya = kuniga ~5.7 mln qator. Shuning uchun uning tuzilishi
 * boshqalardan boshqacha qoidalarga bo'ysunadi (pastga qarang).
 */
@Entity('telemetry_readings')
/*
 * ⚠️ ASOSIY INDEKS — `(boiler_id, recorded_at DESC)`.
 * Barcha so'rovlar bitta shaklda: «shu kotyolning oxirgi N o'lchovi» yoki
 * «shu kotyolning falon oraliqdagi o'lchovlari». Tartib DESC: grafik va
 * «oxirgi qiymat» so'rovi indeksning BOSHIDAN o'qiydi va saralash
 * bosqichi umuman bo'lmaydi.
 */
@Index('IDX_telemetry_boiler_time', ['boilerId', 'recordedAt'])
@Index('IDX_telemetry_device_time', ['deviceId', 'recordedAt'])
/*
 * ⚠️ `recordedAt` BO'YICHA ALOHIDA indeks — tozalash (retention) ishi
 * uchun. Usiz kunlik tozalash butun jadvalni skanerlardi.
 */
@Index('IDX_telemetry_recorded_at', ['recordedAt'])
/*
 * ⚠️⚠️ TAKRORLANISHDAN HIMOYA — qisman unique indeks.
 * Oflayn navbatdan kelgan o'lchov qayta yuborilishi KAFOLATLANGAN
 * (qurilma 2xx olmasa, ayni o'lchovni yana yuboradi). Shart
 * `measured_at IS NOT NULL`: oddiy o'lchovlarda bu maydon bo'sh va
 * ular uchun takror tushunchasi yo'q.
 * ⚠️ Entity'da ham E'LON QILINGAN: aks holda `migration:generate`
 * uni «yo'q» deb hisoblab, har safar qayta yasashga urinardi.
 */
@Index('UQ_telemetry_device_measured_at', ['deviceId', 'measuredAt'], {
  unique: true,
  where: '"measured_at" IS NOT NULL',
})
export class TelemetryReading extends BaseEntity {
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device!: Device;

  /**
   * ⚠️ `boilerId` SHU YERDA HAM saqlanadi (qurilma orqali olish mumkin
   * bo'lsa ham). Sabab: grafik so'rovi «shu kotyolning oxirgi 24 soati» —
   * `device` jadvaliga JOIN qilish million qatorli jadvalda indeksni
   * ishlatishga xalal berardi. Bundan tashqari qurilma BOSHQA kotyolga
   * ko'chirilishi mumkin va o'tgan o'lchovlar ESKI kotyolniki bo'lib
   * qolishi KERAK — aks holda tarix bir kechada boshqa obyektga
   * «ko'chib» ketardi.
   */
  @Column({ type: 'uuid', name: 'boiler_id', nullable: true })
  boilerId!: string | null;

  @ManyToOne(() => Boiler, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler | null;

  /**
   * CHIQISH HARORATI, °C — tizimdagi ASOSIY qiymat.
   *
   * ⚠️⚠️ USTUN NOMI VA MA'NOSI MUQADDAS: u doim QOZONXONADAN
   * CHIQAYOTGAN suv harorati. Undan holat formulasi
   * (`resolveBoilerStatus`), dashboard agregatlari, grafik, Excel
   * eksporti va ogohlantirish mexanizmi oziqlanadi.
   *
   * ⚠️⚠️ ILGARI bu «qurilma yuboradigan yagona o'lchov» edi; ESP32
   * v2.0.0 dan beri ikki datchik bor va qiymat `outletTemperature`
   * bilan AYNI. Nusxa ataylab saqlanadi: minglab qatorli jadvalda
   * barcha mavjud so'rov va indeks shu ustunga tayangan.
   *
   * ⚠️⚠️ BU YERGA KIRISH (obratka) HARORATINI YOZISH — eng xavfli
   * xato. Xonobod panelida aynan shunday (`worker.js:218`) va u
   * holatni ~20 °C pastga siljitadi. Chiqish datchigi nosoz bo'lsa,
   * qiymat `null` QOLADI — taxmin qilinmaydi.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    transformer: numericTransformer,
  })
  temperature!: number | null;

  /**
   * KIRISH (obratka) harorati, °C — tizimdan QAYTAYOTGAN suv.
   *
   * ⚠️ `null` bo'lishi normal: eski proshivka buni umuman yubormaydi
   * va kirish datchigi nosoz bo'lishi ham mumkin.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'inlet_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  inletTemperature!: number | null;

  /**
   * CHIQISH harorati, °C — `temperature` bilan AYNI qiymat.
   *
   * ⚠️ Ikkinchi nusxa BOR va bu ongli: `temperature` — tizimning
   * tarixiy, barcha so'rov tayangan ustuni; bu esa yangi,
   * ANIQ NOMLANGAN juftlik a'zosi (`inlet`/`outlet`). Yangi kod
   * juftlikni o'qiydi, eski kod esa buzilmaydi. Ikkisi HAR DOIM teng
   * bo'lishini telemetriya servisi kafolatlaydi — faqat bitta joyda
   * yoziladi.
   */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    name: 'outlet_temperature',
    nullable: true,
    transformer: numericTransformer,
  })
  outletTemperature!: number | null;

  /**
   * O'LCHOVDA QAYSI DATCHIK QATNASHGANI.
   *
   * ⚠️ Busiz yakka `inlet` va yakka `outlet` o'lchovi bir xil
   * ko'rinardi: ikkalasida ham bitta son keladi. Grafik esa ularni
   * TO'G'RI chiziqqa qo'yishi kerak (§9.6) — aks holda sovuq obratka
   * qiymati chiqish chizig'ini pastga tortib, «kotyol sovib qoldi»
   * degan yolg'on manzara yaratardi.
   */
  @Column({
    type: 'enum',
    enum: ProbeKind,
    default: ProbeKind.UNKNOWN,
  })
  probe!: ProbeKind;

  /**
   * QURILMA AYTGAN O'LCHOV VAQTI (oflayn navbatdan kelgan o'lchovlar).
   *
   * ⚠️⚠️ `recordedAt` BILAN ARALASHTIRMANG. `recordedAt` — o'lchov
   * grafikda QAYSI NUQTAGA tushadi; bu maydon esa qurilma yuborgan
   * XOM da'vo va u faqat oflayn navbat yoqilganda keladi.
   *
   * ⚠️ Mavjudligi TAKRORLANISHDAN HIMOYA kaliti: qurilma 2xx javobini
   * olmasa, AYNI o'lchovni qayta yuboradi (`main.cpp` dagi
   * `queueFlush`). `(device_id, measured_at)` bo'yicha qisman unique
   * indeks ikkinchi nusxani bazaga kiritmaydi.
   *
   * ⚠️ `null` — oddiy, real vaqtdagi o'lchov. Bunday o'lchovlar uchun
   * takror tushunchasi yo'q va indeks ularga TEGMAYDI.
   */
  @Column({ type: 'timestamptz', name: 'measured_at', nullable: true })
  measuredAt!: Date | null;

  /**
   * O'LCHOV PAYTIDAGI HOLAT — o'sha lahzada muhrlanadi.
   *
   * ⚠️ Keyin chegaralar sozlamadan o'zgartirilsa, O'TGAN o'lchovlar
   * qayta baholanmaydi: «o'tgan hafta 40 ta kotyol faol edi» degan
   * hisobot chegara o'zgarishi bilan jimgina boshqa raqam ko'rsatib
   * qolmasligi kerak.
   */
  @Column({ type: 'enum', enum: BoilerStatus, nullable: true })
  status!: BoilerStatus | null;

  /**
   * O'lchov QACHON olingan (qurilma vaqti yoki server qabul vaqti).
   *
   * ⚠️ ESP32 da real-time soat YO'Q va u ko'pincha vaqtni bilmaydi.
   * Shuning uchun qurilma vaqt yubormasa — SERVER vaqti yoziladi
   * (`telemetry.service.ts`). Teskarisi — qurilma vaqtiga ko'r-ko'rona
   * ishonish — 1970-yildagi o'lchovlar bilan grafikni buzardi.
   */
  @Column({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;

  /**
   * XOM YUK — qurilma yuborgan hamma narsa.
   *
   * ⚠️ Bugun faqat harorat keladi, ertaga bosim yoki xato kodi
   * qo'shilishi mumkin. Xom yuk saqlanmasa, yangi maydon qo'shilgan
   * kundan OLDINGI ma'lumot abadiy yo'qolardi: proshivka allaqachon
   * yuborgan, server esa tashlab yuborgan bo'lardi.
   */
  @Column({ type: 'jsonb', name: 'raw_payload', nullable: true })
  rawPayload!: Record<string, unknown> | null;
}
