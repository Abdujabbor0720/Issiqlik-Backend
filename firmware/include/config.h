#pragma once

// ---- Proshivka versiyasi ----
// Har bir yangi reliz (OTA) oldidan oshiring. Dashboardga yuklanganda versiya .bin ichidan o'qiladi.
#define FW_VERSION "2.1.0"

// ---- Server (Andijon viloyati issiqlik monitoringi paneli) ----
// Manzil faqat proshivkada turadi: telefondagi sozlash sahifasidan o'zgartirib bo'lmaydi (token o'g'irlanmasligi uchun).
//
// DIQQAT: SERVER_HOST ni o'zgartirsangiz, HAR BIR qurilmani qaytadan proshivka
// qilish kerak bo'ladi. net.cpp dagi isOwnServerUrl() faqat shu domenga ruxsat
// beradi va boshqa manzilga token UMUMAN yuborilmaydi.
//
// DIQQAT: faqat HTTPS va faqat Let's Encrypt sertifikati (root_ca.h).
// Cloudflare yoki boshqa CA orqali o'tkazilsa, qurilmalar ULANMAYDI.
#define SERVER_HOST     "issiqlik.andijon.uz"

// Yo'llar AYNI qoldirildi: ular serverda ham, bu yerda ham qotirilgan.
// `/index.php/` bo'lagi tarixiy (PHP hostingi izi), lekin server uni ham,
// prefikssiz nusxani ham qabul qiladi -- shuning uchun o'zgartirish kerak emas.
#define SERVER_URL      "https://" SERVER_HOST "/index.php/api/integrations/telemetry"
#define OTA_URL         "https://" SERVER_HOST "/ota/index.php"

// ---- Muassasa ----
// DIQQAT: v2.1.0 dan boshlab bu maydon MA'LUMOT UCHUN, ya'ni serverda
// ma'lumotni yo'naltirish uchun ISHLATILMAYDI. Server kotyolni device_id
// orqali o'zi aniqlaydi (qurilmalar jadvalidan). Shu sababli:
//   * qotirilgan muassasa ro'yxati OLIB TASHLANDI -- viloyatda yuzlab obyekt
//     bor va ularni proshivkaga sig'dirib bo'lmaydi;
//   * bo'sh bo'lsa ham qurilma ma'lumot YUBORADI (v2.0.0 da yubormasdi).
// Montajchi xohlasa, erkin matn yozib qoldiradi ("12-maktab") -- u kabinetda
// ko'rinadi va qurilma qaysi binoga o'rnatilganini aniqlashga yordam beradi.
#define INSTITUTION_ID  ""

// ---- Pinlar ----
// Kirish  = obratka: tizimdan qozonxonaga QAYTIB kelayotgan suv (sovuqroq)  -> inlet_temperature_c
// Chiqish = qozonxonadan CHIQAYOTGAN issiq suv (podacha, issiqroq)          -> outlet_temperature_c
// Har bir DS18B20 DATA simi 4.7 kOm pull-up orqali 3.3V ga ulanadi.
#define INLET_PIN   4     // kirish (obratka) datchigi
#define OUTLET_PIN  5     // chiqish (qozonxonadan chiqish) datchigi
#define I2C_SDA     21    // LCD (ixtiyoriy)
#define I2C_SCL     22
#define LCD_ADDR    0x27  // 16x2 I2C LCD; topilmasa e'tiborsiz qoldiriladi

// ---- Vaqtlar (ms) ----
#define MEASURE_INTERVAL_MS  5000UL     // har 5 soniyada o'lchash, LCD va serial'ga [DATA] JSON
#define SEND_INTERVAL_MS     60000UL    // har 60 soniyada internet orqali serverga yuborish
#define FIRST_SEND_DELAY_MS  20000UL    // ishga tushgandan keyin birinchi yuborish (proshivka skriptiga vaqt qoladi)
#define WIFI_RETRY_MS        30000UL    // Wi-Fi uzilsa qayta urinish oralig'i (ulanish jarayonini bo'lmaslik uchun)
#define WIFI_REBOOT_AFTER_MS 3600000UL  // 1 soat ulanmasa qayta ishga tushish (Wi-Fi stekini tiklash)
#define HTTP_TIMEOUT_MS      10000

// ---- Oflayn navbat ----
// 1: Wi-Fi/server yo'q paytdagi o'lchovlar xotirada saqlanadi va keyin "measured_at" (UTC, ISO 8601) bilan yuboriladi.
// DIQQAT: panel "measured_at" maydonini qabul qilib, o'lchov vaqti sifatida saqlamaguncha 0 qoldiring,
// aks holda kechikkan o'lchovlar yuborilgan paytdagi vaqt bilan yoziladi.
#define OFFLINE_QUEUE_ENABLED 0
#define OFFLINE_QUEUE_SIZE    180       // 3 soatlik o'lchov (60 s da bitta)
#define OFFLINE_SEND_PER_CYCLE 10       // bir yuborishda navbatdan nechta
#define NTP_SERVER1 "pool.ntp.org"
#define NTP_SERVER2 "time.google.com"

// ---- Masofadan yangilash (OTA) ----
#define OTA_CHECK_FIRST_MS      60000UL    // Wi-Fi ulangandan 1 daqiqa keyin birinchi tekshiruv
#define OTA_CHECK_INTERVAL_MS   1800000UL  // keyin har 30 daqiqada (dashboardda tarqatish boshlansa shu vaqt ichida oladi)
#define OTA_RETRY_MS            600000UL   // tekshiruv xato bo'lsa 10 daqiqadan keyin
// Yangi proshivka serverga muvaffaqiyatli yubora olmasa, eskisiga avtomatik qaytadi:
#define OTA_CONFIRM_ONLINE_MS   600000UL   // Wi-Fi ulangan holda 10 daqiqa ichida, yoki
#define OTA_CONFIRM_TOTAL_MS    3600000UL  // umuman 1 soat ichida

// ---- Telefondan sozlash rejimi ----
// Kirish: Wi-Fi tugmasini (GPIO2) 5 soniya bosib turish, BOOT tugmasini 3 soniya bosib turish, serial'da 'w',
// yoki xotirada Wi-Fi umuman yo'q bo'lsa. Wi-Fi uzilganda o'zi YOQILMAYDI (begona odam ulanib olmasligi uchun).
// Sozlash rejimida Wi-Fi tugmasi yana 5 soniya bosib turilsa - bekor.
#define WIFI_BUTTON_PIN      2              // eski proshivkada "Button Check (Pin 2)"; platada tekshirildi
#define WIFI_BUTTON_ACTIVE   HIGH           // bo'sh holatda LOW, bosilganda 3.3V
#define WIFI_BUTTON_HOLD_MS  5000UL         // shuncha bosib turilsa Wi-Fi sozlash rejimi (sozlashda - bekor)
#define SETUP_AP_SSID        "Harorat-Sozlash"
// AP paroli har bir platada alohida (8 raqam), birinchi ishga tushganda yaratiladi va xotirada saqlanadi.
// LCD'da, serial 'i' buyrug'ida ko'rinadi va proshivka skripti tools/qurilmalar.csv ga yozib qo'yadi.
#define SETUP_BUTTON_PIN     0              // BOOT tugmasi
#define SETUP_TIMEOUT_MS     600000UL       // 10 daqiqada sozlanmasa qayta ishga tushadi
