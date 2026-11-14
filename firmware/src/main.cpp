// ESP32 + 2x DS18B20 (kirish/chiqish) -> HTTPS POST (JSON) -> Xonobod issiqlik monitoringi paneli
// Serial buyruqlar (115200): i - holat, m - hozir o'lchab yuborish, s - datchiklarni qayta qidirish,
//   w - telefondan sozlash rejimi, n - Wi-Fi tarmoqlari, o - barcha pinlarda DS18B20 qidirish, p - pinlarni kuzatish,
//   u - yangilanishni hozir tekshirish, r - qayta ishga tushirish,
//   I<muassasa> - muassasani yozish, W<ssid>\t<parol> - Wi-Fi'ni yozish, T<token> - shaxsiy token (bo'sh - umumiy)

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <time.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

#include "app.h"
#include "config.h"
#include "secrets.h"

// v2.1.0: qotirilgan muassasa ro'yxati OLIB TASHLANDI.
// Sabab: Andijon viloyatida 16 tuman va yuzlab obyekt bor -- ularni proshivkaga
// sig'dirib bo'lmaydi va yangi bino qo'shilganda butun parkni qaytadan
// proshivka qilishga to'g'ri kelardi. Server kotyolni device_id orqali o'zi
// aniqlaydi, bu maydon esa faqat MA'LUMOT (montajchi izohi).
#define INSTITUTION_MAX_LEN 64

// Ichki holat kodlari (HTTPClient xato kodlari -1..-11 bilan to'qnashmaydi)
enum : int {
  ST_NONE = 0,
  ST_NO_DATA = -101,  // ikkala datchik ham o'qilmadi
  ST_NO_WIFI = -102,
  ST_NO_INST = -103,  // v2.1.0 dan ishlatilmaydi (muassasa majburiy emas)
  ST_BAD_URL = -104,
};

// Har bir quvur uchun alohida 1-Wire shina.
// Kirish = obratka (qozonxonaga qaytayotgan suv), Chiqish = qozonxonadan chiqayotgan issiq suv.
struct Probe {
  const char *name;
  const char *key;  // JSON'dagi nomi: inlet / outlet
  uint8_t pin;
  OneWire bus;
  DallasTemperature ds;
  DeviceAddress addr;
  bool found;
  float temp;
  float lastGood;   // oxirgi to'g'ri o'lchov (85 °C tekshiruvi uchun)
  Probe(const char *n, const char *k, uint8_t p)
      : name(n), key(k), pin(p), bus(p), ds(&bus), found(false), temp(NAN), lastGood(NAN) {}
};
static Probe inlet("Kirish", "inlet", INLET_PIN);
static Probe outlet("Chiqish", "outlet", OUTLET_PIN);
static Probe *const probes[] = {&inlet, &outlet};

static LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
static WebServer web(80);
static DNSServer dns;

Preferences prefs;
String deviceId;
String deviceToken;
String institutionId;

static bool lcdOk = false;
static String apPass;
static unsigned long lastSend = 0;
static unsigned long lastWifiTry = 0;
static unsigned long lastConnectedAt = 0;
static int lastHttpCode = ST_NONE;
static bool wasConnected = false;
static bool ntpStarted = false;

static bool setupMode = false;
static unsigned long setupStarted = 0;
static unsigned long restartAt = 0;
static unsigned long btnDownAt = 0;

// ---------------------------------------------------------------- yordamchi

static String addrToStr(const DeviceAddress a) {
  char buf[17];
  for (int i = 0; i < 8; i++) snprintf(buf + i * 2, 3, "%02X", a[i]);
  return String(buf);
}

static String htmlEscape(const String &s) {
  String o;
  o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    switch (c) {
      case '&': o += "&amp;"; break;
      case '<': o += "&lt;"; break;
      case '>': o += "&gt;"; break;
      case '"': o += "&quot;"; break;
      case '\'': o += "&#39;"; break;
      default: o += c;
    }
  }
  return o;
}

// Muassasa izohi: BO'SH bo'lishi mumkin, uzunligi va belgilari cheklangan.
// DIQQAT: bu qiymat serverga JSON ichida yuboriladi, shuning uchun qo'shtirnoq,
// teskari slash va boshqaruv belgilari TAQIQLANADI -- aks holda yuk buzilardi
// (jsonEscape bor, lekin ikki qavat himoya arzon).
static bool validInstitution(const String &id) {
  if (id.length() > INSTITUTION_MAX_LEN) return false;
  for (size_t i = 0; i < id.length(); i++) {
    char c = id[i];
    bool ok = isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == ' ';
    if (!ok) return false;
  }
  return true;  // bo'sh satr ham yaroqli
}

static bool validToken(const String &t) {
  if (t.length() < 16 || t.length() > 128) return false;
  for (size_t i = 0; i < t.length(); i++) {
    char c = t[i];
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return false;
  }
  return true;
}

void lcdShow(const String &l1, const String &l2) {
  if (!lcdOk) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(l1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(l2.substring(0, 16));
}

static uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;  // NTP sinxronlanmagan bo'lsa 0
}

// ---------------------------------------------------------------- datchiklar

static void scanSensors() {
  for (Probe *p : probes) {
    p->ds.begin();
    p->found = p->ds.getDeviceCount() > 0 && p->ds.getAddress(p->addr, 0);
    if (p->found) {
      p->ds.setResolution(p->addr, 12);
      Serial.printf("[SENSOR] %s: GPIO%u %s\n", p->name, p->pin, addrToStr(p->addr).c_str());
    } else {
      Serial.printf("[SENSOR] %s: GPIO%u da datchik topilmadi\n", p->name, p->pin);
    }
  }
}

static float readOnce(Probe *p) {
  p->ds.requestTemperaturesByAddress(p->addr);
  return p->ds.getTempC(p->addr);
}

static void readSensors(bool verbose = true) {
  for (Probe *p : probes) {
    p->temp = NAN;
    if (!p->found) continue;
    float t = readOnce(p);
    // 85.0 - DS18B20 yoqilgandagi (o'lchanmagan) qiymat. Lekin qozondan chiqqan suv haqiqatan 85 °C bo'lishi mumkin:
    // oldingi o'lchov 80..90 oralig'ida bo'lsa qabul qilamiz, aks holda bir marta qayta o'lchaymiz.
    if (t == 85.0f && !(p->lastGood > 80.0f && p->lastGood < 90.0f)) {
      t = readOnce(p);
      if (t == 85.0f) t = DEVICE_DISCONNECTED_C;
    }
    if (t != DEVICE_DISCONNECTED_C && t >= -55 && t <= 125) {
      p->temp = t;
      p->lastGood = t;
    }
    if (!verbose) continue;
    if (isnan(p->temp)) Serial.printf("[SENSOR] %s o'qilmadi\n", p->name);
    else Serial.printf("[SENSOR] %s: %.2f C\n", p->name, p->temp);
  }
}

// ---------------------------------------------------------------- Wi-Fi

// secrets.h to'ldirilmagan bo'lsa, plata xotirasida (NVS) saqlangan Wi-Fi ishlatiladi
static bool useSavedWifi() {
  return strlen(WIFI_SSID) == 0 || strcmp(WIFI_SSID, "WiFi_nomi") == 0;
}

static bool hasSavedWifi(String *ssidOut = nullptr) {
  wifi_config_t conf = {};
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK || conf.sta.ssid[0] == 0) return false;
  if (ssidOut) {
    char s[33] = {0};
    memcpy(s, conf.sta.ssid, 32);  // 32 belgili SSID nol bilan tugamasligi mumkin
    *ssidOut = String(s);
  }
  return true;
}

static void enterSetupMode(const char *why);

static void startWifi() {
  lastWifiTry = millis();
  if (useSavedWifi()) {
    String ssid;
    if (!hasSavedWifi(&ssid)) {
      // Faqat shu holatda sozlash rejimi o'zi yoqiladi: Wi-Fi umuman sozlanmagan
      enterSetupMode("Wi-Fi sozlanmagan");
      return;
    }
    Serial.printf("[WIFI] Saqlangan '%s' ga ulanish...\n", ssid.c_str());
    WiFi.disconnect(false, false);  // saqlangan sozlamani o'chirmaydi
    WiFi.begin();
  } else {
    Serial.printf("[WIFI] '%s' ga ulanish...\n", WIFI_SSID);
    WiFi.disconnect(false, false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

static void handleWifi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    Serial.printf("[WIFI] Ulandi. IP: %s, RSSI: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!ntpStarted) {
      configTime(0, 0, NTP_SERVER1, NTP_SERVER2);  // UTC; SNTP keyin o'zi yangilab turadi
      ntpStarted = true;
    }
  } else if (!connected && wasConnected) {
    Serial.println("[WIFI] Aloqa uzildi");
  }
  wasConnected = connected;

  if (connected) {
    lastConnectedAt = millis();
    return;
  }
  // Wi-Fi uzoq vaqt yo'q: sozlash rejimiga O'TMAYMIZ (begona odam AP'ga ulanib olmasin), faqat qayta urinamiz
  if (millis() - lastConnectedAt >= WIFI_REBOOT_AFTER_MS) {
    Serial.println("[WIFI] 1 soatdan beri ulanmadi, qayta ishga tushirilmoqda");
    delay(200);
    ESP.restart();
  }
  // Ulanish jarayonida (WL_IDLE/WL_DISCONNECTED) bo'lmaslik uchun oraliq 30 s; autoReconnect ham ishlaydi
  if (millis() - lastWifiTry >= WIFI_RETRY_MS) startWifi();
}

// ---------------------------------------------------------------- yuborish

struct Reading {
  uint32_t ts;  // UTC epoch, 0 - noma'lum
  float in;
  float out;
};

static String buildJson(const Reading &r, bool withTime) {
  String body = "{\"institution_id\":\"" + institutionId + "\",\"device_id\":\"" + deviceId + "\"";
  bool hasIn = !isnan(r.in), hasOut = !isnan(r.out);
  if (hasIn && hasOut) {
    body += ",\"inlet_temperature_c\":" + String(r.in, 2);
    body += ",\"outlet_temperature_c\":" + String(r.out, 2);
  } else {
    // panel juftlikni faqat ikkalasi bo'lsa qabul qiladi; bittasi bo'lsa umumiy harorat sifatida yuboramiz,
    // "probe" esa qaysi datchik ekanini bildiradi (obratka va podacha aralashib ketmasligi uchun)
    body += ",\"temperature_c\":" + String(hasIn ? r.in : r.out, 2);
    body += String(",\"probe\":\"") + (hasIn ? inlet.key : outlet.key) + "\"";
  }
  if (withTime && r.ts) {
    char iso[24];
    time_t t = r.ts;
    struct tm tmv;
    gmtime_r(&t, &tmv);
    strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    body += String(",\"measured_at\":\"") + iso + "\"";
  }
  body += "}";
  return body;
}

static int postReading(const Reading &r, bool withTime) {
  NetworkClientSecure tls;
  HTTPClient http;
  if (!httpsBegin(http, tls, SERVER_URL, HTTP_TIMEOUT_MS)) {
    Serial.printf("[HTTP] URL noto'g'ri: %s\n", SERVER_URL);
    return ST_BAD_URL;
  }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(buildJson(r, withTime));
  String resp = code > 0 ? http.getString() : String();
  http.end();

  if (code >= 200 && code < 300) {
    Serial.printf("[HTTP] Yuborildi (%d)\n", code);
  } else if (code > 0) {
    Serial.printf("[HTTP] Server javobi %d: %s\n", code, resp.substring(0, 160).c_str());
  } else {
    Serial.printf("[HTTP] Xato %d: %s\n", code, HTTPClient::errorToString(code).c_str());
  }
  otaTelemetryResult(code);
  return code;
}

// ---- Oflayn navbat (OFFLINE_QUEUE_ENABLED=1 bo'lsa)
static Reading queueBuf[OFFLINE_QUEUE_ENABLED ? OFFLINE_QUEUE_SIZE : 1];
static const size_t QUEUE_CAP = sizeof(queueBuf) / sizeof(queueBuf[0]);
static size_t qHead = 0, qCount = 0;

static void queuePush(const Reading &r) {
  if (qCount == QUEUE_CAP) {  // to'lsa eng eskisi tashlanadi
    qHead = (qHead + 1) % QUEUE_CAP;
    qCount--;
  }
  queueBuf[(qHead + qCount) % QUEUE_CAP] = r;
  qCount++;
}

static void queueFlush() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[HTTP] Wi-Fi yo'q, navbatda %u ta o'lchov\n", (unsigned)qCount);
    lastHttpCode = ST_NO_WIFI;
    return;
  }
  for (int i = 0; i < OFFLINE_SEND_PER_CYCLE && qCount; i++) {
    int code = postReading(queueBuf[qHead], true);
    lastHttpCode = code;
    bool drop = (code >= 200 && code < 300) || code == 400 || code == 422;  // qabul qilindi yoki butunlay rad etildi
    if (!drop) break;
    qHead = (qHead + 1) % QUEUE_CAP;
    qCount--;
  }
  if (qCount) Serial.printf("[HTTP] Navbatda %u ta o'lchov qoldi\n", (unsigned)qCount);
}

static void sendReadings() {
  if (isnan(inlet.temp) && isnan(outlet.temp)) {
    Serial.println("[HTTP] O'lchov yo'q, yuborilmadi");
    lastHttpCode = ST_NO_DATA;
    return;
  }
  /*
   * v2.1.0: MUASSASA BO'SH BO'LSA HAM YUBORILADI.
   *
   * v2.0.0 da bu yerda to'siq bor edi: muassasa tanlanmaguncha qurilma
   * serverga hech narsa yubormasdi (boshqa muassasa ma'lumotini buzmaslik
   * uchun). Andijon panelida esa server kotyolni device_id orqali O'ZI
   * aniqlaydi va tanadagi institution_id ga UMUMAN ishonmaydi -- demak
   * boshqa binoning ma'lumotini buzish IMKONSIZ.
   *
   * To'siqni saqlash esa aksincha ZARARLI bo'lardi: montajchi muassasa
   * izohini yozishni unutsa, plata o'rnatilgan bo'lsa ham harorat
   * KELMASDI va buning sababi faqat qurilma jurnalida ko'rinardi.
   */
  Reading r = {nowEpoch(), inlet.temp, outlet.temp};
  if (OFFLINE_QUEUE_ENABLED && r.ts) {
    queuePush(r);
    queueFlush();
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Wi-Fi yo'q, yuborilmadi");
    lastHttpCode = ST_NO_WIFI;
    return;
  }
  lastHttpCode = postReading(r, false);
}

static String tempStr(float t) {
  return isnan(t) ? String("--") : String(t, 1) + (char)223;  // "45.3°" - 16 belgiga sig'adi
}

static void updateLcd() {
  String l1 = "K:" + tempStr(inlet.temp) + " C:" + tempStr(outlet.temp);
  String l2;
  if (!institutionId.length()) l2 = "Muassasa yo'q";
  else if (WiFi.status() != WL_CONNECTED) l2 = "WiFi yo'q";
  else if (lastHttpCode >= 200 && lastHttpCode < 300) l2 = institutionId + " OK";
  else if (lastHttpCode == ST_NONE) l2 = institutionId + " ...";
  else if (lastHttpCode == ST_NO_DATA) l2 = "Datchik yo'q";
  else if (lastHttpCode > 0) l2 = "Server: " + String(lastHttpCode);
  else l2 = "Tarmoq xato " + String(lastHttpCode);
  lcdShow(l1, l2);
}

static void measureAndSend() {
  if (!inlet.found || !outlet.found) scanSensors();
  readSensors();
  Reading r = {nowEpoch(), inlet.temp, outlet.temp};
  if (!isnan(r.in) || !isnan(r.out)) Serial.printf("[DATA] %s\n", buildJson(r, false).c_str());
  sendReadings();
  updateLcd();
}

// Tez o'lchov: LCD va serial'ga JSON qatori (USB orqali kuzatish uchun)
static unsigned long lastMeasure = 0;
static unsigned long lastRescan = 0;
static void measureLocal() {
  if ((!inlet.found || !outlet.found) && millis() - lastRescan > 30000) {
    lastRescan = millis();
    scanSensors();
  }
  readSensors(false);
  Reading r = {0, inlet.temp, outlet.temp};
  if (!isnan(r.in) || !isnan(r.out)) Serial.printf("[DATA] %s\n", buildJson(r, false).c_str());
  updateLcd();
}

// ---------------------------------------------------------------- sozlash sahifasi

static const char PAGE_HEAD[] PROGMEM = R"HTML(<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Harorat sozlash</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:0 auto;padding:16px;background:#f6f7f9;color:#16191d}
h1{font-size:20px;margin:8px 0}.muted{color:#6b7280;font-size:13px}
.net{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:6px 0;font-weight:400}
.f{display:block;margin:14px 0 4px;font-weight:600}
input[type=text],input[type=password],select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;background:#fff}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:16px}
a{color:#2563eb}</style></head><body>)HTML";

static void sendPage(int code, const String &body) {
  String h = FPSTR(PAGE_HEAD);
  h += body;
  h += "</body></html>";
  web.send(code, "text/html; charset=utf-8", h);
}

static void handleRoot() {
  int n = WiFi.scanNetworks();
  if (n < 0) n = 0;
  int idx[64];
  int cnt = 0;
  for (int i = 0; i < n && cnt < 64; i++) {
    String s = WiFi.SSID(i);
    if (s.isEmpty()) continue;
    bool dup = false;
    for (int j = 0; j < cnt; j++) {
      if (WiFi.SSID(idx[j]) == s) {
        if (WiFi.RSSI(i) > WiFi.RSSI(idx[j])) idx[j] = i;
        dup = true;
        break;
      }
    }
    if (!dup) idx[cnt++] = i;
  }
  for (int a = 0; a < cnt; a++)
    for (int b = a + 1; b < cnt; b++)
      if (WiFi.RSSI(idx[b]) > WiFi.RSSI(idx[a])) { int t = idx[a]; idx[a] = idx[b]; idx[b] = t; }

  String current;
  hasSavedWifi(&current);
  String h = "<h1>Harorat qurilmasi</h1><p class=muted>Qurilma: " + deviceId + " &middot; v" FW_VERSION +
             (current.length() ? "<br>Hozirgi Wi-Fi: " + htmlEscape(current) : String()) + "</p><form method=post action=/save>";
  h += "<span class=f>Wi-Fi tarmog'ini tanlang</span>";
  if (cnt == 0) h += "<p class=muted>Tarmoq topilmadi. <a href=/>Qayta qidirish</a></p>";
  for (int k = 0; k < cnt; k++) {
    int i = idx[k];
    String e = htmlEscape(WiFi.SSID(i));
    h += "<label class=net><span><input type=radio name=ssid value=\"" + e + "\"> " + e + "</span><span class=muted>" +
         String(WiFi.RSSI(i)) + " dBm" + (WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? " &middot; ochiq" : "") + "</span></label>";
  }
  WiFi.scanDelete();
  h += "<label class=f for=m>Yoki tarmoq nomini yozing</label><input id=m type=text name=ssid_manual maxlength=32 autocapitalize=none>";
  h += "<label class=f for=p>Wi-Fi paroli</label><input id=p type=password name=pass maxlength=63>";
  h += "<p class=muted>Wi-Fi'ni o'zgartirmoqchi bo'lmasangiz, tarmoq va parolni bo'sh qoldiring.</p>";
  // v2.1.0: ro'yxat o'rniga ERKIN MATN -- viloyatda yuzlab obyekt bor.
  h += "<label class=f for=i>Muassasa (ixtiyoriy izoh)</label>";
  h += "<input id=i type=text name=inst maxlength=64 autocapitalize=none value=\"" +
       htmlEscape(institutionId) + "\">";
  h += "<p class=muted>Masalan: 12-maktab yoki 5-bog'cha. Bo'sh qoldirsangiz ham "
       "qurilma ishlaydi - panel uni identifikatori bo'yicha taniydi.</p>";
  h += "<button type=submit>Saqlash</button></form><p class=muted><a href=/>Ro'yxatni yangilash</a></p>";
  sendPage(200, h);
}

static void handleSave() {
  String ssid = web.arg("ssid_manual");
  ssid.trim();
  if (ssid.isEmpty()) ssid = web.arg("ssid");
  String pass = web.arg("pass");
  String inst = web.arg("inst");

  String err;
  if (ssid.length() > 32) err = "Tarmoq nomi 32 belgidan oshmasin.";
  else if (ssid.isEmpty() && pass.length()) err = "Parol kiritildi, lekin Wi-Fi tarmog'i tanlanmadi.";
  else if (pass.length() > 0 && (pass.length() < 8 || pass.length() > 63)) err = "Parol 8-63 belgidan iborat bo'lishi kerak.";
  else if (!validInstitution(inst))
    err = "Muassasa izohi 64 belgidan oshmasin; faqat harf, raqam, bo'sh joy, - _ . ishlatiladi.";
  if (err.length()) {
    sendPage(400, "<h1>Xato</h1><p>" + htmlEscape(err) + "</p><p><a href=/>Orqaga</a></p>");
    return;
  }

  if (ssid.length()) {
    wifi_config_t conf = {};
    memcpy(conf.sta.ssid, ssid.c_str(), ssid.length());
    memcpy(conf.sta.password, pass.c_str(), pass.length());
    esp_wifi_set_storage(WIFI_STORAGE_FLASH);
    esp_err_t rc = esp_wifi_set_config(WIFI_IF_STA, &conf);
    if (rc != ESP_OK) {
      sendPage(500, "<h1>Xato</h1><p>Wi-Fi sozlamasi saqlanmadi (" + String(rc) + ").</p><p><a href=/>Orqaga</a></p>");
      return;
    }
  }
  prefs.putString("inst", inst);
  institutionId = inst;

  Serial.printf("[SETUP] Saqlandi: Wi-Fi '%s', muassasa %s. Qayta ishga tushirilmoqda...\n",
                ssid.length() ? ssid.c_str() : "(o'zgarmadi)", inst.c_str());
  sendPage(200, "<h1>Saqlandi</h1><p>Qurilma 3 soniyadan keyin qayta ishga tushadi" +
                    (ssid.length() ? " va <b>" + htmlEscape(ssid) + "</b> tarmog'iga ulanadi" : String()) +
                    ".</p><p class=muted>Telefoningizni odatdagi Wi-Fi'ga qaytaring. "
                    "Ulanmasa, Wi-Fi tugmasini 5 soniya bosib, qaytadan sozlang.</p>");
  lcdShow("Saqlandi", "qayta yuklanmoqda");
  restartAt = millis() + 3000;
}

static void handleNotFound() {
  web.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
  web.send(302, "text/plain", "");
}

static void enterSetupMode(const char *why) {
  if (setupMode) return;
  setupMode = true;
  setupStarted = millis();
  Serial.printf("[SETUP] Sozlash rejimi: %s\n", why);
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(SETUP_AP_SSID, apPass.c_str());
  delay(200);
  IPAddress ip = WiFi.softAPIP();
  dns.start(53, "*", ip);
  web.begin();
  Serial.printf("[SETUP] Telefonda '%s' Wi-Fi'ga ulaning (parol: %s), so'ng http://%s ni oching\n",
                SETUP_AP_SSID, apPass.c_str(), ip.toString().c_str());
  lcdShow(SETUP_AP_SSID, "Parol: " + apPass);
}

// ---------------------------------------------------------------- boshqaruv

static void printInfo() {
  Serial.printf("[INFO] Qurilma: %s, versiya: %s, muassasa: %s, rejim: %s\n", deviceId.c_str(), FW_VERSION,
                institutionId.length() ? institutionId.c_str() : "(tanlanmagan)", setupMode ? "sozlash" : "ish");
  Serial.printf("[INFO] AP paroli: %s\n", apPass.c_str());
  Serial.printf("[INFO] Token: %s\n", prefs.isKey("tok") ? "shaxsiy" : (strlen(API_TOKEN) ? "umumiy (secrets.h)" : "YO'Q"));
  Serial.printf("[INFO] Wi-Fi: %s, IP: %s, RSSI: %d\n",
                WiFi.status() == WL_CONNECTED ? "ulangan" : "yo'q",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  Serial.printf("[INFO] SSID: %s, BSSID: %s, kanal: %d\n", WiFi.SSID().c_str(), WiFi.BSSIDstr().c_str(), (int)WiFi.channel());
  Serial.printf("[INFO] Server: %s, oxirgi javob: %d, vaqt: %s\n", SERVER_URL, lastHttpCode, nowEpoch() ? "sinxron" : "yo'q");
  if (OFFLINE_QUEUE_ENABLED) Serial.printf("[INFO] Oflayn navbat: %u ta\n", (unsigned)qCount);
  Serial.printf("[INFO] Kirish: %s, chiqish: %s, LCD: %s\n", inlet.found ? "bor" : "yo'q", outlet.found ? "bor" : "yo'q",
                lcdOk ? "bor" : "yo'q");
  otaPrintInfo();
}

// ---- Wi-Fi tugmasi (GPIO2). Platada bo'sh holatda LOW, bosilganda 3.3V (HIGH).
// WIFI_BUTTON_HOLD_MS (5 s) bosib turilsa Wi-Fi sozlash rejimi. Bosish payti uzilish (interrupt) bilan qayd etiladi,
// shuning uchun o'lchash/HTTPS paytida ham vaqt to'g'ri hisoblanadi; kontakt sakrashi (50 ms gacha) e'tiborsiz.
static volatile uint32_t wifiBtnRiseAt = 0;   // bosilgan payt (0 - bosilmagan)
static volatile uint32_t wifiBtnFallAt = 0;   // oxirgi qo'yib yuborilgan payt
static volatile uint32_t wifiBtnRiseKeep = 0; // sakrash bo'lsa asl bosilgan payt
static volatile bool wifiBtnEvent = false;    // kamida HOLD_MS bosilib qo'yib yuborildi
static bool wifiBtnWaitRelease = false;
static uint32_t wifiBtnIgnoreUntil = 0;
static int wifiBtnShown = -1;                 // LCD'da ko'rsatilgan qolgan soniya

static void IRAM_ATTR wifiBtnIsr() {
  uint32_t now = millis();
  if (digitalRead(WIFI_BUTTON_PIN) == WIFI_BUTTON_ACTIVE) {
    if (!wifiBtnRiseAt) {
      bool bounce = wifiBtnRiseKeep && now - wifiBtnFallAt < 50;
      wifiBtnRiseAt = bounce ? wifiBtnRiseKeep : (now ? now : 1);
    }
  } else if (wifiBtnRiseAt) {
    if (now - wifiBtnRiseAt >= WIFI_BUTTON_HOLD_MS) wifiBtnEvent = true;
    wifiBtnRiseKeep = wifiBtnRiseAt;
    wifiBtnFallAt = now;
    wifiBtnRiseAt = 0;
  }
}

static void attachWifiButton() {
  pinMode(WIFI_BUTTON_PIN, WIFI_BUTTON_ACTIVE == HIGH ? INPUT_PULLDOWN : INPUT_PULLUP);
  wifiBtnRiseAt = 0;
  wifiBtnEvent = false;
  attachInterrupt(digitalPinToInterrupt(WIFI_BUTTON_PIN), wifiBtnIsr, CHANGE);
}

static void calibrateWifiButton() {
  attachWifiButton();
  wifiBtnIgnoreUntil = millis() + 1000;
  Serial.printf("[BTN] Wi-Fi tugmasi GPIO%d (bosilganda %s), hozir: %s\n", WIFI_BUTTON_PIN,
                WIFI_BUTTON_ACTIVE == HIGH ? "HIGH" : "LOW",
                digitalRead(WIFI_BUTTON_PIN) == WIFI_BUTTON_ACTIVE ? "bosilgan" : "bo'sh");
}

static void onWifiButton() {
  if (setupMode) {
    Serial.println("[BTN] Wi-Fi tugmasi: sozlash bekor qilindi, qayta ishga tushirilmoqda");
    lcdShow("Bekor qilindi", "qayta yuklanmoqda");
    delay(500);
    ESP.restart();
  }
  Serial.println("[BTN] Wi-Fi tugmasi bosildi");
  lcdShow("WiFi", "Qidirilmoqda...");
  enterSetupMode("Wi-Fi tugmasi");
}

static void checkButton() {
  // BOOT (GPIO0): 3 soniya bosib turish
  if (digitalRead(SETUP_BUTTON_PIN) == LOW) {
    if (!btnDownAt) btnDownAt = millis();
    else if (!setupMode && millis() - btnDownAt >= 3000) enterSetupMode("BOOT tugmasi");
  } else {
    btnDownAt = 0;
  }

  // Wi-Fi tugmasi: 5 soniya bosib turish
  bool down = digitalRead(WIFI_BUTTON_PIN) == WIFI_BUTTON_ACTIVE;
  if (wifiBtnWaitRelease) {
    // bitta bosib turishdan ikki marta ishlamasligi uchun qo'yib yuborilishini kutamiz
    if (!down) {
      wifiBtnWaitRelease = false;
      wifiBtnIgnoreUntil = millis() + 400;
    }
    wifiBtnEvent = false;
    return;
  }
  uint32_t rise = wifiBtnRiseAt;
  uint32_t heldMs = (down && rise) ? millis() - rise : 0;
  bool ev = wifiBtnEvent || heldMs >= WIFI_BUTTON_HOLD_MS;
  wifiBtnEvent = false;
  if ((long)(millis() - wifiBtnIgnoreUntil) < 0) return;

  if (ev) {
    wifiBtnShown = -1;
    wifiBtnWaitRelease = down;
    wifiBtnIgnoreUntil = millis() + 1000;
    onWifiButton();
    return;
  }
  // Ushlab turilganda LCD'da qolgan soniyani ko'rsatamiz; erta qo'yib yuborilsa - bekor
  if (heldMs >= 700) {
    int left = (int)((WIFI_BUTTON_HOLD_MS - heldMs + 999) / 1000);
    if (left != wifiBtnShown) {
      wifiBtnShown = left;
      char l2[17];
      snprintf(l2, sizeof(l2), "ushlang: %d s", left);
      lcdShow(setupMode ? "Sozlash bekor" : "WiFi qayta sozl.", l2);
      Serial.printf("[BTN] Wi-Fi tugmasi bosib turilibdi, %d s qoldi\n", left);
    }
  } else if (!down && wifiBtnShown >= 0) {
    wifiBtnShown = -1;
    Serial.println("[BTN] Erta qo'yib yuborildi (5 s kerak) - hech narsa qilinmadi");
    lcdShow(setupMode ? "Sozlash rejimi" : "Bekor qilindi", setupMode ? "Parol: " + apPass : String());
    lastMeasure = 0;  // LCD tez orada haroratga qaytadi
  }
}

static void pinScan() {
  const uint8_t pins[] = {4, 5, 13, 14, 15, 16, 17, 18, 19, 23, 25, 26, 27, 32, 33};
  for (uint8_t p : pins) {
    OneWire ow(p);
    DallasTemperature ds(&ow);
    ds.begin();
    int cnt = ds.getDeviceCount();
    ds.requestTemperatures();
    for (int i = 0; i < cnt; i++) {
      DeviceAddress a;
      if (ds.getAddress(a, i)) Serial.printf("[PINSCAN] GPIO%-2u #%d %s %.2f C\n", p, i, addrToStr(a).c_str(), ds.getTempC(a));
    }
  }
  Serial.println("[PINSCAN] tugadi");
}

// 'p': 40 soniya davomida bo'sh pinlarni kuzatib, holati o'zgarganini chiqaradi (tugmani topish uchun)
static void pinWatch() {
  const uint8_t pull[] = {0, 2, 12, 13, 14, 15, 16, 17, 18, 19, 23, 25, 26, 27, 32, 33};
  const uint8_t raw[] = {34, 35, 36, 39};  // faqat kirish, ichki pull yo'q
  const size_t NP = sizeof(pull), NR = sizeof(raw);
  uint8_t prev[NP + NR];
  auto sampleP = [](uint8_t p) {
    pinMode(p, INPUT_PULLUP); delayMicroseconds(60); uint8_t a = digitalRead(p);
    pinMode(p, INPUT_PULLDOWN); delayMicroseconds(60); uint8_t b = digitalRead(p);
    pinMode(p, INPUT_PULLUP);
    return (uint8_t)(a | (b << 1));
  };
  for (size_t i = 0; i < NP; i++) prev[i] = sampleP(pull[i]);
  for (size_t i = 0; i < NR; i++) { pinMode(raw[i], INPUT); prev[NP + i] = digitalRead(raw[i]); }
  detachInterrupt(digitalPinToInterrupt(WIFI_BUTTON_PIN));
  Serial.println("[PINWATCH] boshlandi (40 s) - tugmalarni bosing");
  unsigned long end = millis() + 40000;
  while ((long)(end - millis()) > 0) {
    for (size_t i = 0; i < NP + NR; i++) {
      uint8_t p = i < NP ? pull[i] : raw[i - NP];
      uint8_t v = i < NP ? sampleP(p) : (uint8_t)digitalRead(p);
      if (v != prev[i]) {
        Serial.printf("[PINWATCH] %6lu ms GPIO%-2u %u -> %u\n", millis(), p, prev[i], v);
        prev[i] = v;
      }
    }
    delay(15);
  }
  attachWifiButton();
  wifiBtnIgnoreUntil = millis() + 500;
  Serial.println("[PINWATCH] tugadi");
}

static void wifiScan() {
  int n = WiFi.scanNetworks();
  Serial.printf("[SCAN] %d ta tarmoq\n", n);
  for (int i = 0; i < n; i++)
    Serial.printf("[SCAN] %-32s %s ch%-2d %4d dBm %s\n", WiFi.SSID(i).c_str(), WiFi.BSSIDstr(i).c_str(), (int)WiFi.channel(i),
                  (int)WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "ochiq" : "");
  WiFi.scanDelete();
}

static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 's') scanSensors();
  else if (c == 'm' && !setupMode) measureAndSend();
  else if (c == 'i') printInfo();
  else if (c == 'w') enterSetupMode("serial buyruq");
  else if (c == 'o') pinScan();
  else if (c == 'p') pinWatch();
  else if (c == 'n') wifiScan();
  else if (c == 'u') otaCheckNow();
  else if (c == 'r') ESP.restart();
  else if (c == 'I') {
    // "I<muassasa>\n": muassasani xotiraga yozish (proshivka skripti uchun), masalan "Imaktab-4"
    String v = Serial.readStringUntil('\n');
    v.trim();
    if (validInstitution(v)) {
      prefs.putString("inst", v);
      institutionId = v;
      Serial.printf("[SET] Muassasa: %s\n", v.c_str());
    } else {
      Serial.printf("[SET] Noto'g'ri muassasa: '%s'\n", v.c_str());
    }
  } else if (c == 'W') {
    // "W<ssid>\t<parol>\n": Wi-Fi'ni xotiraga yozish (joyiga borguncha oldindan sozlash uchun)
    String line = Serial.readStringUntil('\n');
    line.trim();
    int tab = line.indexOf('\t');
    String ssid = tab < 0 ? line : line.substring(0, tab);
    String pass = tab < 0 ? "" : line.substring(tab + 1);
    if (!ssid.length() || ssid.length() > 32 || pass.length() > 63 || (pass.length() && pass.length() < 8)) {
      Serial.println("[SET] Wi-Fi nomi yoki paroli noto'g'ri");
    } else {
      WiFi.persistent(true);
      WiFi.disconnect();
      WiFi.begin(ssid.c_str(), pass.c_str());  // NVS ga saqlanadi
      lastWifiTry = millis();
      Serial.printf("[SET] Wi-Fi saqlandi: '%s'\n", ssid.c_str());
    }
  } else if (c == 'T') {
    // "T<token>\n": shaxsiy qurilma tokeni (server shu qurilma uchun kutgan token); "T\n" - umumiy tokenga qaytish
    String v = Serial.readStringUntil('\n');
    v.trim();
    if (!v.length()) {
      prefs.remove("tok");
      deviceToken = API_TOKEN;
      Serial.println("[SET] Token: umumiy");
    } else if (validToken(v)) {
      prefs.putString("tok", v);
      deviceToken = v;
      Serial.printf("[SET] Token: shaxsiy (%s...)\n", v.substring(0, 4).c_str());
    } else {
      Serial.println("[SET] Token noto'g'ri (16-128 belgi: harf, raqam, - _)");
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(1000);
  delay(300);
  Serial.printf("\n=== ESP32 Issiqlik monitoringi (DS18B20 x2) v%s ===\n", FW_VERSION);
  pinMode(SETUP_BUTTON_PIN, INPUT_PULLUP);
  calibrateWifiButton();

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.beginTransmission(LCD_ADDR);
  lcdOk = Wire.endTransmission() == 0;
  if (lcdOk) {
    lcd.init();
    lcd.backlight();
  }
  Serial.printf("[LCD] %s\n", lcdOk ? "topildi" : "topilmadi (ixtiyoriy)");
  lcdShow("Issiqlik monitor", "v" FW_VERSION);

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);  // eFuse'dan; Wi-Fi ishga tushmasdan oldin ham to'g'ri
  char idBuf[20];
  snprintf(idBuf, sizeof(idBuf), "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  deviceId = idBuf;

  prefs.begin("harorat", false);
  // Eski server manzillari: endi manzil faqat proshivkada (telefondan o'zgartirib bo'lmaydi)
  if (prefs.isKey("url2")) prefs.remove("url2");
  if (prefs.isKey("url3")) prefs.remove("url3");
  institutionId = prefs.getString("inst", INSTITUTION_ID);
  if (!validInstitution(institutionId)) institutionId = "";
  deviceToken = prefs.getString("tok", "");
  if (!validToken(deviceToken)) deviceToken = API_TOKEN;
  Serial.printf("[INFO] Qurilma ID: %s, muassasa: %s\n", deviceId.c_str(),
                institutionId.length() ? institutionId.c_str() : "(tanlanmagan - yuborilmaydi)");
  Serial.printf("[INFO] Server: %s\n", SERVER_URL);
  otaSetup();

  web.on("/", HTTP_GET, handleRoot);
  web.on("/save", HTTP_POST, handleSave);
  web.onNotFound(handleNotFound);

  scanSensors();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  // Sozlash AP paroli: har bir platada alohida, bir marta yaratiladi (Wi-Fi yoqilgandan keyin - haqiqiy tasodifiy son)
  apPass = prefs.getString("appass", "");
  if (apPass.length() != 8) {
    char b[9];
    snprintf(b, sizeof(b), "%08lu", (unsigned long)(esp_random() % 100000000UL));
    apPass = b;
    prefs.putString("appass", apPass);
  }

  lastConnectedAt = millis();
  startWifi();
  lastSend = millis() - SEND_INTERVAL_MS + FIRST_SEND_DELAY_MS;
}

void loop() {
  checkButton();
  handleSerial();

  if (setupMode) {
    dns.processNextRequest();
    web.handleClient();
    if (restartAt && (long)(millis() - restartAt) >= 0) ESP.restart();
    if (millis() - setupStarted >= SETUP_TIMEOUT_MS) {
      Serial.println("[SETUP] Vaqt tugadi, qayta ishga tushirilmoqda");
      ESP.restart();
    }
  } else {
    handleWifi();
    if (!setupMode && millis() - lastSend >= SEND_INTERVAL_MS) {
      lastSend = millis();
      lastMeasure = millis();
      measureAndSend();
    } else if (!setupMode && millis() - lastMeasure >= MEASURE_INTERVAL_MS) {
      lastMeasure = millis();
      measureLocal();
    }
    if (!setupMode) otaLoop(WiFi.status() == WL_CONNECTED);
  }
  delay(5);
}
