// Masofadan yangilash (OTA): dashboard (server/ota) orqali boshqariladi.
//
// 1. Qurilma har OTA_CHECK_INTERVAL_MS da so'raydi:  GET  OTA_URL?a=check&device_id=..&version=..&inst=..
//    Javob: {"update":false}  yoki  {"update":true,"version":"2.0.1","url":"https://<server>/...","sha256":"<64 hex>","size":N}
// 2. Fayl faqat o'z serverimizdan (https, Let's Encrypt ildizlari) yuklanadi, oqim bo'yicha SHA-256 hisoblanadi,
//    mos kelmasa yozilgan qism bekor qilinadi. Mos kelsa - ikkinchi OTA bo'limiga yoziladi va qayta ishga tushadi.
// 3. Yangi proshivka "tasdiq kutilmoqda" holatida ishga tushadi. Serverga birinchi muvaffaqiyatli telemetriyadan keyin
//    tasdiqlanadi. Qulasa (qayta yuklansa) yoki belgilangan vaqtda yubora olmasa - avtomatik eski proshivkaga qaytadi.
// 4. Holat serverga hisobot qilinadi: POST OTA_URL?a=report {"status":"installed|ok|failed|rolled_back",...}
#include "app.h"
#include "config.h"
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

// Arduino yadrosi yangi proshivkani ishga tushishi bilan "yaroqli" deb belgilamasin - tasdiqni o'zimiz beramiz.
extern "C" bool verifyRollbackLater() { return true; }

// .bin ichidagi versiya belgisi: dashboard yuklangan faylning versiyasini shundan o'qiydi.
extern "C" __attribute__((used)) const char FW_VERSION_MARK[] = "XONOBOD_FW_VERSION=" FW_VERSION ";";

static bool pending = false;          // yangi proshivka tasdiq kutyapti
static unsigned long onlineMs = 0;    // tasdiq kutilayotganda Wi-Fi ulangan vaqt
static unsigned long lastTick = 0;
static bool checkScheduled = false;
static bool forceCheck = false;
static unsigned long nextCheckAt = 0;
static String lastResult = "hali tekshirilmagan";

// ---------------------------------------------------------------- hisobot

static void saveReport(const char *status, const String &target, const String &msg) {
  prefs.putString("ota_rep", String(status) + "\t" + target + "\t" + msg);
}

static bool sendReport() {
  String rep = prefs.getString("ota_rep", "");
  if (!rep.length()) return true;
  int t1 = rep.indexOf('\t'), t2 = rep.indexOf('\t', t1 + 1);
  if (t1 < 0 || t2 < 0) {
    prefs.remove("ota_rep");
    return true;
  }
  String status = rep.substring(0, t1);
  String body = "{\"device_id\":\"" + deviceId + "\",\"version\":\"" FW_VERSION "\",\"institution_id\":\"" +
                jsonEscape(institutionId) + "\",\"status\":\"" + jsonEscape(status) + "\",\"target\":\"" +
                jsonEscape(rep.substring(t1 + 1, t2)) + "\",\"message\":\"" + jsonEscape(rep.substring(t2 + 1)) + "\"}";
  NetworkClientSecure tls;
  HTTPClient http;
  if (!httpsBegin(http, tls, String(OTA_URL) + "?a=report", HTTP_TIMEOUT_MS)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  Serial.printf("[OTA] Hisobot '%s' -> %d\n", status.c_str(), code);
  if (code >= 200 && code < 300) {
    prefs.remove("ota_rep");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- tasdiqlash / qaytish

void otaSetup() {
  lastTick = millis();
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  bool pendingState = esp_ota_get_state_partition(running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
  String tryV = prefs.getString("ota_try", "");

  if (tryV.length() && tryV != FW_VERSION) {
    // Yangi proshivka tasdiqlanmadi va bootloader eskisiga qaytardi (yoki .bin dagi versiya kutilganidan boshqa)
    Serial.printf("[OTA] %s o'rnatilmadi, %s da qolindi\n", tryV.c_str(), FW_VERSION);
    saveReport("rolled_back", tryV, "yangi proshivka tasdiqlanmadi, " FW_VERSION " ga qaytildi");
    prefs.remove("ota_try");
  }
  pending = pendingState || (tryV.length() && tryV == FW_VERSION);
  if (pending) {
    Serial.printf("[OTA] Yangi proshivka %s: serverga birinchi muvaffaqiyatli yuborishdan keyin tasdiqlanadi\n", FW_VERSION);
  }
}

static bool telemetryTried = false;  // tasdiq kutilayotganda haqiqiy telemetriya yuborildimi
static bool pingDone = false;

static void confirmNow(const char *msg) {
  esp_ota_mark_app_valid_cancel_rollback();
  pending = false;
  prefs.remove("ota_try");
  saveReport("ok", FW_VERSION, msg);
  Serial.printf("[OTA] %s tasdiqlandi\n", FW_VERSION);
  checkScheduled = true;
  nextCheckAt = millis() + 5000;  // hisobotni tezroq yuborish
}

void otaTelemetryResult(int code) {
  if (!pending) return;
  telemetryTried = true;
  if (code >= 200 && code < 300) confirmNow("yangi proshivka serverga yubormoqda");
}

static void rollbackNow(const char *why) {
  Serial.printf("[OTA] %s - eski proshivkaga qaytilmoqda\n", why);
  lcdShow("Yangilash xato", "eskisiga qaytish");
  delay(500);
  esp_ota_mark_app_invalid_rollback_and_reboot();  // "tasdiq kutilmoqda" holatida qaytadi
  // Bootloader rollback'ni qo'llamasa: ikkinchi bo'limdan yuklaymiz
  const esp_partition_t *other = esp_ota_get_next_update_partition(nullptr);
  if (other && esp_ota_set_boot_partition(other) == ESP_OK) ESP.restart();
  Serial.println("[OTA] Qaytib bo'lmadi, joriy proshivkada qolinadi");
  pending = false;
  prefs.remove("ota_try");
}

bool otaBusy() { return pending; }

// ---------------------------------------------------------------- yuklab olish va yozish

static String install(const String &url, long size, const String &sha, const String &ver) {
  const esp_partition_t *part = esp_ota_get_next_update_partition(nullptr);
  if (!part) return "OTA bo'limi yo'q";
  if ((uint32_t)size > part->size) return "fayl OTA bo'limidan katta";

  Serial.printf("[OTA] %s -> %s (%ld bayt) yuklanmoqda\n", FW_VERSION, ver.c_str(), size);
  lcdShow("Yangilanmoqda", "v" + ver);

  NetworkClientSecure tls;
  HTTPClient http;
  if (!httpsBegin(http, tls, url, 20000)) return "yuklab olish manzili noto'g'ri";
  int code = http.GET();
  if (code != 200) {
    http.end();
    return "yuklab olish: " + String(code);
  }
  int len = http.getSize();
  if (len != size) {
    http.end();
    return "hajm mos emas: " + String(len);
  }
  if (!Update.begin(size)) {
    http.end();
    return String("Update.begin: ") + Update.errorString();
  }

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  NetworkClient *s = http.getStreamPtr();
  static uint8_t buf[4096];
  long done = 0;
  int lastPct = -10;
  unsigned long lastData = millis();
  String err;
  while (done < size) {
    size_t av = s->available();
    if (!av) {
      if (!s->connected()) { err = "aloqa uzildi"; break; }
      if (millis() - lastData > 20000) { err = "vaqt tugadi"; break; }
      delay(2);
      continue;
    }
    size_t want = av < sizeof(buf) ? av : sizeof(buf);
    if ((long)want > size - done) want = size - done;
    int n = s->read(buf, want);
    if (n <= 0) continue;
    mbedtls_sha256_update(&ctx, buf, n);
    if (Update.write(buf, n) != (size_t)n) {
      err = String("yozish: ") + Update.errorString();
      break;
    }
    done += n;
    lastData = millis();
    int pct = (int)(done * 100 / size);
    if (pct - lastPct >= 10) {
      lastPct = pct;
      lcdShow("Yangilanmoqda", String(pct) + "% v" + ver);
      Serial.printf("[OTA] %d%%\n", pct);
    }
  }
  http.end();
  uint8_t dig[32];
  mbedtls_sha256_finish(&ctx, dig);
  mbedtls_sha256_free(&ctx);
  if (!err.length()) {
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", dig[i]);
    if (!sha.equalsIgnoreCase(hex)) err = "SHA-256 mos emas";
  }
  if (err.length()) {
    Update.abort();
    lcdShow("Yangilash xato", err);
    return err;
  }
  if (!Update.end()) return String("tugatish: ") + Update.errorString();

  prefs.putString("ota_try", ver);
  saveReport("installed", ver, "yuklandi va tekshirildi, qayta ishga tushirilmoqda");
  sendReport();
  Serial.printf("[OTA] %s yozildi, qayta ishga tushirilmoqda\n", ver.c_str());
  lcdShow("Yangilandi", "v" + ver);
  delay(1000);
  ESP.restart();
  return "";
}

// true - tekshiruv bo'ldi (natijasidan qat'i nazar), false - server bilan aloqa bo'lmadi
static bool checkAndInstall() {
  sendReport();
  String url = String(OTA_URL) + "?a=check&device_id=" + deviceId + "&version=" FW_VERSION "&inst=" + institutionId;
  NetworkClientSecure tls;
  HTTPClient http;
  if (!httpsBegin(http, tls, url, HTTP_TIMEOUT_MS)) {
    lastResult = "manzil noto'g'ri";
    return false;
  }
  int code = http.GET();
  String body = code == 200 ? http.getString() : String();
  http.end();
  if (code != 200) {
    lastResult = "server javobi " + String(code);
    Serial.printf("[OTA] Tekshiruv: %s\n", lastResult.c_str());
    return false;
  }
  if (!jsonBool(body, "update")) {
    lastResult = "yangilanish yo'q";
    Serial.println("[OTA] Yangilanish yo'q");
    return true;
  }
  String ver = jsonString(body, "version");
  String fwUrl = jsonString(body, "url");
  String sha = jsonString(body, "sha256");
  long size = jsonNumber(body, "size", 0);
  if (!ver.length() || ver == FW_VERSION || sha.length() != 64 || size <= 0 || !isOwnServerUrl(fwUrl)) {
    lastResult = "server javobi noto'g'ri";
    Serial.printf("[OTA] %s: %s\n", lastResult.c_str(), body.substring(0, 160).c_str());
    return true;
  }
  String err = install(fwUrl, size, sha, ver);  // muvaffaqiyatli bo'lsa qaytmaydi (qayta ishga tushadi)
  lastResult = "xato: " + err;
  Serial.printf("[OTA] Yangilash xato: %s\n", err.c_str());
  saveReport("failed", ver, err);
  sendReport();
  return true;  // keyingi urinish odatdagi oraliqda; server bir necha xatodan keyin bu versiyani to'xtatadi
}

void otaLoop(bool wifiConnected) {
  unsigned long now = millis();
  if (pending) {
    if (wifiConnected) onlineMs += now - lastTick;
    lastTick = now;
    // Datchik yoki muassasa yo'q bo'lsa telemetriya umuman yuborilmaydi: unda server bilan aloqani hisobot orqali tekshiramiz
    if (!telemetryTried && !pingDone && wifiConnected && onlineMs >= 180000UL) {
      pingDone = true;
      saveReport("ok", FW_VERSION, "o'lchov yuborilmadi (datchik/muassasa yo'q), server bilan aloqa bor");
      if (sendReport()) confirmNow("o'lchov yuborilmadi (datchik/muassasa yo'q), server bilan aloqa bor");
      return;
    }
    if (onlineMs >= OTA_CONFIRM_ONLINE_MS) rollbackNow("Yangi proshivka 10 daqiqada serverga yubora olmadi");
    else if (now >= OTA_CONFIRM_TOTAL_MS) rollbackNow("Yangi proshivka 1 soatda tasdiqlanmadi");
    return;  // tasdiqlanmaguncha yangi yangilanish olinmaydi
  }
  lastTick = now;
  if (!wifiConnected) return;
  if (!checkScheduled) {
    checkScheduled = true;
    nextCheckAt = now + OTA_CHECK_FIRST_MS;
  }
  if (!forceCheck && (long)(now - nextCheckAt) < 0) return;
  forceCheck = false;
  bool ok = checkAndInstall();
  nextCheckAt = millis() + (ok ? OTA_CHECK_INTERVAL_MS : OTA_RETRY_MS);
}

void otaCheckNow() {
  if (pending) {
    Serial.println("[OTA] Joriy proshivka hali tasdiqlanmagan, tekshiruv keyinroq");
    return;
  }
  checkScheduled = true;
  forceCheck = true;
}

void otaPrintInfo() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  long left = checkScheduled ? (long)(nextCheckAt - millis()) / 1000 : -1;
  // Versiya belgidan o'qiladi: shu murojaat belgini linker olib tashlashidan saqlaydi
  const char *ver = FW_VERSION_MARK + sizeof("XONOBOD_FW_VERSION=") - 1;
  Serial.printf("[OTA] Versiya: %.*s, bo'lim: %s, holat: %s, oxirgi tekshiruv: %s, keyingisi: %ld s\n",
                (int)strlen(ver) - 1, ver,
                running ? running->label : "?", pending ? "tasdiq kutilmoqda" : "tasdiqlangan", lastResult.c_str(),
                left < 0 ? -1L : left);
}
