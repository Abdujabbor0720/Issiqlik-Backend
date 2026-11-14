/**
 * DEMO MA'LUMOTNI TIRIK SAQLASH.
 *
 * Har bir qurilma uchun YANGI o'lchov yozadi va kotyol holatini
 * yangilaydi. Shu tufayli demo ma'lumot «eskirib» qolmaydi: holat
 * kuzatuvchi cron 15 daqiqadan keyin hamma kotyolni «aloqa yo'q» ga
 * o'tkazib yuborardi va ekranda bo'm-bo'sh manzara qolardi.
 *
 * ⚠️ HTTP orqali EMAS, to'g'ridan-to'g'ri bazaga yozadi. Sabab: API
 * kalitlar bazada faqat HASH holida saqlanadi (`devices.api_key_hash`)
 * va 168 ta qurilmaning kalitini hech qayerdan o'qib bo'lmaydi. Bitta
 * qurilmani HTTP orqali sinash uchun `npm run simulate` bor — u
 * haqiqiy oqimni (kalit tekshiruvi, ogohlantirish, WebSocket) sinaydi.
 *
 * ⚠️ Holat AYNI `resolveBoilerStatus` bilan hisoblanadi — ilova
 * ishlatadigan funksiya bilan BIR XIL. Ikkinchi nusxa yozilsa, demo
 * manzarasi ilova hisoblaydigan manzaradan farq qilib qolardi.
 *
 * Ishlatish:
 *   npm run demo:feed              # bir marta
 *   npm run demo:feed -- --watch   # har 60 soniyada
 */
import { AppDataSource } from '../src/config/data-source';
import { Boiler } from '../src/database/entities/boiler.entity';
import { Device } from '../src/database/entities/device.entity';
import { SystemSetting } from '../src/database/entities/system-setting.entity';
import { TelemetryReading } from '../src/database/entities/telemetry-reading.entity';
import { resolveBoilerStatus } from '../src/helpers/boiler-status.helper';

/**
 * ⚠️ «O'lik» qurilmalar ATAYLAB o'liq qoladi: ularning oxirgi aloqasi
 * eski va shu tufayli dashboard'da «aloqa yo'q» kartasi bo'sh
 * bo'lmaydi. Demo real manzarani ko'rsatishi kerak, hammasi yashil
 * bo'lgan ekranni emas.
 */
const DEAD_RATIO = 0.06;

/**
 * MATNDAN 0..1 oralig'idagi BARQAROR son.
 *
 * ⚠️ Oddiy `hash * 31 + c` YETARLI EMAS: «modul1» … «modul168» kabi
 * ketma-ket satrlar uchun natija zich joylashib qoladi va bitta
 * oraliqqa tushib ketadi — demo'da HAMMA kotyol bir xil holatda
 * bo'lardi («ishlamayotgan: 0»). Shuning uchun FNV-1a + xorshift
 * aralashtirgichi: qo'shni satrlar butunlay boshqa qiymat beradi.
 */
function hashToUnit(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 3266489909) >>> 0;
  /*
   * ⚠️ Oxirgi `>>> 0` SHART. `hash ^= ...` natijasi JavaScript'da
   * ISHORALI 32-bitli son bo'ladi va taxminan yarim holatda MANFIY
   * chiqadi — `hash / 2³²` esa manfiy «tasodif» beradi. Natijada
   * qurilmalarning yarmi «aloqasiz» deb belgilanib qolardi va demo
   * manzarasi butunlay buzilardi.
   */
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash / 4294967296;
}

async function feedOnce(): Promise<void> {
  const ds = AppDataSource.isInitialized
    ? AppDataSource
    : await AppDataSource.initialize();

  const devices = ds.getRepository(Device);
  const boilers = ds.getRepository(Boiler);
  const readings = ds.getRepository(TelemetryReading);
  const settings = ds.getRepository(SystemSetting);

  const config = await settings.findOne({ where: { scope: 'default' } });
  if (!config) {
    console.error('✖ Tizim sozlamalari topilmadi — avval `npm run seed`');
    return;
  }

  const thresholds = {
    activeMinC: config.activeMinC,
    mediumMinC: config.mediumMinC,
    criticalMinC: config.criticalMinC,
    offlineAfterMinutes: config.offlineAfterMinutes,
  };

  const rows = await devices.find({
    where: { isActive: true },
    select: { id: true, deviceId: true, boilerId: true },
  });

  const now = new Date();
  let written = 0;
  let skipped = 0;

  for (const device of rows) {
    /*
     * ⚠️ Qurilmaning «xulq-atvori» uning identifikatoridan hisoblanadi,
     * tasodifiy emas: shu tufayli har ishga tushirishda AYNI qurilmalar
     * aynan o'sha holatda qoladi va ekrandagi manzara sakrab
     * o'zgarmaydi.
     */
    const seed = hashToUnit(device.deviceId);
    if (seed < DEAD_RATIO) {
      skipped += 1;
      continue;
    }

    /*
     * ⚠️ Oraliqlar shunday tanlanganki, demo'da TO'RTALA holat ham
     * ko'rinadi: ~6% aloqasiz, ~12% ishlamayotgan, ~17% o'rta,
     * qolgani faol. Hammasi yashil bo'lgan ekran tizimning qanday
     * ishlashini ko'rsatmaydi.
     */
    const base =
      seed < 0.18
        ? 24 + (seed - 0.06) * 100 // 24–36 °C → ishlamayotgan
        : seed < 0.35
          ? 41 + (seed - 0.18) * 45 // 41–49 °C → o'rta
          : 52 + (seed - 0.35) * 32; // 52–73 °C → faol

    const wave =
      Math.cos(((now.getUTCHours() + 5 - 15) / 24) * 2 * Math.PI) * 2.5;
    const temperature =
      Math.round((base + wave + (Math.random() - 0.5) * 1.6) * 100) / 100;

    const status = resolveBoilerStatus(
      { temperature, lastReadingAt: now, now },
      thresholds,
    );

    await readings.insert({
      deviceId: device.id,
      boilerId: device.boilerId,
      temperature,
      status,
      recordedAt: now,
      rawPayload: { deviceId: device.deviceId, temperature, source: 'demo' },
    });

    await devices.update(device.id, {
      lastSeenAt: now,
      lastIpAddress: '127.0.0.1',
      readingsCount: (): string => '"readings_count" + 1',
    });

    if (device.boilerId) {
      const current = await boilers.findOne({
        where: { id: device.boilerId },
        select: { id: true, currentStatus: true },
      });
      await boilers.update(device.boilerId, {
        lastTemperature: temperature,
        lastReadingAt: now,
        currentStatus: status,
        ...(current?.currentStatus !== status ? { statusChangedAt: now } : {}),
      });
    }

    written += 1;
  }

  const stamp = now.toISOString().slice(11, 19);
  console.log(
    `  ${stamp}  ${written} ta o‘lchov yozildi, ${skipped} ta qurilma aloqasiz qoldirildi`,
  );
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  console.log(
    watch ? '▶ Demo oqimi (har 60 s). To‘xtatish: Ctrl+C' : '▶ Demo oqimi',
  );

  await feedOnce();

  if (!watch) {
    await AppDataSource.destroy();
    return;
  }

  setInterval(() => {
    void feedOnce();
  }, 60_000);
}

void main();
