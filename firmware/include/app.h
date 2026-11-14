#pragma once
// Modullar (main.cpp, net.cpp, ota.cpp) o'rtasidagi umumiy e'lonlar.
#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>

extern Preferences prefs;
extern String deviceId;       // esp32-<mac>
extern String deviceToken;    // shaxsiy token (NVS "tok") yoki umumiy API_TOKEN
extern String institutionId;  // bo'sh bo'lishi mumkin (tanlanmagan)

void lcdShow(const String &l1, const String &l2);

// ---- net.cpp ----
// HTTPS ulanishni ochadi: faqat https://SERVER_HOST/... manzillariga, Let's Encrypt ildizlari bilan,
// qurilma sarlavhalari (X-Device-Token, X-Device-Id, X-Firmware-Version) qo'shiladi.
bool httpsBegin(HTTPClient &http, NetworkClientSecure &tls, const String &url, uint32_t timeoutMs);
// URL bizning serverimizga tegishlimi (OTA yuklab olish manzilini tekshirish uchun)
bool isOwnServerUrl(const String &url);
// Kichik JSON javobdan qiymat olish (faqat o'z serverimiz javoblari uchun)
String jsonString(const String &json, const char *key);
long jsonNumber(const String &json, const char *key, long def);
bool jsonBool(const String &json, const char *key);
String jsonEscape(const String &s);

// ---- ota.cpp ----
void otaSetup();
void otaLoop(bool wifiConnected);
void otaTelemetryResult(int code);  // har bir telemetriya natijasi: 2xx bo'lsa yangi proshivka tasdiqlanadi
void otaCheckNow();      // serial 'u'
bool otaBusy();          // yangi proshivka hali tasdiqlanmagan
void otaPrintInfo();
