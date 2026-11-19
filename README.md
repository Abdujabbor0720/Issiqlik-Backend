# Andijon viloyati issiqlik monitoring tizimi — backend

Andijon viloyatining 16 ta tumani va shahridagi **qozonxonalar (kotyollar)**
va **xona haroratini** ESP32 modullari orqali real vaqtda kuzatish tizimi.

| | |
|---|---|
| Panel | https://issiqlik.yaxshihayot.uz (frontend: `../Issiqlik-Frontend`) |
| API | https://issiqlik-api.yaxshihayot.uz |
| Stek | TypeScript · NestJS 11 · PostgreSQL · TypeORM · Socket.IO |
| Qurilmalar | kotyol moduli v2.1.0 (2× DS18B20), xona moduli v1.1.0; eski v2.0.0 / v1.0.0 ham ishlaydi |

Qurilma kontrakti, OTA va TLS talablari — **[docs/ESP32-OTA.md](docs/ESP32-OTA.md)**.

---

## 1. Tezkor ishga tushirish

```bash
npm install
cp .env.example .env

npm run db:setup       # PostgreSQL klasteri + baza (sudo KERAK EMAS)
npm run migration:run  # sxema (tumanlar kaliti, MFY va muassasalar katalogi ham)
npm run seed           # demo: 16 tuman + kotyollar + 48 soatlik telemetriya
npm run start:dev
```

Lokal klaster: port `5442`, ma'lumot `~/.local/share/issiqlik/pgdata`.
Kompyuter qayta yoqilgach `npm run pg:start` kerak (`pg:stop`,
`pg:status`, `pg:psql` ham bor).

| Manzil | Nima |
|---|---|
| `/api/v1` | REST API (`/api/v1/docs` — Swagger, faqat ishlab chiqishda) |
| `POST /index.php/api/integrations/telemetry` | qurilma telemetriyasi (prefikssiz nusxa ham bor) |
| `GET/POST /ota/index.php` | OTA: `a=check`, `a=download`, `a=report` |
| `POST /api/data` | eng eski `modul1` proshivkasi |
| `ws://…/realtime` | jonli yangilanish (Socket.IO) |

**Birinchi kirish:** `.env` dagi `ADMIN_LOGIN` / `ADMIN_PASSWORD` (faqat
bazada `super_admin` yo'q bo'lsa o'qiladi). Haqiqiy parolni bu faylga
yozmang. Demo tuman mas'uli (faqat `npm run seed` bilan):
`operator.demo` / `operator2026` — Asaka tumani.

---

## 2. Viloyat tuzilmasi

```
Viloyat ── Tuman (districts.key) ── MFY (mahallas)
                 └── Muassasa (organizations: district_key, object_type, mahalla_id?)
                          └── Kotyol (boilers) ── Qurilmalar (devices: kotyol | xona)
```

* **Tuman kaliti** (`districts.key`: `andijon-sh`, `xonobod-sh`, `boz`,
  `asaka`, …) — proshivkada qotirilgan, qurilma telemetriyada aynan shuni
  yuboradi. Ichki UUID `id` va eski `code` o'zgarmagan: ularga ko'p jadval
  ishora qiladi.
* **Muassasalar katalogi tuman bo'yicha**: «12-maktab» har tumanda bor,
  nom yagonaligi tuman ichida. Avvalgi umumiy ro'yxatdagi yozuvlar
  o'chirilmagan — migratsiya har birini o'zini ishlatgan kotyollar
  tumaniga biriktirgan (bir nechta tumanda ishlatilgani har tuman uchun
  alohida yozuvga ajratilgan).
* **Obyekt turlari**: `school`, `kindergarten`, `college`, `clinic`,
  `hospital`, `admin`, `residential`, `other`.

### Yangi tuman qo'shish

Faqat ma'muriy o'zgarishda. Kalit **proshivka menyusidagi kalit bilan
aynan bir xil** bo'lishi va keyin o'zgarmasligi shart:

```http
POST /api/v1/geo/districts            (ruxsat: settings.update — bosh administrator)
{ "key": "yangi-tuman", "name": "Yangi tumani", "kind": "district",
  "centerLat": 40.78, "centerLng": 72.34 }
```

Chegara (xarita ko'pburchagi) keyin `src/database/seeds/data/andijon-districts.geojson`
ga qo'shiladi. Proshivka menyusiga yangi kalit qo'shilmaguncha qurilma
uni yubora olmaydi — panelda qo'lda tanlanadi.

### Yangi obyekt (muassasa), obyekt turi va MFY qo'shish

Panel → **Kataloglar**:

* **Muassasalar** — nom, tuman, obyekt turi, ixtiyoriy MFY
  (`POST /api/v1/catalogs/organizations`
  `{ name, districtKey, objectTypeId, mahallaId? }`). MFY muassasa
  tumanidan bo'lishi shart.
* **Obyekt turlari** — kalit (`sport_school`) va nom. Kalit keyin
  o'zgarmaydi; qurilma `object_type` da shu kalitni yuboradi.
* **MFYlar** — qo'lda (`POST /api/v1/catalogs/mahallas { name, districtKey }`)
  yoki fayldan:

```bash
npm run import:mfy -- --file andijon-tumanlar-mfylar.json          # sinov — hech narsa yozilmaydi
npm run import:mfy -- --file andijon-tumanlar-mfylar.json --apply  # yozish
```

Fayl shakli `[{ "tuman": "Asaka tumani", "mfylar": ["…", "…"] }]`. Tuman
nomi kalitga moslanadi («Andijon shahri» → `andijon-sh`, «Bo'ston tumani»
yoki «Bo'z tumani» → `boz`); tanilmagan nomlar hisobotda chiqadi. Import
idempotent: qayta ishga tushirilsa takror yozmaydi.

Qurilma ro'yxatga olinganda yoki joylashuv taklifi tasdiqlanganda plata
yuborgan muassasa nomi katalogdan topiladi, yo'q bo'lsa katalogga
qo'shiladi.

---

## 3. Rollar: viloyat admini va tuman mas'uli

| Rol | Ko'radi |
|---|---|
| `super_admin`, `admin` (viloyat admini) | hammasini |
| `operator` (**tuman mas'uli**) | faqat o'z tumani: kotyollar, qurilmalar, «Yangi qurilmalar», grafiklar, dashboard, muassasa/MFY katalogi, eksport |
| `viewer` | hammasini, faqat o'qish |

Chegara **API darajasida**, `where` shartida — UI'da yashirish emas.
Begona tuman qurilmasi so'ralsa `404` qaytadi (mavjudligi ham oshkor
qilinmaydi). Buni `npm run test:e2e` tekshiradi.

### Tuman mas'ulini tayinlash

Panel → **Tuman mas'ullari** → tumanni tanlash → login, parol, F.I.Sh.
Yoki API:

```http
POST /api/v1/users
{ "login": "masul.asaka", "password": "…", "fullName": "…",
  "role": "operator", "districtId": "<tuman id — GET /api/v1/geo/districts>" }
```

Bir tumanda bir nechta mas'ul bo'lishi mumkin. Almashganda eskisi
o'chirilmaydi, faolsizlantiriladi: audit jurnalidagi shaxsi saqlanadi.
Foydalanuvchi o'zidan yuqori yoki teng rol bera olmaydi.

---

## 4. Yangi qurilmani ro'yxatga olish

1. Montajchi platani o'rnatadi va telefondan sozlash sahifasida Wi-Fi,
   tuman, obyekt turi va muassasa nomini tanlaydi.
2. Qurilma serverga uriladi va **403** oladi. U panelda **ESP32 modullari
   → «Yangi qurilmalar»** ro'yxatiga tushadi: `device_id`, tur (kotyol /
   xona), plata aytgan tuman / obyekt turi / muassasa, IP, oxirgi vaqt.
3. **«Ro'yxatga olish»** — bitta bosish
   (`POST /api/v1/devices/pending/:id/register`). Qurilma yuborgan token
   qabul qilinadi (plata o'zgarishsiz ishlay boshlaydi), joylashuv plata
   aytganidan olinadi; xohlasangiz boshqa tuman / muassasa / kotyol yoki
   kalitni qo'lda tanlaysiz.
4. Kotyol moduli kotyolga, xona moduli binoning kotyoliga biriktiriladi
   (bitta kotyolga bitta kotyol moduli, xona modullari — istalgancha).

**Avtomatik ro'yxatga olish yo'q** — ro'yxatda yo'q `device_id` har doim
403 oladi. Bir xil `device_id` bilan turli tokenlar kelsa, bir bosishda
ro'yxatga olinmaydi (kalit qo'lda kiritiladi).

**Joylashuv taklifi.** Plata yuborgan tuman / obyekt turi / muassasa
panelni hech qachon o'zgartirmaydi: panelda bo'sh maydon bo'lsa — taklif
(«Qurilmalar» sahifasida «Tasdiqlash», `POST /api/v1/devices/:id/location/confirm`),
to'la bo'lsa — e'tiborsiz, jurnalga ogohlantirish.

**Qurilmalar sahifasi**: `device_id`, turi, tuman / obyekt turi /
muassasa, proshivka versiyasi, oxirgi telemetriya (5 daqiqadan eski —
«oflayn»), oxirgi OTA holati, token turi. Filtrlar: tuman, tur, holat,
versiya (`GET /api/v1/devices?districtId&deviceType&status=online|offline&version`).
Grafik: `GET /api/v1/telemetry/devices/:id/series` — kotyolda kirish/chiqish,
xonada xona harorati (va namlik).

---

## 5. Proshivka: yuklash va tur bo'yicha tarqatish

### Yuklash

Panel → **Proshivka (OTA)** → «Yuklash» → `.bin`. Server tekshiradi:

* birinchi bayt `0xE9`, hajm ≤ 1 966 080 bayt;
* versiya `ANDIJON_FW_VERSION=x.y.z;` belgisidan (umumiy ifoda
  `([A-Z]+)_FW_VERSION=…;`, `ANDIJON` ustun — eski prefiksli belgi ham o'qiladi);
* tur `ANDIJON_FW_MODULE=kotyol;` / `xona;` belgisidan. Belgisiz eski
  faylda turni yuklovchi tanlaydi (taklif: 2.x → kotyol, 1.x → xona);
* SHA-256 serverda hisoblanadi; (tur, versiya) juftligi ikki marta
  yuklanmaydi.

`.bin` fayllar `FIRMWARE_DIR` da (web root va deploy papkasidan tashqarida
— ichida umumiy token bo'lishi mumkin).

### Tarqatish

«Tarqatish» → **modul turi relizdan olinadi va majburiy filtr** → maqsad:
butun viloyat, tanlangan tumanlar, obyekt turi yoki tanlangan qurilmalar.

* Sukut — **1 ta qurilmada sinov**. Sinov `ok` bilan tasdiqlangach
  «Keyingi bosqich»: 10 → 50 → hammasi.
* «To'xtatish» — yangi taklif berilmaydi, keyin davom ettiriladi.
* Qurilma `rolled_back` yoki ketma-ket 3 marta `failed` yuborsa, o'sha
  versiya unga boshqa taklif qilinmaydi; panelda «Qayta urinish» blokni
  olib tashlaydi.
* Kotyol `.bin` hech qachon xona platasiga taklif qilinmaydi (va aksincha):
  qurilmaning turi `type=` / `X-Device-Type` dan, aytilmasa bazadan olinadi.

---

## 6. Kotyol holati — asosiy qoida

Chiqish harorati chegaralar bilan solishtiriladi (chegaralar —
**Sozlamalar** sahifasida, `.env` dagisi faqat boshlang'ich):

| Harorat | Holat |
|---|---|
| `≥ 50 °C` | faol ishlayotgan |
| `40 – 50 °C` | o'rta ishlayotgan |
| `20 – 40 °C` | ishlamayotgan |
| `< 20 °C` yoki signal yo'q | aloqa yo'q |

Formula bitta joyda: `src/helpers/boiler-status.helper.ts`. O'tgan
o'lchovlarga holat muhrlangan.

**Dashboard**: viloyat bo'yicha umumiy ko'rinish, tuman va obyekt turi
filtri (`districtIds`, `objectTypeIds`), tumanlar kesimi
(`GET /api/v1/dashboard/districts`): onlayn/oflayn qurilmalar, me'yordan
past haroratli kotyollar, ochiq ogohlantirishlar.

---

## 7. Buyruqlar va testlar

```bash
npm run build            # dist/
npm run typecheck
npm test                 # unit testlar
npm run test:e2e         # e2e: alohida «issiqlik_e2e» bazasida, spetsifikatsiyadagi holatlar
npm run migration:run    # migratsiyalar
npm run seed             # demo ma'lumot (idempotent)
npm run import:mfy -- --file <json> [--apply]
npm run simulate         # ESP32 simulyatori
```

`test:e2e` bazani `.env` dagi ulanish bilan, lekin **alohida** `issiqlik_e2e`
nomi bilan yaratadi va har ishga tushishda sxemani noldan quradi — ishchi
bazaga tegmaydi.

## 8. Fon ishlari (cron, Asia/Tashkent)

| Vaqt | Ish | Nima qiladi |
|---|---|---|
| har daqiqa | `StatusWatcherJob` | signal kelmagan kotyollarni «aloqa yo'q» ga o'tkazadi |
| 03:20 | `MaintenanceJob` | eski telemetriya va muddati o'tgan tokenlarni tozalaydi |
