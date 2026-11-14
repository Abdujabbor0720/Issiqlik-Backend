// HTTPS yordamchilari va kichik JSON o'qish
#include "app.h"
#include "config.h"
#include "root_ca.h"

static const char OWN_PREFIX[] = "https://" SERVER_HOST "/";

bool isOwnServerUrl(const String &url) {
  return url.startsWith(OWN_PREFIX) && url.indexOf('@') < 0;
}

bool httpsBegin(HTTPClient &http, NetworkClientSecure &tls, const String &url, uint32_t timeoutMs) {
  if (!isOwnServerUrl(url)) return false;  // http:// yoki begona domen - token hech qachon tashqariga chiqmaydi
  tls.setCACert(ROOT_CA_PEM);
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(tls, url)) return false;
  if (deviceToken.length()) http.addHeader("X-Device-Token", deviceToken);
  http.addHeader("X-Device-Id", deviceId);
  http.addHeader("X-Firmware-Version", FW_VERSION);
  return true;
}

String jsonEscape(const String &s) {
  String o;
  o.reserve(s.length() + 4);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c < 0x20) o += ' ';
    else o += c;
  }
  return o;
}

// "key": dan keyingi qiymat boshlanishi (bo'sh joylar o'tkazib yuborilgan), topilmasa -1
static int valueStart(const String &json, const char *key) {
  String k = String("\"") + key + "\"";
  int i = json.indexOf(k);
  if (i < 0) return -1;
  i = json.indexOf(':', i + k.length());
  if (i < 0) return -1;
  i++;
  while (i < (int)json.length() && isspace((unsigned char)json[i])) i++;
  return i;
}

String jsonString(const String &json, const char *key) {
  int i = valueStart(json, key);
  if (i < 0 || i >= (int)json.length() || json[i] != '"') return String();
  String out;
  for (i++; i < (int)json.length(); i++) {
    char c = json[i];
    if (c == '"') return out;
    if (c == '\\' && i + 1 < (int)json.length()) {
      char n = json[++i];
      out += (n == 'n') ? '\n' : (n == 't') ? '\t' : n;  // \/ \" \\ ; \uXXXX bizning javoblarda yo'q
    } else {
      out += c;
    }
  }
  return String();  // yopilmagan qator
}

long jsonNumber(const String &json, const char *key, long def) {
  int i = valueStart(json, key);
  if (i < 0 || i >= (int)json.length()) return def;
  if (json[i] != '-' && !isdigit((unsigned char)json[i])) return def;
  return strtol(json.c_str() + i, nullptr, 10);
}

bool jsonBool(const String &json, const char *key) {
  int i = valueStart(json, key);
  return i >= 0 && json.startsWith("true", i);
}
