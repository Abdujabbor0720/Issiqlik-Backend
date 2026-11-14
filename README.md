# Issiqlik — backend

Hududlardagi **qozonxonalarni (kotyollarni)** ESP32 modullari orqali real
vaqtda monitoring qilish tizimi. Andijon viloyatining 16 ta tumani va
shahri bo'yicha ishlaydi.

**Stek:** TypeScript · NestJS 11 · PostgreSQL · TypeORM · Socket.IO

Frontend alohida papkada: `../Issiqlik-Frontend`

---

## 1. Tezkor ishga tushirish

```bash
npm install
cp .env.example .env

npm run db:setup       # PostgreSQL klasteri + baza (sudo KERAK EMAS)
npm run migration:run  # sxema
npm run seed           # 16 tuman + demo kotyollar + 48 soatlik telemetriya
npm run start:dev      # server
```

### Baza — loyihaning o'z klasteri

⚠️ Tizim klasteri (5432/5433) ishlatilmaydi: unga ulanish `sudo` yoki
`postgres` rolining parolini talab qiladi. Buning o'rniga `db:setup`
joriy foydalanuvchi nomidan **alohida klaster** yaratadi:

| Nima | Qiymat |
|---|---|
| Ma'lumot | `~/.local/share/issiqlik/pgdata` |
| Port | `5442` |
| Jurnal | `~/.local/share/issiqlik/server.log` |
| Rol / baza | `issiqlik` / `issiqlik_db` |

```bash
npm run pg:start     # ko'tarish (kompyuter qayta yoqilgandan keyin)
npm run pg:stop      # to'xtatish
npm run pg:status    # holat
npm run pg:psql      # bazaga kirish
```

⚠️ Klaster **avtomatik ishga tushmaydi** — kompyuter qayta yoqilgach
`npm run pg:start` kerak. Tizim klasteriga o'tmoqchi bo'lsangiz,
`.env` da `DB_PORT=5432` qiling va rol/bazani `sudo -u postgres psql`
bilan qo'lda yarating.

### Demo ma'lumotni tirik saqlash

```bash
npm run demo:feed              # bir marta — hamma modulga yangi o'lchov
npm run demo:feed -- --watch   # har 60 soniyada
```

⚠️ Busiz demo «o'ladi»: holat kuzatuvchi cron 15 daqiqadan keyin hamma
kotyolni «aloqa yo'q» ga o'tkazadi va ekranda bo'm-bo'sh manzara
qoladi. `demo:feed` to'g'ridan-to'g'ri bazaga yozadi (API kalitlar
faqat hash holida saqlanadi, 168 ta qurilmaning kalitini hech qayerdan
o'qib bo'lmaydi); bitta qurilmani HAQIQIY HTTP oqimi bilan sinash uchun
`npm run simulate` bor.

Natija:

| Manzil | Nima |
|---|---|
| `http://localhost:3000/api/v1` | REST API |
| `http://localhost:3000/api/v1/docs` | Swagger hujjatlari |
| `http://localhost:3000/api/data` | **ESP32 endpoint** |
| `ws://localhost:3000/realtime` | Jonli yangilanish (Socket.IO) |

**Birinchi kirish:** `.env` dagi `ADMIN_LOGIN` va `ADMIN_PASSWORD`.
Ular berilmasa, hisob umuman yaratilmaydi (`bootstrap.service.ts`).

> ⚠️ Haqiqiy parolni bu faylga yozmang: README ommaviy
> repozitoriyada turadi va u yerdagi parol bilan tizimga kirish
> mumkin bo'lardi.

**Demo operator** (faqat `npm run seed` bilan, demo bazada):
`operator.jalaquduq` / `operator2026`

---

## 2. Kotyol holati — asosiy qoida

Chiqish harorati (ESP32 yuboradigan **yagona** o'lchov) chegaralar bilan
solishtiriladi:

| Harorat | Holat | Izoh |
|---|---|---|
| `≥ 50 °C` | **Faol ishlayotgan** | me'yorda |
| `40 – 50 °C` | **O'rta ishlayotgan** | quvvat yetmayapti |
| `20 – 40 °C` | **Ishlamayotgan** | isitmayapti |
| `< 20 °C` yoki signal yo'q | **Aloqa yo'q** | sovuq yoki uzilgan |

- Chegaralar **Sozlamalar** sahifasidan o'zgartiriladi (`system_settings`),
  `.env` dagi qiymatlar faqat boshlang'ich.
- Formula **bitta joyda**: `src/helpers/boiler-status.helper.ts`
  (`resolveBoilerStatus`). Uni telemetriya servisi, holat kuzatuvchi cron
  va seed — uchalasi ham chaqiradi.
- O'tgan o'lchovlarga holat **muhrlangan**: chegara o'zgarsa, eski
  hisobot qayta yozilmaydi.

---

## 3. ESP32 bilan ulanish

Proshivkadagi manzil va kalit o'zgarmaydi:

```cpp
const char* DEVICE_ID = "modul1";
const char* API_URL   = "http://<server>:3000/api/data";
const char* API_KEY   = "91abcc3d6732ab04d017d3a30ded31b1";
```

So'rov:

```http
POST /api/data
Content-Type: application/json
x-api-key: 91abcc3d6732ab04d017d3a30ded31b1

{ "deviceId": "modul1", "temperature": 54.5 }
```

Javob: `{"ok":true,"nextIntervalSec":30,"status":"active","boilerAssigned":true}`

**Moslashuvchanlik** (proshivkani qayta yozish shart emas):

- Maydon nomlari: `deviceId` / `device_id` / `id`,
  `temperature` / `temp` / `t` / `value`
- Kalit: `x-api-key`, `api-key`, `x-device-key`, `Authorization: Bearer`,
  body'dagi `apiKey`, yoki query'dagi `?key=`
- **Ortiqcha maydonlar rad etilmaydi** (`rssi`, `uptime`, `heap`) —
  ular `raw_payload` ga saqlanadi.

### Qurilmasiz test qilish

```bash
npm run simulate -- --device modul1 --key 91abcc3d6732ab04d017d3a30ded31b1 --loop 10
```

---

## 4. Arxitektura

```
src/
├── config/          # sozlama, validatsiya (Joi), DataSource, pg turlari
├── common/          # guard, interceptor, filter, DTO, ruxsatlar
├── helpers/         # holat formulasi, sana, tuman chegarasi
├── database/
│   ├── entities/    # 13 ta entity + ENTITIES ro'yxati
│   ├── migrations/  # qo'lda yozilgan xom SQL
│   ├── seeds/       # demo ma'lumot + andijon-districts.geojson
│   └── bootstrap/   # bo'sh bazada hudud va superadmin
└── modules/
    ├── auth        users       geo        catalogs
    ├── boilers     devices     telemetry  alerts
    ├── dashboard   settings    audit      realtime
    ├── jobs        health
```

### Muhim qarorlar

| Qaror | Sabab |
|---|---|
| Joriy holat **kotyol qatorida** saqlanadi | Xarita 2000 kotyolni bitta so'rovda o'qiydi; har biri uchun oxirgi o'lchovni qidirish sekundlarga cho'zilardi |
| Holat kuzatuvchi cron (har daqiqa) | Busiz uzilgan qurilma **abadiy «faol»** bo'lib turardi — holatni yangilaydigan hech narsa yo'q |
| `boiler_id` telemetriyada **takrorlangan** | Grafik so'rovi qurilma jadvaliga JOIN qilmasligi va qurilma ko'chirilganda tarix **eski kotyolda** qolishi uchun |
| Ogohlantirish — **bitta ochiq qator** | Har o'lchovda yangi qator yozilsa, bitta sovuq kotyol kuniga 2880 ta xabar yaratardi |
| WebSocket faqat **holat o'zgarganda** | Har signalda yuborilsa, sekundiga 66 ta xabar — brauzer qotib qolardi |
| API kalit — **SHA-256 hash** | Tekshiruv har signalda bo'ladi; bcrypt ataylab sekin va serverni yiqitardi. Kalit 32 bayt tasodif, lug'at hujumi ma'nosiz |
| `/api/data` global prefiksdan **tashqarida** | Proshivkada manzil qotirilgan; prefiks qo'shilsa hamma qurilmani qayta proshivka qilish kerak bo'lardi |

### Ruxsatlar va tuman mas'ullari

To'rtta rol — `super_admin`, `admin`, **`operator` (tuman mas'uli)**,
`viewer`. Ruxsatlar mayda bo'laklarga bo'lingan
(`src/common/constants/permissions.ts`): «ko'rish» huquqi «o'chirish»
huquqini olib kelmaydi.

**Tuman mas'uli** — har bir tuman uchun alohida hisob. U o'z tumanining
kotyollari, modullari, ogohlantirishlari, grafiklari va Excel
eksportini ko'radi; boshqa tumanlar uning uchun **umuman mavjud emas**.

Tuman chegarasi guard emas, **so'rovning `where` shartida**
(`src/helpers/scope.helper.ts`): mas'ul ro'yxatni ocha oladi, lekin
ro'yxatning o'zi torayadi. Guard «ha/yo'q» deydi — bu yerda esa
ro'yxatning O'ZI qisqarishi kerak.

| Endpoint | Nima |
|---|---|
| `GET /users/district-responsibles` | 16 tuman + har biriga biriktirilgan mas'ul(lar) |
| `POST /users` | mas'ul yaratish (`role: operator` + `districtId`) |
| `PATCH /users/:id` | tahrirlash, faolsizlantirish |
| `POST /users/:id/reset-password` | parolni almashtirish (sessiyalar yopiladi) |
| `DELETE /users/:id` | o'chirish (faqat `super_admin`) |

⚠️ **Huquq oshirish himoyasi** (`assertCanAssignRole`, `assertCanManage`):
foydalanuvchi **o'zidan yuqori yoki teng** darajadagi rolni bera olmaydi
va bunday hisobni tahrirlay, parolini almashtira yoki o'chira olmaydi.
Busiz `users.create` huquqi bor administrator o'ziga yangi `super_admin`
yaratib, butun tizimni egallab olardi. Daraja `ROLE_LEVEL`
(`common/constants/enums.ts`) da, rollar bilan BITTA faylda — yangi rol
qo'shgan dasturchi uni unutib, u jimgina «eng past daraja» bo'lib
qolmasligi uchun.

⚠️ Bitta tumanda **bir nechta mas'ul** bo'lishi mumkin va bu ataylab:
qat'iy «bitta tumanga bitta mas'ul» qoidasi qo'yilsa, mas'ul almashganda
eskisini AVVAL o'chirish kerak bo'lardi — ya'ni uning audit jurnalidagi
shaxsi yo'qolardi. Endi eskisi faolsizlantiriladi, yangisi qo'shiladi va
tarix butun qoladi.

---

## 5. Buyruqlar

```bash
npm run start:dev        # watch rejimida
npm run build            # dist/
npm run typecheck        # tsc --noEmit
npm test                 # unit testlar
npm run migration:run    # migratsiyalarni qo'llash
npm run migration:show   # holatini ko'rish
npm run seed             # demo ma'lumot (idempotent)
npm run simulate         # ESP32 simulyatori
```

---

## 6. Fon ishlari (cron, Asia/Tashkent)

| Vaqt | Ish | Nima qiladi |
|---|---|---|
| har daqiqa | `StatusWatcherJob` | signal kelmagan kotyollarni «aloqa yo'q» ga o'tkazadi |
| 03:20 | `MaintenanceJob` | eski telemetriya va muddati o'tgan tokenlarni tozalaydi |

## ESP32 v2.1.0 va masofadan yangilash (OTA)

Ikki datchikli (kirish/chiqish) qurilmalar, qurilma tokenlari va
proshivkani masofadan tarqatish — **[docs/ESP32-OTA.md](docs/ESP32-OTA.md)**.

U yerda: tokenni qurilmaga qanday berish, yangi `.bin` ni qanday yuklash
va tarqatish, HTTPS/Let's Encrypt talabi, `curl` bilan tekshirish va
tez-tez uchraydigan muammolar.

Proshivka manbasi — [`firmware/`](firmware/) papkasida (`pio run` bilan
yig'iladi). Maxfiy fayllar (`secrets.h`, `tokenlar.csv`) git'ga
tushmaydi.
