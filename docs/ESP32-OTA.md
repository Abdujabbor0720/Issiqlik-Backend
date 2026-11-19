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

### «Yangi qurilmalar» — bir bosishda ro'yxatga olish (asosiy yo'l)

1. Montajchi platani o'rnatadi va telefondan sozlash sahifasida Wi-Fi,
   **tuman**, **obyekt turi** va **muassasa nomini** tanlaydi. Qurilma
   serverga uriladi va **403** oladi — o'lchov yozilmaydi.
2. Kabinet → **ESP32 modullari** → «Yangi qurilmalar»: `device_id`,
   tur (kotyol/xona), plata aytgan tuman / obyekt turi / muassasa, IP va
   oxirgi vaqt ko'rinadi. Tuman mas'uli faqat o'z tumanini aytganlarini
   ko'radi (API darajasida).
3. **«Ro'yxatga olish»** — bitta bosish. Server:
   * qurilma so'nggi so'rovda yuborgan **o'z tokenini** qabul qiladi
     (bazada faqat SHA-256 hash) — plata o'zgarishsiz ishlay boshlaydi;
   * tumanni, obyekt turini va muassasani plata aytganidan oladi
     (muassasa tuman katalogidan topiladi yoki katalogga qo'shiladi);
   * istasangiz, ro'yxatga olishda boshqa tuman / muassasa / kotyolni
     tanlash yoki kalitni qo'lda kiritish mumkin.
4. Kutish ro'yxatidagi so'rov **o'z-o'zidan yopiladi**.

⚠️ **Avtomatik ro'yxatga olish YO'Q.** Ro'yxatda yo'q `device_id` har doim
403 oladi — hatto to'g'ri umumiy token bilan ham.

⚠️ Bir xil `device_id` bilan **turli tokenlar** kelsa («token ziddiyati»),
bir bosishda ro'yxatga olinmaydi: kimdir haqiqiy plata identifikatoridan
foydalanayotgan bo'lishi mumkin. Bunda kalit qo'lda kiritiladi.

**Qo'lda qo'shish** ham qoladi: **Yangi modul** → identifikator, tur,
tuman → saqlang. «Mavjud API kalit» maydoni bo'sh qolsa, tizim tokenni
yaratadi va uni **BIR MARTA ko'rsatadi**.

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

### Ko'p qurilma uchun: umumiy token

Yuzlab plata uchun proshivkaga BITTA umumiy token (`DEVICE_SHARED_TOKEN`)
qo'yish mumkin. Bunday qurilma ham birinchi so'rovda **403** oladi va
«Yangi qurilmalar» ga tushadi (token turi — «umumiy»). Ro'yxatga
olinganda unga umumiy token bilan ishlashga ruxsat beriladi
(`allow_shared_token`). «Qurilmalar» sahifasidagi «token turi» ustuni
qaysi qurilma hali umumiy tokenda ekanini ko'rsatadi.

⚠️ `DEVICE_AUTO_ENROLL_MAX` endi ishlatilmaydi (eski `.env` da qolsa —
e'tiborsiz qoldiriladi).

### Umumiy token haqida

Tizim **faqat shaxsiy tokenlar** bilan ishlaydi: `.env` dagi
`DEVICE_SHARED_TOKEN` sukut bo'yicha **bo'sh** va mexanizm o'chiq.

Ko'chish davri uchun (eski paneldan ko'chgan qurilmalar hali umumiy
tokenda bo'lsa) ikkita shart birga kerak:

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

Server versiyani va modul turini fayl ICHIDAGI belgilardan o'qiydi
(kotyol v2.1.0, xona v1.1.0 proshivkasida qotirilgan):

```
ANDIJON_FW_VERSION=2.1.0;
ANDIJON_FW_MODULE=kotyol;      (yoki xona)
```

* Versiya umumiy ifoda bilan izlanadi: `([A-Z]+)_FW_VERSION=(\d+\.\d+\.\d+);`,
  `ANDIJON` prefiksi ustun. Eski binarlardagi boshqa prefiksli belgi
  (masalan v2.0.0 dagi) ham o'qiladi.
* Tur `ANDIJON_FW_MODULE` belgisidan olinadi. Belgisiz eski faylda turni
  **yuklovchi qo'lda tanlaydi** — panel taklif qiladi: 2.x → kotyol,
  1.x → xona. Belgi bor faylda tanlov belgiga zid bo'lsa — rad.
* Yuklashdan oldin `POST /api/v1/firmware/releases/inspect` faylni
  saqlamasdan tekshiradi (versiya, belgidagi tur, taklif).

> ⚠️ Repodagi `firmware/` papkasi — ESKI kotyol proshivkasi manbasi
> (`institution_id`, eski versiya belgisi, `X-Device-Type` yo'q). Yangi
> proshivkalar (kotyol v2.1.0, xona v1.1.0) alohida yig'iladi.

### Yuklash

Kabinet → **Proshivka (OTA)** → «Proshivka yuklash» → `.bin` faylni
tanlang.

Server quyidagilarni tekshiradi va **bittasi o'tmasa rad etadi**:

| Tekshiruv | Xato xabari |
|---|---|
| birinchi bayt `0xE9` (ESP32 obrazi) | «Bu ESP32 proshivkasi emas» |
| hajm ≤ 1 966 080 bayt (`min_spiffs` OTA bo'limi) | 413 / «Fayl juda katta» |
| ichida `ANDIJON_FW_VERSION=x.y.z;` (yoki eski prefiksli) belgi | «versiya belgisi topilmadi» |
| `ANDIJON_FW_MODULE=kotyol\|xona;` yoki qo'lda tanlangan tur | «turini qo'lda tanlang» / «belgiga zid» |
| belgidagi versiya kiritilgani bilan mos | «Versiya mos emas: fayl ichida …» |
| (tur, versiya) juftligi takrorlanmagan | «allaqachon yuklangan» (409) |
| aynan shu fayl boshqa raqam bilan yuklanmagan | «Aynan shu fayl … sifatida yuklangan» |

SHA-256 **serverda** hisoblanadi. Fayl web root'dan tashqarida,
`FIRMWARE_DIR` da, `chmod 600` bilan saqlanadi.

---

## 3. Tarqatish

### Majburiy tartib: 1 ta qurilma → bosqichlar → hammasi

Kabinet → **Proshivka (OTA)** → relizdagi «Tarqatish» tugmasi.

1. **Modul turi** — relizning o'zidan (`kotyol` yoki `xona`) va bu
   MAJBURIY filtr: kotyol `.bin` hech qachon xona platasiga taklif
   qilinmaydi (va aksincha).
2. **Kimga**: «Butun viloyat», «Tanlangan tumanlar», «Obyekt turi
   bo'yicha» yoki «Tanlangan qurilmalar». Tuman va obyekt turi —
   qurilmaning amaldagi joylashuvi (kotyolga ulangan bo'lsa kotyolniki,
   aks holda paneldagi o'z tumani va muassasasi).
3. **Bosqich**: tarqatish sukut bo'yicha **1 ta qurilmada sinov** bilan
   boshlanadi (`maxDevices = 1`). Sinov `ok` bilan tasdiqlangach
   «Keyingi bosqich»: 10 → 50 → cheklovsiz
   (`PATCH /api/v1/firmware/rollouts/:id/limit`).
4. «Boshlash».

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

Bir vaqtda **har modul turi uchun bitta** faol tarqatish bo'lishi mumkin
(bazada kafolatlangan): kotyol va xona modullari mustaqil yangilanadi.

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

Kotyol moduli **v2.1.0** va xona moduli **v1.1.0**. Eski qurilmalar
(kotyol v2.0.0, xona v1.0.0) ham ishlaydi — ular USB yoki OTA orqali
yangilanguncha ikkala format qabul qilinadi.

### Sarlavhalar (barcha so'rovlarda)

```
X-Device-Token:     <token>                 (paneldagi «Mavjud API kalit»)
X-Device-Id:        esp32-<12 kichik hex>   (STA MAC)
X-Firmware-Version: 2.1.0
X-Device-Type:      kotyol | xona           (YANGI; eski proshivkada YO'Q)
```

`X-Device-Type` bo'lmasa, tur tanadan aniqlanadi: `room_temperature_c`
bor → `xona`, aks holda `kotyol`. Tur `devices.device_type` ga yoziladi:

* **aytilgan** tur (sarlavha / OTA'dagi `type=`) yoziladi; avvalgisidan
  farq qilsa — jurnalga ogohlantirish va audit yozuvi;
* tanadan **xulosa qilingan** tur saqlanganini O'ZGARTIRMAYDI, faqat
  ogohlantiradi. Sabab: datchigi uzilgan eski xona moduli
  `room_temperature_c` yubormay qoladi; xulosa yozilsa, keyingi OTA
  tekshiruvida unga KOTYOL `.bin` taklif qilinardi.

Qurilma faqat HTTPS bilan ishlaydi va redirect'ga ergashmaydi (3xx =
xato). TLS — Let's Encrypt (ISRG Root X1/X2, YE/YR). Boshqa CA'ga
o'tilsa qurilmalar ulana olmaydi.

### Telemetriya

`POST /index.php/api/integrations/telemetry` (prefikssiz nusxa:
`POST /api/integrations/telemetry`), `Content-Type: application/json`,
har 60 soniyada.

```json
{"device_id":"esp32-f42dc987e788","district":"asaka","object_type":"school",
 "institution_name":"12-maktab","inlet_temperature_c":45.12,"outlet_temperature_c":60.50}
```

Datchikning bittasi ishlamasa: `"temperature_c":60.50,"probe":"outlet"`
(yoki `"inlet"`). Grafikda bunday o'lchov **o'z chizig'iga** tushadi.

Xona moduli:

```json
{"device_id":"esp32-b0cbd889a310","district":"asaka","object_type":"school",
 "institution_name":"12-maktab","room_temperature_c":21.4}
```

`"humidity": 45.0` (0…100 %) ham qabul qilinadi va saqlanadi
(qurilmada oxirgi qiymat + telemetriya qatori).

Qoidalar:

| Qoida | Natija |
|---|---|
| `district`, `object_type`, `institution_name` | IXTIYORIY |
| eski `institution_id` (`maktab-4`) | qabul qilinadi, alohida saqlanadi (nom emas) |
| noma'lum maydon | **rad etilmaydi** |
| noma'lum `district` / `object_type` kaliti | **rad etilmaydi**, maydon e'tiborsiz (jurnalda) |
| `measured_at` | o'qilmaydi — SERVER vaqti |
| kotyol harorati −55…125 °C dan tashqari | **422** |
| xona harorati −40…80 °C dan tashqari | **422** |
| harorat umuman yo'q | **422** |

Javob kodlari — qurilma xatti-harakati shunga bog'liq:

| Kod | Ma'nosi |
|---|---|
| **201** (`/api/data` da 200) | qabul qilindi; yangi proshivka aynan shu bilan tasdiqlanadi |
| **400 / 422** | yaroqsiz |
| **401** | token xato yoki yo'q |
| **403** | qurilma ro'yxatda yo'q → «Yangi qurilmalar» ro'yxatiga tushadi |
| **429 / 5xx** | qurilma keyinroq qayta urinadi |

### Joylashuv — PANELDAN, plata faqat TAKLIF qiladi

Qurilma ↔ muassasa bog'lanishi faqat `device_id` orqali, paneldagi
qurilmalar jadvalidan olinadi. Plata yuborgan tuman / obyekt turi /
muassasa nomiga ko'r-ko'rona ishonilmaydi:

* panelda shu maydon **bo'sh** bo'lsa — **taklif** sifatida saqlanadi
  (`devices.reported_*`) va «Qurilmalar» sahifasida «Tasdiqlash»
  tugmasi bilan ko'rinadi (`POST /api/v1/devices/:id/location/confirm`);
* panelda **to'la** va farq qilsa — e'tiborsiz qoldiriladi, jurnalga
  ogohlantirish yoziladi. Panel hech qachon plata qiymati bilan
  almashtirilmaydi.

Amaldagi joylashuv: kotyolga ulangan bo'lsa kotyolniki, aks holda
qurilmaning paneldagi tumani va muassasasi.

### Tumanlar katalogi (kalitlar proshivkada qotirilgan)

| key | nom | | key | nom |
|---|---|---|---|---|
| `andijon-sh` | Andijon shahri | | `jalaquduq` | Jalaquduq tumani |
| `xonobod-sh` | Xonobod shahri | | `xojaobod` | Xo'jaobod tumani |
| `andijon` | Andijon tumani | | `qorgontepa` | Qo'rg'ontepa tumani |
| `asaka` | Asaka tumani | | `marhamat` | Marhamat tumani |
| `baliqchi` | Baliqchi tumani | | `oltinkol` | Oltinko'l tumani |
| `boz` | Bo'ston tumani | | `paxtaobod` | Paxtaobod tumani |
| `buloqboshi` | Buloqboshi tumani | | `shahrixon` | Shahrixon tumani |
| `izboskan` | Izboskan tumani | | `ulugnor` | Ulug'nor tumani |

Bazada `districts.key` (noyob). Eski xona proshivkasining `boston`
kaliti `boz` deb qabul qilinadi. **Obyekt turlari**: `school`,
`kindergarten`, `college`, `clinic`, `hospital`, `admin`,
`residential`, `other` («Kataloglar → Obyekt turlari»).

### Xonalar massivi (kotyol modulining qo'shimcha datchiklari)

`"rooms":[{"key":"28ff4a2b1c000042","t":21.4}, …]` — har `key` alohida
xona bo'lib avtomatik yaratiladi (faqat kotyolga ulangan modulda).
Massivdagi bitta yaroqsiz qiymat qolganlarini rad etmaydi.

### OTA

```
GET  {OTA_URL}?a=check&device_id=esp32-…&version=2.1.0&type=kotyol&inst=12-maktab
GET  {OTA_URL}?a=download&v=2.1.1
POST {OTA_URL}?a=report
```

`OTA_URL` = `https://issiqlik-api.yaxshihayot.uz/ota/index.php`.

* `type` — YANGI. Bo'lmasa (eski proshivka) `devices.device_type` olinadi.
* `inst` — URL-encoded erkin matn, identifikator sifatida ISHLATILMAYDI.
* **Proshivka faqat O'Z turidagi qurilmaga** taklif qilinadi va beriladi.
* Har so'rovda `firmware_version`, `device_type`, `last_check_at`,
  `last_ip` yangilanadi.

`check` javobi — tekis JSON, `\uXXXX` siz va `/` ekranlanmagan:

```json
{"update":false}
{"update":true,"version":"2.1.1","url":"https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=download&v=2.1.1","sha256":"<64 hex>","size":1146012}
```

`url` aynan `PUBLIC_BASE_URL` (`https://issiqlik-api.yaxshihayot.uz`)
bilan boshlanadi va ichida `@` bo'lmaydi — server buni har javobda
tekshiradi, ishlab chiqarishda esa `PUBLIC_BASE_URL` ishga tushishda
tekshiriladi.

`download`: `200`, `Content-Type: application/octet-stream`,
`Content-Length` **aynan** `size`, gzip / chunked / redirect yo'q.
`.bin` fayllar `FIRMWARE_DIR` da — web root'dan tashqarida.

`report` tanasi:
`{"device_id","version","institution_id","status","target","message"}`;
`institution_id` endi muassasa NOMI (erkin matn). Holatlar:
`installed | ok | failed | rolled_back`. Javob — `200 {"ok":true}`.

## 6. Tekshirish (`curl`)

```bash
TOKEN=<qurilma tokeni>
DEV=esp32-f42dc987e788
H=(-H "X-Device-Token: $TOKEN" -H "X-Device-Id: $DEV" -H "X-Firmware-Version: 2.1.0" -H "X-Device-Type: kotyol")

# 201 bo'lishi kerak (noma'lum maydon RAD ETILMAYDI)
curl -i -X POST https://issiqlik-api.yaxshihayot.uz/index.php/api/integrations/telemetry \
  -H "Content-Type: application/json" "${H[@]}" \
  -d '{"device_id":"'$DEV'","district":"asaka","object_type":"school","institution_name":"12-maktab","temperature_c":60.5,"probe":"outlet","extra":1}'

# {"update":false} yoki {"update":true,...}
curl -s "https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=check&device_id=$DEV&version=2.1.0&type=kotyol&inst=12-maktab" "${H[@]}"

# Content-Length = size, chunked va gzip YO'Q
curl -sI "https://issiqlik-api.yaxshihayot.uz/ota/index.php?a=download&v=2.1.0" "${H[@]}"
```

Kutilgan natijalar: tokensiz → **401**; begona `device_id` → **403**
(va «Yangi qurilmalar» da paydo bo'ladi); `probe`, noma'lum maydon yoki
noma'lum tuman kaliti → **201**; eski format (`institution_id`,
`X-Device-Type` siz) → **201**; kotyol `130` / xona `85` → **422**;
`check` javobida `\/` **yo'q**; `download` hajmi aniq.

Avtomatik tekshiruv: `npm run test:e2e` (alohida `issiqlik_e2e` bazasida).

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
