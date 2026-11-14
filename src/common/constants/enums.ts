/**
 * TIZIM ROLLARI.
 *
 * ⚠️ Ruxsat MATNDA emas, ROLDA saqlanmaydi: rol — faqat ruxsatlar to'plami
 * uchun YORLIQ (`permissions.ts`). Tekshiruv har doim ruxsat kaliti bo'yicha
 * boradi, aks holda yangi rol qo'shilganda har bir kontrollerni qayta ko'rib
 * chiqishga to'g'ri kelardi.
 */
export enum UserRole {
  /** Hamma narsa, shu jumladan foydalanuvchilar va sozlamalar. */
  SUPER_ADMIN = 'super_admin',
  /** Viloyat darajasi: barcha tumanlar, kotyol va qurilmalarni boshqaradi. */
  ADMIN = 'admin',
  /** TUMAN MAS'ULI: FAQAT o'z tumani ma'lumotlari (`districtId` bilan cheklangan). */
  OPERATOR = 'operator',
  /** Kuzatuvchi: faqat ko'radi, hech narsani o'zgartira olmaydi. */
  VIEWER = 'viewer',
}

/**
 * KOTYOL HOLATI — foydalanuvchi bergan qoida (chiqish harorati bo'yicha).
 *
 * ⚠️ Holat BAZADA saqlanadi (`boilers.current_status`), har so'rovda qayta
 * hisoblanmaydi. Sabab: xarita va dashboard 2000 ta kotyolni bir so'rovda
 * o'qiydi va har biri uchun oxirgi o'lchovni qidirish (window funksiya
 * bilan) sekundlarga cho'ziladi. Qiymat telemetriya kelganda VA holat
 * kuzatuvchisi (cron) ishlaganda yangilanadi — ikkalasi ham bitta
 * funksiyani chaqiradi (`resolveBoilerStatus`).
 */
export enum BoilerStatus {
  /** Chiqish harorati «faol» chegarasidan yuqori (sukut: ≥ 50 °C). */
  ACTIVE = 'active',
  /** «O'rta» chegara bilan «faol» orasida (sukut: 40–50 °C). */
  MEDIUM = 'medium',
  /** «Kritik» bilan «o'rta» orasida (sukut: 20–40 °C) — isitmayapti. */
  INACTIVE = 'inactive',
  /**
   * Aloqa yo'q YOKI harorat kritik chegaradan past (sukut: < 20 °C).
   *
   * ⚠️ «Sovuq» va «aloqa yo'q» BITTA holat: ikkalasida ham kotyol
   * ishlamayapti va dashboard'da ular bitta kartada sanaladi. Farqni
   * `lastReadingAt` ning bor-yo'qligi aytadi va u kotyol kartasida
   * alohida yoziladi.
   */
  OFFLINE = 'offline',
}

/**
 * O'LCHOVDA QAYSI DATCHIK QATNASHGANI.
 *
 * ⚠️⚠️ Bu maydon o'lchovda NIMA BORLIGINI aytadi, qaysi datchik
 * «asosiy» ekanini EMAS. ESP32 v2.0.0 da ikki DS18B20 bor:
 *   • kirish  (obratka) — qozonxonaga QAYTAYOTGAN suv, sovuqroq;
 *   • chiqish (podacha) — qozonxonadan CHIQAYOTGAN suv, issiqroq.
 *
 * ⚠️⚠️ Holat (`BoilerStatus`) FAQAT CHIQISH haroratidan hisoblanadi.
 * Agar chiqish datchigi nosoz bo'lsa (`INLET`), harorat NOMA'LUM
 * bo'ladi — kirish qiymatini chiqish o'rniga qo'yish eng xavfli xato
 * bo'lardi: obratka doim sovuqroq va butun viloyat «ishlamayotgan»
 * bo'lib ko'rinardi. Shuning uchun `INLET` o'lchovida chiqish
 * harorati `null` qoladi va «datchik nosoz» ogohlantirishi ochiladi.
 */
export enum ProbeKind {
  /** Ikkala datchik ham o'qildi — eng to'liq o'lchov. */
  BOTH = 'both',
  /** Faqat KIRISH o'qildi: chiqish harorati noma'lum. */
  INLET = 'inlet',
  /** Faqat CHIQISH o'qildi: holat hisoblanadi, delta esa noma'lum. */
  OUTLET = 'outlet',
  /**
   * Bitta harorat keldi, lekin qaysi quvurligi AYTILMAGAN.
   *
   * ⚠️ Eski proshivkalar (`modul1` va Xonobodning v1.x) `probe`
   * maydonini yubormaydi. Ular chiqish haroratini yuboradi, shuning
   * uchun qiymat chiqish sifatida qabul qilinadi — lekin bu
   * TAXMIN ekani shu holat bilan belgilanib turadi.
   */
  UNKNOWN = 'unknown',
}

/** Kotyol yoqilg'isi — hisobot kesimi uchun. */
export enum FuelType {
  GAS = 'gas',
  ELECTRIC = 'electric',
  COAL = 'coal',
  DIESEL = 'diesel',
  OTHER = 'other',
}

/** Ogohlantirish turi. */
export enum AlertType {
  /** Qurilmadan belgilangan muddat ichida signal kelmadi. */
  OFFLINE = 'offline',
  /** Harorat «o'rta» chegaradan pastga tushdi. */
  LOW_TEMPERATURE = 'low_temperature',
  /** Harorat kritik chegaradan pastga tushdi. */
  CRITICAL_TEMPERATURE = 'critical_temperature',
  /** Harorat normadan sezilarli yuqori — ortiqcha qizish. */
  OVERHEAT = 'overheat',
  /**
   * CHIQISH DATCHIGI QIYMAT BERMAYAPTI.
   *
   * ⚠️ Qurilma ishlayapti va signal yuborayapti, lekin chiqish
   * harorati yo'q (faqat kirish o'qilgan). Bu «aloqa yo'q» dan
   * TUBDAN boshqa muammo: tarmoqni tekshirish kerak emas, DATCHIKNI
   * almashtirish kerak. Ikkisi bitta turda bo'lsa, ta'mirchi
   * qozonxonaga borib, modemni qayta yoqib, sababni topmasdan
   * qaytardi.
   */
  SENSOR_FAULT = 'sensor_fault',
  /**
   * SUV AYLANMAYAPTI — kirish va chiqish harorati deyarli teng.
   *
   * ⚠️ Bu holat FAQAT ikki datchik bilan aniqlanadi va u eng
   * ayyor nosozlik: kotyol issiq, chiqish harorati me'yorda, holat
   * «faol» — lekin nasos to'xtagani yoki ventil yopiqligi uchun
   * issiqlik binoga BORMAYAPTI. Bitta datchik bilan bu muammoni
   * umuman ko'rib bo'lmasdi.
   */
  NO_CIRCULATION = 'no_circulation',
}

/**
 * TARQATISH (OTA rollout) HOLATI.
 *
 * ⚠️ `PAUSED` va `CANCELLED` ajratilgan: to'xtatilgan tarqatishni
 * davom ettirish mumkin, bekor qilingani esa tarixda qoladi. Bitta
 * holat bo'lsa, administrator «to'xtatdim» deb o'ylab, aslida
 * qaytarib bo'lmas qarorni qabul qilardi.
 */
export enum RolloutStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  /** Barcha maqsadli qurilmalar yangilandi. */
  DONE = 'done',
  CANCELLED = 'cancelled',
}

/**
 * TARQATISH MAQSADI.
 *
 * ⚠️ `DISTRICTS` — viloyat miqyosi uchun eng muhim kesim. Texnik
 * topshiriq Xonobod uchun «maktab/bog'cha» kesimini taklif qilgan;
 * 16 tumanli viloyatda esa yangi proshivkani avval BITTA TUMANDA
 * sinab ko'rish — eng tabiiy va eng xavfsiz bosqich.
 */
export enum RolloutTargetType {
  ALL = 'all',
  DISTRICTS = 'districts',
  OBJECT_TYPES = 'object_types',
  DEVICES = 'devices',
}

/**
 * OTA HODISASI.
 *
 * ⚠️ `OFFERED` dan boshqalarini QURILMA O'ZI xabar qiladi
 * (`POST {OTA_URL}?a=report`) — proshivkadagi nomlar bilan AYNI
 * yozilgan (`ota.cpp`: `installed|ok|failed|rolled_back`). Nomlar
 * o'zgartirilsa, qurilma yuborgan holat tanilmay, hodisa yo'qolardi.
 *
 * ⚠️ «Tekshirdi» hodisasi bu ro'yxatda YO'Q: qurilma har 30 daqiqada
 * so'raydi va uni yozish kuniga o'n minglab behuda qator berardi.
 * Tekshiruv izi `devices.last_check_at` da qoladi.
 */
export enum OtaEventStatus {
  /** Server bu qurilmaga yangilanishni taklif qildi. */
  OFFERED = 'offered',
  /** Yuklab oldi, SHA-256 mos keldi, qayta ishga tushmoqda. */
  INSTALLED = 'installed',
  /** Yangi proshivka ishlayapti va TASDIQLANDI. */
  OK = 'ok',
  /** Yuklash yoki yozish xatosi — qurilma eski versiyada qoldi. */
  FAILED = 'failed',
  /** Tasdiqlanmadi, bootloader eski proshivkaga qaytardi. */
  ROLLED_BACK = 'rolled_back',
}

export enum AlertSeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

export enum AlertState {
  /** Ochiq — muammo hali davom etmoqda. */
  OPEN = 'open',
  /** Operator ko'rdi, lekin muammo hali hal bo'lmagan. */
  ACKNOWLEDGED = 'acknowledged',
  /** Holat tiklandi — avtomatik yopilgan. */
  RESOLVED = 'resolved',
}

/** Audit jurnalidagi amal turi. */
export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LOGIN = 'login',
  LOGIN_FAILED = 'login_failed',
  LOGOUT = 'logout',
  EXPORT = 'export',
}

/**
 * ROL DARAJASI — huquq oshirishning oldini oladi.
 *
 * ⚠️⚠️ Foydalanuvchi O'ZIDAN YUQORI yoki O'ZIGA TENG rol bera olmaydi.
 * Busiz `users.create` huquqi bor administrator o'ziga yangi
 * `super_admin` yaratib, butun tizimni egallab olardi — ya'ni
 * ruxsatlarni mayda bo'laklarga bo'lishning butun ma'nosi yo'qolardi.
 *
 * ⚠️ Daraja ROL BILAN BIRGA shu yerda turadi: alohida faylda bo'lsa,
 * yangi rol qo'shgan dasturchi uni bu yerga qo'shishni unutib, yangi
 * rol jimgina «eng past daraja» bo'lib qolardi.
 */
export const ROLE_LEVEL: Record<UserRole, number> = {
  [UserRole.SUPER_ADMIN]: 40,
  [UserRole.ADMIN]: 30,
  [UserRole.OPERATOR]: 20,
  [UserRole.VIEWER]: 10,
};
