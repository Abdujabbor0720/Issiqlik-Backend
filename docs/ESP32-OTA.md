# ESP32 integratsiyasi va masofadan yangilash (OTA)

Bu hujjat **tizimni ishga tushiruvchi va xizmat ko'rsatuvchi muhandis**
uchun. Uchta savolga javob beradi: qurilmaga tokenni qanday berish, yangi
proshivkani qanday yuklash va uni qanday tarqatish.

Harorat o'lchash qoidalari (chegaralar, holatlar) `README.md` da.

---

## 0. Eng avval: ishga tushirishdan oldingi majburiy shartlar

Bu uchtasi bajarilmasa, **birorta qurilma ulanmaydi**:

| Shart | Nima uchun |
|---|---|
| **HTTPS + Let's Encrypt** sertifikati | Proshivkada faqat 4 ta Let's Encrypt ildiz sertifikati bor (`firmware/include/root_ca.h`). Boshqa CA (Cloudflare, ZeroSSL, o'z-o'zini imzolagan) — TLS qo'l berishish bosqichida yiqiladi. |
| `PUBLIC_BASE_URL` = `https://<domen>` va domen `firmware/include/config.h` dagi `SERVER_HOST` bilan **aynan bir xil** | Qurilma yuklab olish manzilini `isOwnServerUrl()` bilan tekshiradi (`firmware/src/net.cpp:6`): `https://<host>/` bilan boshlanmasa yoki ichida `@` bo'lsa — **tokenni ham yubormaydi**. |
| API yo'llariga **redirect qo'yilmasin** | Qurilma redirect'ga ergashmaydi (`HTTPC_DISABLE_FOLLOW_REDIRECTS`), 3xx — xato. `http → https` umumiy redirect bo'lishi mumkin, lekin API faqat HTTPS'da **bevosita** javob berishi kerak. |

> ⚠️ Cloudflare proksisini **yoqmang**. Uning sertifikati Let's Encrypt
> emas va butun park bir zumda uziladi. Kerak bo'lsa, avval proshivkaga
> Cloudflare ildizini qo'shib, parkni yangilash kerak.

### Ikki domen — qaysi biri nima uchun

| Domen | Nima | Kim ishlatadi |
|---|---|---|
| `issiqlik.yaxshihayot.uz` | kabinet (statik React) | odamlar, brauzerdan |
| `issiqlik-api.yaxshihayot.uz` | API + WebSocket + OTA | ESP32 qurilmalari **va** kabinet |

⚠️⚠️ **Qurilmalar FAQAT `issiqlik-api.yaxshihayot.uz` bilan gaplashadi.**
Bu nom proshivkaga qotirib yozilgan (`firmware/include/config.h` dagi
`SERVER_HOST`) va `.env` dagi `PUBLIC_BASE_URL` bilan **aynan bir xil**
bo'lishi shart. Farq qilsa, OTA tekshiruvi `{"update":false}` qaytaradi
va server jurnaliga sabab yoziladi.

⚠️ Sertifikat **har ikkala** nom uchun alohida olinadi:
`certbot --nginx -d issiqlik.yaxshihayot.uz -d issiqlik-api.yaxshihayot.uz`

### nginx namunasi

```nginx
# ───────── Kabinet (statik fayllar) ─────────
server {
    listen 443 ssl http2;
    server_name issiqlik.yaxshihayot.uz;

    ssl_certificate     /etc/letsencrypt/live/issiqlik.yaxshihayot.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/issiqlik.yaxshihayot.uz/privkey.pem;

    # ⚠️ Deploy menejeri yoygan papka + `dist/`. `npm run build`
    #    natijasi aynan shu yerda bo'ladi.
    root /var/www/issiqlik-kotyol/issiqlik-frontend/dist;
    index index.html;

    # ⚠️ SPA: brauzerdagi yo'llar (/boilers/<id>) serverda fayl emas.
    #    Busiz sahifani yangilaganda 404 chiqardi.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # ⚠️ index.html KESHLANMAYDI: aks holda yangi reliz chiqqanda
    #    brauzer eski fayl nomlarini so'rab, oq ekran ko'rsatardi.
    location = /index.html {
        add_header Cache-Control "no-store";
    }
}

# ───────── API + OTA (qurilmalar shu yerga keladi) ─────────
server {
    listen 443 ssl http2;
    server_name issiqlik-api.yaxshihayot.uz;

    ssl_certificate     /etc/letsencrypt/live/issiqlik-api.yaxshihayot.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/issiqlik-api.yaxshihayot.uz/privkey.pem;

    # ⚠️⚠️ Proshivka faylini nginx SIQMASLIGI kerak: Content-Length
    #    aynan `size` ga teng bo'lishi shart, aks holda qurilma
    #    HAR BIR yangilanishni "hajm mos emas" deb rad etadi.
    gzip off;

    # ⚠️ Proshivka 1.9 MB; yuklash uchun chegara kengaytiriladi.
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        # ⚠️ Busiz barcha qurilma bitta IP (127.0.0.1) dan ko'rinadi va
        #    IP bo'yicha cheklov butun parkni bitta chelakka tiqardi.
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ⚠️ WebSocket (jonli yangilanish) uchun.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # ⚠️ 1.9 MB fayl sekin kanalda 20 soniyadan ko'p ketadi.
        proxy_read_timeout 120s;
        proxy_buffering    off;
    }
}

# ⚠️ HTTP -> HTTPS. Qurilma redirect'ga ERGASHMAYDI, lekin u baribir
#    to'g'ridan-to'g'ri https:// ga murojaat qiladi -- bu blok faqat
#    brauzerdan kirgan odam uchun.
server {
    listen 80;
    server_name issiqlik.yaxshihayot.uz issiqlik-api.yaxshihayot.uz;
    return 301 https://$host$request_uri;
}
```

---

## 0.5. Deploy menejerida sozlash

Panel maydonlari (Issiqlik-Backend uchun):

| Maydon | Qiymat |
|---|---|
| Repository URL | `https://github.com/Abdujabbor0720/Issiqlik-Backend.git` |
| Branch | `main` |
| **Root directory** | **bo'sh qoldiriladi** — backend repozitoriya ILDIZIDA, `server/` papkasida emas |
| Service name | `issiqlik-backend` |
| Service type | Node.js (yoki Auto-detect — `package.json` ildizda) |
| **Build command** | `npm ci --include=dev && npm run build` |
| **Start command** | `npm run start:prod` |
| Port | `3000` |

⚠️⚠️ **`--include=dev` SHART.** Panel `.env` dagi `NODE_ENV=production`
ni build muhitiga ham beradi, npm esa buni ko'rib `omit=dev` qo'yadi va
devDependencies'ni UMUMAN o'rnatmaydi. `@nestjs/cli` (ya'ni `nest`
buyrug'i) va `typescript` o'sha yerda — natijada build
`sh: 1: nest: not found` bilan yiqiladi. `--include=dev` shu qoidani
bekor qiladi.

⚠️ Ishga tushirish bosqichiga bu TEGMAYDI: `typeorm`, `dotenv`, `pg`
va `reflect-metadata` `dependencies` da, ya'ni migratsiya ham, ilova
ham devDependencies'siz ishlaydi.

⚠️ **Migratsiya alohida buyruq sifatida yozilmaydi.** `npm` `prestart:prod`
skriptini `start:prod` dan OLDIN o'zi ishga tushiradi va u
`migration:run:prod` ni chaqiradi. Shu tufayli migratsiya har bir
deploy va har bir qayta ishga tushishda bajariladi — unutish imkoni
yo'q. Migratsiya yiqilsa, ilova UMUMAN ishga tushmaydi: bu ataylab,
chunki eski sxema ustida ishlayotgan ilova jimgina noto'g'ri ma'lumot
ko'rsatardi.

⚠️ **`migration:run` EMAS, `migration:run:prod`.** Birinchisi `ts-node`
ga tayanadi, u esa `devDependencies` da — ishlab chiqarish o'rnatishida
(`npm ci --omit=dev`) mavjud bo'lmaydi. `:prod` varianti kompilyatsiya
qilingan `dist/config/data-source.js` bilan ishlaydi.

### Muhit o'zgaruvchilari

`.env` git'ga tushmaydi, shuning uchun ular PANELDA kiritiladi.
Ularsiz ilova ishga tushmaydi (Joi tekshiruvi to'xtatadi).

**Majburiy (5 ta):**

```
DB_USERNAME=issiqlik
DB_PASSWORD=<baza-paroli>
DB_NAME=issiqlik_db
JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_REFRESH_SECRET=<openssl rand -base64 48>
```

**Deploy uchun shart:**

```
NODE_ENV=production
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=5432
CORS_ORIGINS=https://issiqlik.yaxshihayot.uz
PUBLIC_BASE_URL=https://issiqlik-api.yaxshihayot.uz
FIRMWARE_DIR=/var/lib/issiqlik/firmware
ADMIN_LOGIN=<superadmin-login>
ADMIN_PASSWORD=<superadmin-paroli>
```

⚠️⚠️ **`FIRMWARE_DIR` DEPLOY PAPKASIDAN TASHQARIDA.** Panel har deployda
kodni qaytadan yoyadi; sukutdagi `./storage/firmware` o'sha papka
ichida bo'lgani uchun yuklangan `.bin` fayllar YO'QOLADI, bazadagi
`firmware_releases` yozuvlari esa qoladi — natijada qurilma
yangilanishni so'raganda 500 oladi. Papkani oldindan tayyorlang:

```bash
sudo mkdir -p /var/lib/issiqlik/firmware
sudo chown <ilova-foydalanuvchisi> /var/lib/issiqlik/firmware
sudo chmod 700 /var/lib/issiqlik/firmware
```

⚠️⚠️ **Deploy papkasi `/var/www` ostida.** nginx uni statik fayl
sifatida tarqatmasligiga ishonch hosil qiling: aks holda `.env`
brauzerdan o'qilib qolardi. Yuqoridagi nginx namunasida API domeni
faqat `proxy_pass` qiladi va `root` e'lon qilmaydi — shunday qoldiring.

### Birinchi ishga tushish

Bo'sh bazada tizim o'zi tayyorlanadi: migratsiyalar, 16 tuman va
`ADMIN_LOGIN`/`ADMIN_PASSWORD` dan superadmin (`bootstrap.service.ts`).
`npm run seed` faqat demo ma'lumot uchun — ishlab chiqarishda
ishlatilmaydi.

---

## 1. Qurilmani ro'yxatga olish va token berish

### Oddiy yo'l (tavsiya etiladi)

1. Montajchi platani o'rnatadi, Wi-Fi'ni sozlaydi. Qurilma serverga
   uriladi va **403** oladi — ma'lumot yozilmaydi.
2. Kabinet → **ESP32 modullari**. Tepada sariq panel chiqadi:
   «N ta notanish qurilma ulanishga urinmoqda», identifikatori bilan
   (`esp32-f42dc987e788`).
3. «Nusxa» tugmasi bilan identifikatorni oling → **Yangi modul** →
   identifikatorni qo'ying, kotyolni biriktiring → saqlang.
4. Tizim **tokenni BIR MARTA ko'rsatadi**. Uni nusxalab oling —
   keyin uni tizimdan o'qib bo'lmaydi (bazada faqat SHA-256 hash).
5. Kutish ro'yxatidagi so'rov **o'z-o'zidan yopiladi**.

### Tokenni qurilmaga yozish

Ikki usul bor, ikkalasi ham USB orqali (token hech qachon havo orqali
yuborilmaydi):

**a) Qo'lda, serial orqali** (`pio device monitor`, 115200 bod):

```
T<token>
```

Masalan: `TQx7mN2pLk9vRtY4wZ8aBc3dEf5gHj6i`
Javob: `[SET] Token: shaxsiy (Qx7m...)`

Tokenni **bekor qilish** (umumiyga qaytish): bo'sh `T` buyrug'i.

**b) Proshivka skripti bilan** — token o'zi yaratiladi va
`firmware/tokenlar.csv` ga yoziladi (**MAXFIY**, git'ga tushmaydi):

```bash
cd firmware
python3 proshivka.py 12-maktab --token
```

Keyin `tokenlar.csv` dagi tokenni kabinetdagi qurilma kartasiga kiritasiz.

### Ko'p qurilma uchun: avtomatik ro'yxatga olish

⚠️⚠️ Yuzlab plata uchun har biriga qo'lda token yozish amalda
imkonsiz: montajchi har plata uchun administratorga murojaat qilishi
kerak bo'lardi va o'rnatish ishi shu yerda to'xtardi.

Shuning uchun proshivkaga BITTA umumiy token qo'yiladi va qurilma
o'zini serverga **o'zi tanitadi**:

1. `.env` da `DEVICE_SHARED_TOKEN` to'ldiriladi
2. GitHub repozitoriyasida **Settings → Secrets and variables →
   Actions** ga AYNI qiymat `DEVICE_SHARED_TOKEN` nomi bilan qo'yiladi
3. Actions → **Proshivka (ESP32)** → *Run workflow* → yangi `.bin`
   ichida token bo'ladi (repozitoriyada token KO'RINMAYDI)
4. Montajchi platani yozadi va Wi-Fi'ni sozlaydi — **tamom**

Qurilma birinchi ulanganda server uni o'zi ro'yxatga oladi va
o'lchovlarini qabul qila boshlaydi.

⚠️⚠️ **KOTYOLGA BIRIKTIRMAYDI** va xavf aynan shu bilan cheklanadi.
Token sizib chiqsa, begona odam soxta qurilma yarata oladi — lekin
biriktirilmagan qurilmaning o'lchovi hech qaysi kotyolning holatini,
xaritasini yoki hisobotini **o'zgartirmaydi**. Eng yomon natija —
ro'yxatda keraksiz qator.

⚠️ `DEVICE_AUTO_ENROLL_MAX` (sukut 2000) — parkdagi qurilmalar soni
chegarasi. Busiz tokenni bilgan odam cheksiz soxta qurilma yaratib,
jadvalni to'ldirib qo'yardi. Chegaraga yetilganda jurnalga xato
yoziladi.

⚠️ Avtomatik yaratilgan qurilmada `note` maydoni
«Avtomatik ro'yxatga olindi (umumiy token)» bo'ladi va `boiler_id`
bo'sh — kabinetdagi «Biriktirilmagan» filtri bilan topiladi.

Mexanizmni o'chirish: `DEVICE_SHARED_TOKEN` ni bo'shatish. Shunda
eski xatti-harakat qaytadi (403 + kutish ro'yxati).

### Umumiy token haqida

Tizim **faqat shaxsiy tokenlar** bilan ishlaydi: `.env` dagi
`DEVICE_SHARED_TOKEN` sukut bo'yicha **bo'sh** va mexanizm o'chiq.

Ko'chish davri uchun (Xonobodning 14 qurilmasi hali umumiy tokenda
bo'lsa) ikkita shart birga kerak:

1. `.env` → `DEVICE_SHARED_TOKEN=<24+ belgi>`;
2. har bir qurilma uchun **alohida** `devices.allow_shared_token = true`.

Har ishlatilishida jurnalga ogohlantirish yoziladi va ro'yxatda
«umumiy token» belgisi ko'rinadi. Hammasi shaxsiy tokenga o'tgach,
`DEVICE_SHARED_TOKEN` ni bo'shatib qo'yish kerak.

> ⚠️ Nima uchun shunday qattiq: umumiy token bitta platadan o'g'irlansa,
> uning egasi **butun viloyat** nomidan soxta harorat yuborishi mumkin.

---

## 2. Yangi proshivkani yuklash

### Yig'ish

```bash
cd firmware
pio run
# natija: .pio/build/esp32dev/firmware.bin
```

Yangi reliz oldidan `firmware/include/config.h` dagi `FW_VERSION` ni
**oshirish shart**. Server versiyani fayl ichidagi
`XONOBOD_FW_VERSION=x.y.z;` belgisidan o'qiydi, qo'lda kiritilganidan
emas.

> ⚠️ Belgi nomi tarixiy sababdan `XONOBOD_` bilan boshlanadi
> (`firmware/src/ota.cpp`). Uni o'zgartirsangiz, **serverdagi
> `FW_VERSION_MARKER` ni ham** o'zgartirish kerak
> (`src/database/entities/firmware.entities.ts`) — aks holda yuklash
> «belgi topilmadi» bilan rad etiladi.

### Yuklash

Kabinet → **Proshivka (OTA)** → «Proshivka yuklash» → `.bin` faylni
tanlang.

Server quyidagilarni tekshiradi va **bittasi o'tmasa rad etadi**:

| Tekshiruv | Xato xabari |
|---|---|
| birinchi bayt `0xE9` (ESP32 obrazi) | «Bu ESP32 proshivkasi emas» |
| hajm ≤ 1 966 080 bayt (`min_spiffs` OTA bo'limi) | 413 / «Fayl juda katta» |
| ichida `XONOBOD_FW_VERSION=x.y.z;` belgisi | «belgi topilmadi» |
| belgidagi versiya kiritilgani bilan mos | «Versiya mos emas: fayl ichida …» |
| versiya takrorlanmagan | «allaqachon yuklangan» |
| aynan shu fayl boshqa raqam bilan yuklanmagan | «Aynan shu fayl … sifatida yuklangan» |

SHA-256 **serverda** hisoblanadi. Fayl web root'dan tashqarida,
`FIRMWARE_DIR` da, `chmod 600` bilan saqlanadi.

---

## 3. Tarqatish

### Majburiy tartib: 1 ta qurilma → tuman → viloyat

Kabinet → **Proshivka (OTA)** → relizdagi «Tarqatish» tugmasi.

1. **Kimga**: «Tanlangan qurilmalar» (sinov uchun eng aniq), yoki
   «Tanlangan tumanlar», «Obyekt turi bo'yicha», «Barcha qurilmalar».
2. **«Avval faqat 1 ta qurilmada sinab ko'rish»** — sukut bo'yicha
   YOQILGAN. Uni o'chirmang, to'liq sinovdan o'tmaguncha.
3. «Boshlash».

Qurilmalar **30 daqiqa ichida** yangilanishni oladi (tekshiruv oralig'i
`config.h` da qotirilgan). Shuning uchun tarqatish 30 daqiqadan ko'proq
cho'zilishi **normal**.

### Jarayonni kuzatish

«Jarayon» tugmasi har bir qurilma holatini ko'rsatadi:

```
Kutilmoqda  →  Taklif qilindi  →  O'rnatildi  →  Tasdiqlandi
                                      ↓
                               Xato / Qaytarildi
```

- **Kutilmoqda** — qurilma hali so'ramagan (30 daqiqa kutiladi);
- **Tasdiqlandi** (`ok`) — yangi proshivka ishlayapti va serverga
  ma'lumot yuborayapti. Faqat shundan keyin yangilanish muvaffaqiyatli
  hisoblanadi;
- **Qaytarildi** (`rolled_back`) — o'rnatildi, lekin ishga tushgandan
  keyin serverga ulanolmadi va bootloader eski versiyaga qaytardi.

Barcha maqsadli qurilma `ok` bo'lsa, tarqatish avtomatik «Tugadi»
holatiga o'tadi va keyingi versiyani tarqatish mumkin bo'ladi.

### To'xtatish

- **To'xtatish** (`paused`) — yangi taklif berilmaydi, keyin davom
  ettirish mumkin;
- **Bekor qilish** (`cancelled`) — tarixda qoladi, qaytarilmaydi.

Bir vaqtda **faqat bitta** faol tarqatish bo'lishi mumkin (bazada
kafolatlangan). Yangisini boshlash uchun avvalgisini to'xtatish kerak.

### Bloklash — avtomatik himoya

Tizim yaroqsiz proshivkani o'zi to'xtatadi:

| Hodisa | Natija |
|---|---|
| `rolled_back` | o'sha versiya o'sha qurilmaga **darhol** boshqa taklif qilinmaydi |
| ketma-ket 3 ta `failed` | xuddi shunday |
| `ok` | xato hisobi **nolga qaytadi** |

Bloklangan qurilmalar «Bloklangan versiyalar» bo'limida ko'rinadi.
Sababi tuzatilgach, **«Qayta urinish»** tugmasi blokni va xato hisobini
tozalaydi.

> ⚠️ Bu himoya bo'lmasa, yaroqsiz reliz cheksiz halqa yasardi: yuklab
> oladi → o'rnatadi → qaytadi → 30 daqiqadan keyin yana. Shu vaqtda
> qurilma harorat o'lchashdan ko'proq yangilanish bilan band bo'lardi.

---

## 4. Qurilma tomonidagi xavfsizlik (bilib qo'yish uchun)

Yangi proshivka **«tasdiq kutilmoqda»** holatida ishga tushadi va
tasdiqlanadi, agar:

- telemetriyaga birinchi **2xx** javob kelsa; yoki
- datchik/muassasa yo'q bo'lsa — Wi-Fi'da 3 daqiqa turgandan keyin
  hisobotga 2xx kelsa.

Wi-Fi ulangan holda **10 daqiqada** yoki umuman **1 soatda**
tasdiqlanmasa, yoki qurilma qulasa — bootloader avtomatik eski
proshivkaga qaytaradi va `rolled_back` yuboradi.

**Demak:** telemetriya endpoint'i yangi versiyani rad etsa, yangilanish
o'z-o'zidan bekor bo'ladi. Bu — server kodimizdagi xatoga qarshi oxirgi
himoya qavati.

---

## 5. Kontrakt (proshivkada qotirilgan — o'zgartirilmaydi)

### Barcha so'rovlardagi sarlavhalar

```
X-Device-Token:     <token>
X-Device-Id:        esp32-<12 kichik hex>
X-Firmware-Version: 2.1.0
```

### Telemetriya

`POST /index.php/api/integrations/telemetry` (va prefikssiz nusxa
`POST /api/integrations/telemetry`), har 60 soniyada.

```json
{"institution_id":"12-maktab","device_id":"esp32-f42dc987e788",
 "inlet_temperature_c":45.12,"outlet_temperature_c":60.50}
```

Yakka datchik ishlaganda:

```json
{"device_id":"esp32-…","temperature_c":60.50,"probe":"outlet"}
```

Javob kodlari — qurilma xatti-harakati shunga bog'liq:

| Kod | Qurilma nima qiladi |
|---|---|
| **201 / 200** | qabul qilindi; yangi proshivka aynan shu bilan tasdiqlanadi |
| **400 / 422** | o'lchovni **tashlab yuboradi** (butunlay yaroqsiz) |
| **401** | token xato |
| **403** | qurilma ro'yxatda yo'q (kutish ro'yxatiga tushadi) |
| **429 / 5xx** | **keyinroq qayta yuboradi** — o'lchov yo'qolmaydi |

### Xona (havo) harorati — QO'SHIMCHA maydon

Server tayyor. Proshivkaga qo'shilishi kerak bo'lgan YAGONA narsa — xuddi
shu telemetriya so'roviga `rooms` massivi:

```json
{"device_id":"esp32-f42dc987e788",
 "inlet_temperature_c":45.12,"outlet_temperature_c":60.50,
 "rooms":[{"key":"28ff4a2b1c000042","t":21.4},
          {"key":"28ff7d9e03000031","t":18.9}]}
```

| Maydon | Ma'nosi |
|---|---|
| `key` | Datchikning **doimiy** identifikatori. Eng yaxshisi — DS18B20 ning 64-bitli manzili (hex). Katta-kichik harf farq qilmaydi. Ruxsat: `a-z 0-9 . _ : -`, 64 belgigacha |
| `t` | Havo harorati, °C. Son yoki satr (`"21.4"`) |

Qoidalar — proshivka shularga tayanishi mumkin:

- **Xonalarni kabinetda oldindan yaratish SHART EMAS.** Noma'lum `key`
  kelsa, xona o'zi «Xona N» bo'lib paydo bo'ladi; tuman mas'uli keyin uni
  «1-sinf» deb nomlaydi. Kalit o'zgarmasa, nom va tarix saqlanadi —
  plata almashtirilsa ham (datchiklar o'sha joyda qolsa).
- **Bitta havo datchigi bo'lsa** massiv shart emas:
  `"room_temperature_c": 21.4` ham qabul qilinadi (kalit `xona`).
- **Diapazon −40…70 °C.** Undan tashqarisi (jumladan DS18B20 ning `85` va
  `-127` nosozlik qiymatlari) **jim tashlanadi** — so'rov rad etilMAYDI,
  kotyol harorati baribir yoziladi.
- **Buzuq xona qismi so'rovni buzmaydi.** Xona yuki — qo'shimcha
  ma'lumot; javob kodi faqat kotyol harorati bo'yicha (yuqoridagi jadval).
- Quvur datchiklari umuman ishlamasa-yu, xonalar kelsa — **201**
  (`status: null`). Plata faqat xonalar uchun ham o'rnatilishi mumkin.
- Bitta so'rovda **32 xonagacha**, bitta binoda **64 xonagacha**.
- Xona faqat **kotyolga biriktirilgan** qurilmadan qabul qilinadi
  (xona binoga tegishli). Biriktirilgandan keyingi birinchi signalda
  xonalar o'zi paydo bo'ladi.
- Eski proshivka (`rooms` siz) **o'zgarishsiz ishlayveradi**.

### OTA

```
GET  /ota/index.php?a=check&device_id=…&version=…&inst=…
GET  /ota/index.php?a=download&v=2.1.0
POST /ota/index.php?a=report
```

`check` javobi **tekis** obyekt bo'lishi shart (ichma-ich obyekt yoki
`\uXXXX` bo'lmasin — proshivkadagi JSON o'quvchi juda sodda):

```json
{"update":true,"version":"2.1.0",
 "url":"https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=download&v=2.1.0",
 "sha256":"<64 kichik hex>","size":1146012}
```

`download` javobi: `200`, `Content-Type: application/octet-stream`,
`Content-Length` **aynan** `size` ga teng, gzip yo'q, chunked yo'q,
redirect yo'q.

---

## 6. Tekshirish (`curl`)

```bash
TOKEN=<qurilma tokeni>
DEV=esp32-f42dc987e788
H=(-H "X-Device-Token: $TOKEN" -H "X-Device-Id: $DEV" -H "X-Firmware-Version: 2.1.0")

# 201 bo'lishi kerak (noma'lum maydon RAD ETILMAYDI)
curl -i -X POST https://issiqlik-api.yaxshihayot.uz/index.php/api/integrations/telemetry \
  -H "Content-Type: application/json" "${H[@]}" \
  -d '{"device_id":"'$DEV'","temperature_c":60.5,"probe":"outlet","extra":1}'

# {"update":false} yoki {"update":true,...}
curl -s "https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=check&device_id=$DEV&version=2.1.0" "${H[@]}"

# Content-Length = size, chunked va gzip YO'Q
curl -sI "https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=download&v=2.1.0" "${H[@]}"
```

Kutilgan natijalar: tokensiz → **401**; begona `device_id` → **403**;
`probe` va noma'lum maydon → **201**; harorat `-127` → **422**;
`check` javobida `\/` **yo'q**; `download` hajmi aniq.

---

## 7. Tez-tez uchraydigan muammolar

| Belgi | Sabab | Yechim |
|---|---|---|
| `check` doim `{"update":false}` | `PUBLIC_BASE_URL` `http://` bilan boshlanadi | `.env` da `https://<domen>` qilib qo'yish. Server jurnalida aniq xato yoziladi |
| Yangilanish har safar «hajm mos emas» | javob siqilgan (gzip/chunked) | nginx'da `gzip off`; NestJS'da `/ota/index.php` uchun kompressiya allaqachon o'chirilgan |
| Qurilma 403 oladi | ro'yxatga kiritilmagan | Kabinet → ESP32 modullari → sariq panel |
| Harorat kelmaydi, lekin OTA tekshiruvi ishlaydi | datchik nosoz | «Chiqish datchigi nosoz» ogohlantirishi; datchikni almashtirish |
| Holat «faol», lekin bino sovuq | suv aylanmayapti | «Suv aylanmayapti» ogohlantirishi; nasos/ventilni tekshirish. Chegara: Sozlamalar → sirkulyatsiya chegarasi (sukut 3 °C) |
| TLS xatosi | sertifikat Let's Encrypt emas | sertifikatni almashtirish yoki `root_ca.h` ga yangi ildiz qo'shib, parkni yangilash |

---

## 8. Bu muhitda tekshirilmagan narsalar

To'g'ri bo'lishi uchun ochiq aytiladi:

- **Proshivka kompilyatsiya qilinmagan.** Ishlab chiqish muhitida
  PlatformIO ham, C++ kompilyatori ham yo'q edi. Kod o'zgarishlari
  qo'lda tekshirilgan (qavslar balansi, satrlar), lekin `pio run` ni
  **ishga tushirishdan oldin siz bajarishingiz kerak**.
- **Haqiqiy qurilma bilan sinov o'tkazilmagan.** Server tomoni `curl`
  bilan to'liq sinovdan o'tdi (yuklash validatori, `check`, `download`
  sarlavhalari, `report`, bloklash, tarqatish jarayoni), lekin bu
  haqiqiy ESP32 o'rnini bosmaydi.
- **HTTPS sinab ko'rilmagan**: ishlab chiqish muhitida sertifikat yo'q.
  `http://` ga faqat `NODE_ENV=development` da ruxsat berilgan va bu
  holatda jurnalga ogohlantirish yoziladi.

Shuning uchun **birinchi tarqatish albatta 1 ta qurilmada** bo'lishi
kerak.
