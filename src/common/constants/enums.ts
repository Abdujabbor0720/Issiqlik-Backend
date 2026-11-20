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
  /**
   * TASHKILOT (BOSHQARMA) MAS'ULI — FAQAT o'z tashkilotiga qarashli
   * muassasalarning XAVF hodisalari (`agencyId` bilan cheklangan).
   *
   * ⚠️⚠️ Tuman bo'yicha EMAS: «Maktabgacha ta'lim boshqarmasi» mas'uli
   * 16 tumandagi bog'chalarni ko'radi, lekin o'sha tumanlardagi
   * shifoxonalarni ko'rmaydi. Shuning uchun u `districtId` bilan emas,
   * `agencyId` bilan cheklanadi va eski (tuman kesimidagi) endpointlarga
   * umuman kira olmaydi (`scope.helper.ts` — yopiq holatda ishlaydi).
   */
  AGENCY_OFFICER = 'agency_officer',
  /**
   * OBYEKT JAVOBGARI — muassasaga biriktirilgan shaxs (direktor, xo'jalik
   * mudiri, isitish texnigi) o'z paneli bilan.
   *
   * ⚠️ Ko'rish chegarasi — FAQAT o'zi biriktirilgan obyektlar
   * (`responsible_assignments` orqali, `responsible_persons.user_id`).
   * Hodisani qabul qiladi va chora yozadi, lekin YOPMAYDI: «tekshirilgan
   * holda yakunlash» yuqori mas'ulning qarori.
   */
  RESPONSIBLE = 'responsible',
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
   * ⚠️ Eski proshivkalar (`modul1` va birinchi avlod v1.x) `probe`
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
  /**
   * XONA SOVUQ — havo harorati sozlamadagi minimumdan past.
   *
   * ⚠️⚠️ BU KOTYOL HOLATI EMAS, XONA HOLATI. Kotyol 70 °C bersa ham
   * radiatori yorilgan yoki derazasi sinib yotgan sinfxona sovuq
   * bo'ladi. Shuning uchun xona ogohlantirishlari kotyol
   * ogohlantirishlaridan ALOHIDA yashaydi (`alerts.room_id`): biri
   * ikkinchisini YOPMAYDI. Aks holda «kotyol sovuq» ochilganda «1-sinf
   * sovuq» jimgina yopilib, eng muhim xabar yo'qolardi.
   */
  ROOM_COLD = 'room_cold',
}

/**
 * Xona ogohlantirishi turlari — kotyol ogohlantirishlaridan AJRATISH uchun.
 *
 * ⚠️ Kotyol ogohlantirishlari BIR-BIRINI almashtiradi (bitta kotyolda
 * bir vaqtda bitta muammo), xona ogohlantirishlari esa HAR XONADA
 * mustaqil. Ikki to'plam aralashsa, `resolveOpen` bir xonaning
 * xabarini boshqa turdagi kotyol xabari bilan yopib yuborardi.
 *
 * ⚠️ «Xona issiq» turi ATAYLAB YO'Q: talab faqat me'yor va minimum.
 * So'ralmagan ogohlantirish (qozonxona xonasidagi 35 °C datchik)
 * shovqin bo'lib, haqiqiy «sovuq» xabarlarini ko'mib yuborardi.
 */
export const ROOM_ALERT_TYPES: readonly AlertType[] = [AlertType.ROOM_COLD];

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
 * ESP32 MODULI TURI — qaysi apparat va qaysi proshivka oilasi.
 *
 * ⚠️⚠️ QIYMATLAR QURILMA KONTRAKTIDA QOTIRILGAN: `X-Device-Type: kotyol|xona`
 * sarlavhasi, OTA'dagi `type=kotyol|xona` parametri va `.bin` ichidagi
 * `ANDIJON_FW_MODULE=kotyol;` belgisi aynan shu so'zlar bilan keladi.
 * Bazada (`devices.device_type`, `firmware_releases.device_type`) ham
 * shu qiymatlar turadi — tarjima jadvali yo'q, demak adashish ham yo'q.
 *
 * ⚠️⚠️ OTA XAVFSIZLIGINING ASOSI. Kotyol `.bin` xona platasiga (yoki
 * aksincha) yozilsa, plata datchiksiz qoladi va uni faqat qo'lda, USB
 * bilan tiklash mumkin. Shuning uchun relizning turi `.bin` ICHIDAGI
 * belgidan, qurilmaniki esa uning O'Z signalidan olinadi va OTA faqat
 * bir xil tur orasida ishlaydi.
 *
 *   • `kotyol` — qozonxona moduli (2× DS18B20, suv harorati, v2.x).
 *   • `xona`   — xona harorati moduli (havo harorati, v1.x).
 */
export enum DeviceType {
  KOTYOL = 'kotyol',
  XONA = 'xona',
}

/**
 * TARQATISH MAQSADI.
 *
 * ⚠️ `DISTRICTS` — viloyat miqyosi uchun eng muhim kesim. Texnik
 * topshiriq dastlab bitta tuman uchun «maktab/bog'cha» kesimini taklif qilgan;
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
  /** XAVF bo'yicha mas'ullarga ogohlantirish yuborildi. */
  NOTIFY = 'notify',
  /** XAVF yuqori vakolatli mas'ulga ko'tarildi. */
  ESCALATE = 'escalate',
  /** XAVF holati o'zgardi (qabul qilindi, chora, bartaraf, yopildi). */
  STATUS_CHANGE = 'status_change',
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
  /*
   * ⚠️ Tashkilot mas'uli tuman mas'uli bilan BIR darajada: ikkalasi ham
   * o'z kesimining rahbari. Administrator (30) ikkalasini ham yarata
   * oladi, ular esa bir-birining hisobiga tega olmaydi.
   */
  [UserRole.AGENCY_OFFICER]: 20,
  [UserRole.RESPONSIBLE]: 15,
  [UserRole.VIEWER]: 10,
};

// ════════════════════════ XAVF (INCIDENT) ════════════════════════

/**
 * XAVF TURI — mas'ul uchun MA'NO bo'yicha guruhlangan.
 *
 * ⚠️⚠️ `AlertType` bilan 1:1 EMAS va bu ataylab. Ogohlantirish — texnik
 * signal (bitta kotyolda «o'rta» → «kritik» o'tishi eski qatorni yopib,
 * yangisini ochadi). XAVF esa mas'ulning ish varag'i: kotyol 45 °C dan
 * 25 °C ga sovisa bu BITTA muammo va mas'ulning izohlari, qabul qilgani,
 * eskalatsiya tarixi bitta hodisada qolishi kerak. 1:1 bo'lsa, har
 * o'tishda yangi «XAVF» paydo bo'lib, qilingan ish yo'qolardi.
 */
export enum IncidentKind {
  /** Xona havosi belgilangan minimumdan past — asosiy XAVF. */
  ROOM_LOW_TEMPERATURE = 'room_low_temperature',
  /** Kotyol chiqish harorati me'yordan past (isitmayapti). */
  BOILER_LOW_TEMPERATURE = 'boiler_low_temperature',
  /** Qurilmadan signal kelmayapti (kotyol yoki xona moduli). */
  DEVICE_OFFLINE = 'device_offline',
  /** Datchik qiymat bermayapti. */
  SENSOR_FAULT = 'sensor_fault',
  /** Ortiqcha qizish — texnik xavfsizlik. */
  OVERHEAT = 'overheat',
  /** Suv aylanmayapti — texnik xavfsizlik. */
  NO_CIRCULATION = 'no_circulation',
}

/**
 * XAVF HOLATI — mas'ul jarayonining bosqichlari.
 *
 * ⚠️ `RESOLVED` va `CLOSED` AJRATILGAN: «bartaraf etildi» — mas'ulning
 * (yoki harorat tiklanganda tizimning) DA'VOSI, «yopildi» — yuqori
 * mas'ul uni TEKSHIRGANI. Bitta holat bo'lsa, javobgar o'z ishini o'zi
 * qabul qilib qo'ygan bo'lardi.
 */
export enum IncidentStatus {
  NEW = 'new',
  ACKNOWLEDGED = 'acknowledged',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

/** Faol (hali bartaraf etilmagan) holatlar — dublikat qo'riqchisi shular bo'yicha. */
export const ACTIVE_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  IncidentStatus.NEW,
  IncidentStatus.ACKNOWLEDGED,
  IncidentStatus.IN_PROGRESS,
];

/** Javobgarlik turi — bitta obyektda bir nechta javobgar bo'lishi mumkin. */
export enum ResponsibilityType {
  /** Muassasa rahbari (direktor, mudira, bosh shifokor). */
  DIRECTOR = 'director',
  /** Xo'jalik ishlari bo'yicha mas'ul. */
  FACILITIES = 'facilities',
  /** Isitish tizimi bo'yicha texnik mas'ul. */
  HEATING_TECHNICIAN = 'heating_technician',
  OTHER = 'other',
}

/** Monitoring jadvali rejimi. */
export enum ScheduleMode {
  /** 24/7 — tibbiyot birlashmalari va uzluksiz isitiladigan obyektlar. */
  ALWAYS = 'always',
  /** Hafta kunlari va soatlar bo'yicha. */
  SCHEDULE = 'schedule',
}

/**
 * JADVAL QAYERGA TEGISHLI — ustuvorlik tartibida (kuchlisi yuqorida):
 * `boiler` → `organization` → `object_type` → `global`.
 */
export enum ScheduleScope {
  BOILER = 'boiler',
  ORGANIZATION = 'organization',
  OBJECT_TYPE = 'object_type',
  GLOBAL = 'global',
}

/** Eskalatsiya sharti. */
export enum EscalationCondition {
  /** Belgilangan vaqtda hech kim QABUL QILMADI (holat hamon `new`). */
  NOT_ACKNOWLEDGED = 'not_acknowledged',
  /** Belgilangan vaqtda bartaraf ETILMADI (holat hamon faol). */
  NOT_RESOLVED = 'not_resolved',
}

/** Kimga ogohlantirish boradi. */
export enum NotifyAudience {
  /** Obyektga biriktirilgan javobgar shaxs(lar)ning hisobi. */
  RESPONSIBLE = 'responsible',
  /** Tuman mas'ullari (`operator`). */
  DISTRICT = 'district',
  /** Tashkilot / boshqarma mas'ullari (`agency_officer`). */
  AGENCY = 'agency',
  /** Viloyat mas'ullari (`admin`, `super_admin`). */
  REGION = 'region',
}

/** XAVF tarixidagi yozuv turi. */
export enum IncidentEventType {
  CREATED = 'created',
  NOTIFIED = 'notified',
  STATUS_CHANGED = 'status_changed',
  COMMENT = 'comment',
  ACTION = 'action',
  SEVERITY_RAISED = 'severity_raised',
  AUTO_RESOLVED = 'auto_resolved',
  REOPENED = 'reopened',
  ESCALATED = 'escalated',
}
