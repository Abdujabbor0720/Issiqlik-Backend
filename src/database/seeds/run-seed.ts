import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcryptjs';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { BoilerStatus, FuelType, UserRole } from '../../common/constants/enums';
import { Boiler } from '../entities/boiler.entity';
import {
  BoilerBrand,
  Firm,
  ObjectType,
  Organization,
} from '../entities/catalog.entities';
import { Device } from '../entities/device.entity';
import { District } from '../entities/district.entity';
import { Region } from '../entities/region.entity';
import { SystemSetting } from '../entities/system-setting.entity';
import { TelemetryReading } from '../entities/telemetry-reading.entity';
import { User } from '../entities/user.entity';
import { resolveBoilerStatus } from '../../helpers/boiler-status.helper';
import {
  randomPointInGeometry,
  type GeoJsonGeometry,
} from '../../helpers/geo.helpers';
import {
  BOILER_BRANDS,
  FIRMS,
  ORGANIZATION_TEMPLATES,
  RESPONSIBLE_NAMES,
} from './seed-data';

/**
 * DEMO MA'LUMOTLAR.
 *
 * ⚠️ IDEMPOTENT: mavjud ma'lumotga TEGMAYDI. Qayta ishga tushirilsa,
 * faqat YETISHMAYOTGANI qo'shiladi. Aks holda `npm run seed` ni
 * ikkinchi marta chaqirish lot raqamlari takrorlanib, migratsiya
 * cheklovida yiqilardi.
 *
 * ⚠️ TASODIF — QAT'IY URUG'DAN (`mulberry32`). `Math.random()` bilan
 * har seed boshqa raqamlar berardi va «demo ma'lumot bilan ekranni
 * tekshirish» har safar boshqa manzaraga aylanardi. Urug' qotirilgan,
 * ya'ni ma'lumot har doim BIR XIL.
 */

// ─────────────── Qat'iy urug'li tasodif ───────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261113);
const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
const between = (min: number, max: number): number => min + rnd() * (max - min);
const intBetween = (min: number, max: number): number =>
  Math.floor(between(min, max + 1));

/** ESP32 proshivkasidagi kalit — hujjatdagi misol bilan AYNI. */
const DEMO_DEVICE_ID = 'modul1';
const DEMO_API_KEY = '91abcc3d6732ab04d017d3a30ded31b1';

const sha256 = (value: string): string =>
  createHash('sha256').update(value.trim()).digest('hex');

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  console.log('▶ Baza ulandi');

  const regions = ds.getRepository(Region);
  const districts = ds.getRepository(District);
  const users = ds.getRepository(User);
  const brands = ds.getRepository(BoilerBrand);
  const firms = ds.getRepository(Firm);
  const organizations = ds.getRepository(Organization);
  const objectTypes = ds.getRepository(ObjectType);
  const boilers = ds.getRepository(Boiler);
  const devices = ds.getRepository(Device);
  const settings = ds.getRepository(SystemSetting);

  // ─────────── 1. Sozlamalar ───────────
  let setting = await settings.findOne({ where: { scope: 'default' } });
  if (!setting) {
    setting = await settings.save(
      settings.create({
        scope: 'default',
        activeMinC: 50,
        mediumMinC: 40,
        criticalMinC: 20,
        overheatC: 95,
        offlineAfterMinutes: 15,
        normTemperature: 60,
        retentionDays: 90,
        seasonLabel: '2026–2027',
      }),
    );
    console.log('✔ Tizim sozlamalari yozildi');
  }

  // ─────────── 2. Hududlar ───────────
  let region = await regions.findOne({ where: { code: 'andijon' } });
  if (!region) {
    const geoPath = join(__dirname, 'data', 'andijon-districts.geojson');
    const geo = JSON.parse(readFileSync(geoPath, 'utf8')) as {
      bbox: number[];
      features: Array<{
        properties: Record<string, string | number>;
        geometry: Record<string, unknown>;
      }>;
    };

    region = await regions.save(
      regions.create({
        code: 'andijon',
        name: 'Andijon viloyati',
        soato: '1703',
        centerLat: 40.7821,
        centerLng: 72.3442,
        bbox: geo.bbox,
      }),
    );

    await districts.save(
      geo.features.map((feature) =>
        districts.create({
          code: String(feature.properties.code),
          name: String(feature.properties.name),
          shortName: String(feature.properties.shortName),
          soato: feature.properties.soato
            ? String(feature.properties.soato)
            : null,
          kind: String(feature.properties.kind),
          regionId: region!.id,
          centerLat: Number(feature.properties.centerLat),
          centerLng: Number(feature.properties.centerLng),
          geometry: feature.geometry,
        }),
      ),
    );
    console.log(`✔ Hududlar: ${geo.features.length} ta tuman/shahar`);
  }

  const districtRows = await districts.find({ order: { name: 'ASC' } });

  // ─────────── 3. Superadmin ───────────
  /*
   * ⚠️ Login ham, parol ham FAQAT `.env` dan — kodda zaxira qiymat YO'Q.
   *    Ilgari bu yerda haqiqiy superadmin logini qotirilgan edi va u
   *    ommaviy repozitoriyada (hamda kirish sahifasining namunasida)
   *    ko'rinib turardi. Login — hujumchi uchun yarim yo'l.
   */
  const adminLogin = process.env.ADMIN_LOGIN?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminLogin || !adminPassword) {
    throw new Error(
      '.env da ADMIN_LOGIN yoki ADMIN_PASSWORD berilmagan — superadmin yaratilmadi. ' +
        'Ikkalasini .env ga yozing (qotirilgan zaxira qiymat ataylab yo‘q).',
    );
  }
  const adminExists = await users.findOne({ where: { login: adminLogin } });
  if (!adminExists) {
    await users.save(
      users.create({
        login: adminLogin,
        /*
         * ⚠️⚠️ QOTIRILGAN ZAXIRA PAROL YO'Q va bo'lmasligi ham kerak.
         *
         * Ilgari bu yerda qotirilgan zaxira parol turardi. U
         * ommaviy repozitoriyada ko'rinib turadi, ya'ni `ADMIN_PASSWORD`
         * ni berishni unutgan odam JIMGINA hamma biladigan parol bilan
         * superadmin yaratib qo'yardi — va buni hech narsa aytmasdi.
         * Endi seed yuqorida to'xtaydi (`assertAdminPassword`).
         */
        passwordHash: await bcrypt.hash(adminPassword, 10),
        fullName: process.env.ADMIN_FULL_NAME || 'Tizim administratori',
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      }),
    );
    console.log(`✔ Bosh administrator: ${adminLogin}`);
  }

  /*
   * Demo tuman mas'uli — tuman kesimini (API darajasidagi chegarani)
   * tekshirish uchun. ⚠️ Faqat DEMO bazada: parol ochiq yozilgan.
   */
  const operatorExists = await users.findOne({
    where: { login: 'operator.demo' },
  });
  if (!operatorExists) {
    const demoDistrict = districtRows.find((d) => d.key === 'asaka');
    if (demoDistrict) {
      await users.save(
        users.create({
          login: 'operator.demo',
          passwordHash: await bcrypt.hash('operator2026', 10),
          fullName: `${demoDistrict.name} mas‘uli (demo)`,
          role: UserRole.OPERATOR,
          districtId: demoDistrict.id,
          position: 'Issiqlik ta’minoti bo‘limi mutaxassisi',
          isActive: true,
        }),
      );
      console.log(
        `✔ Demo tuman mas‘uli: operator.demo / operator2026 (${demoDistrict.name})`,
      );
    }
  }

  // ─────────── 4. Kataloglar ───────────
  if ((await brands.count()) === 0) {
    await brands.save(BOILER_BRANDS.map((item) => brands.create(item)));
    console.log(`✔ Markalar: ${BOILER_BRANDS.length}`);
  }
  if ((await firms.count()) === 0) {
    await firms.save(FIRMS.map((item) => firms.create(item)));
    console.log(`✔ DXSH firmalar: ${FIRMS.length}`);
  }

  const brandRows = await brands.find();
  const firmRows = await firms.find();

  // ─────────── 5. Kotyollar ───────────
  const existingBoilers = await boilers.count();
  if (existingBoilers > 0) {
    console.log(
      `• Kotyollar allaqachon bor (${existingBoilers}) — o‘tkazib yuborildi`,
    );
  } else {
    /*
     * ⚠️ Obyekt turlari migratsiyada yoziladi (`ObjectTypesCatalog`),
     * seed ularni faqat O'QIYDI. Ikki joyda yozilsa, migratsiya
     * bajarilgan bazada seed takroriy kalit bilan yiqilardi.
     */
    const typeIdByCode = new Map(
      (await objectTypes.find()).map((type) => [type.code, type.id]),
    );

    const orgRows: Organization[] = [];
    const boilerRows: Boiler[] = [];
    let lotCounter = 1;
    let schoolNo = 1;

    /*
     * ⚠️ MUASSASA NOMI TUMAN ICHIDA YAGONA (`UQ_organizations_district_name`).
     * Shablonlarning bir qismida tartib raqami yo'q («{district} tuman
     * markaziy shifoxonasi») va bitta tumanda ikki marta tanlansa, nom
     * AYNAN takrorlanadi — baza esa butun partiyani rad etadi va seed
     * o'rtasida yiqiladi. Shuning uchun nom yozilishidan oldin
     * takrorlanmasligi tekshiriladi.
     */
    const usedOrgNames = new Set<string>();
    const uniqueOrgName = (base: string): string => {
      if (!usedOrgNames.has(base)) {
        usedOrgNames.add(base);
        return base;
      }
      for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} №${suffix}`;
        if (!usedOrgNames.has(candidate)) {
          usedOrgNames.add(candidate);
          return candidate;
        }
      }
    };

    for (const district of districtRows) {
      // ⚠️ Shaharlarda ko'proq obyekt: demo ham haqiqatga yaqin bo'lsin.
      const count =
        district.kind === 'city' ? intBetween(14, 22) : intBetween(7, 15);

      for (let i = 0; i < count; i += 1) {
        const template = pick(ORGANIZATION_TEMPLATES);
        const name = template.pattern
          .replace('{district}', district.shortName)
          .replace('{n}', String(schoolNo));
        schoolNo += 1;

        const org = organizations.create({
          name: uniqueOrgName(`${name} (${district.shortName})`),
          // ⚠️ Muassasa katalogi tuman bo'yicha (`organizations.district_key`).
          districtKey: district.key,
          /*
           * ⚠️ Tur KALIT bo'yicha topiladi, nom bo'yicha emas: nom
           * tahrirlanadi («Maktab» → «Umumta'lim maktabi») va unga
           * bog'lanib bo'lmaydi. Kalit esa o'zgarmas.
           */
          objectTypeId: typeIdByCode.get(template.kind) ?? null,
          phone: `+99874${intBetween(1000000, 9999999)}`,
        });
        orgRows.push(org);

        /*
         * ⚠️⚠️ Koordinata tumanning KO'PBURCHAGI ICHIDAN olinadi,
         * markaz atrofidagi KVADRATDAN emas.
         *
         * Ilgari u `markaz ± 0.09` edi, tuman shakli esa kvadrat
         * emas: Xonobod shahrining markazi uning g'arbiy chekkasida
         * va nuqtalarning yarmi chegaradan TASHQARIDA chizilardi —
         * ekranda «qozonxonalar tumandan tashqarida» bo'lib
         * ko'rinardi.
         *
         * ⚠️ Topilmasa (juda ingichka geometriya) markaz olinadi:
         * koordinatasiz qoldirish yomonroq — u paytda kotyol xaritada
         * umuman ko'rinmasdi.
         */
        const point = randomPointInGeometry(
          district.geometry as GeoJsonGeometry | null,
          rnd,
        ) ?? { lng: district.centerLng, lat: district.centerLat };

        boilerRows.push(
          boilers.create({
            districtId: district.id,
            lotNumber: `2026-LOT-${String(lotCounter).padStart(4, '0')}`,
            firmId: pick(firmRows).id,
            brandId: pick(brandRows).id,
            boilerCount: intBetween(1, 4),
            normAt60: Math.round(between(180, 2400) * 100) / 100,
            fuelType: rnd() > 0.12 ? FuelType.GAS : FuelType.ELECTRIC,
            capacityKw: Math.round(between(60, 900) * 10) / 10,
            installedYear: intBetween(2012, 2026),
            address: `${district.shortName}, ${intBetween(1, 120)}-uy`,
            lat: point.lat,
            lng: point.lng,
            responsibleName: pick(RESPONSIBLE_NAMES),
            responsiblePhone: `+99890${intBetween(1000000, 9999999)}`,
            currentStatus: BoilerStatus.OFFLINE,
            statusChangedAt: new Date(),
            // ⚠️ `organizationId` keyin to'ldiriladi: tashkilotlar hali
            // saqlanmagan va ularning id si yo'q.
          }),
        );
        lotCounter += 1;
      }
    }

    const savedOrgs = await organizations.save(orgRows);
    boilerRows.forEach((boiler, index) => {
      boiler.organizationId = savedOrgs[index].id;
    });
    const savedBoilers = await boilers.save(boilerRows, { chunk: 200 });
    console.log(
      `✔ Kotyollar: ${savedBoilers.length} ta (tashkilotlar: ${savedOrgs.length})`,
    );

    // ─────────── 6. ESP32 qurilmalari ───────────
    /*
     * ⚠️ Har kotyolga qurilma berilMAYDI (~88%): haqiqatda ham bir
     * qismi hali ulanmagan bo'ladi va dashboard'dagi «modul ulanmagan»
     * ko'rsatkichi ko'rinishi kerak.
     */
    const deviceRows: Device[] = [];
    let deviceIndex = 1;

    for (const boiler of savedBoilers) {
      if (rnd() > 0.88) continue;

      const isDemoDevice = deviceIndex === 1;
      const apiKey = isDemoDevice
        ? DEMO_API_KEY
        : randomBytes(16).toString('hex');

      deviceRows.push(
        devices.create({
          deviceId: isDemoDevice ? DEMO_DEVICE_ID : `modul${deviceIndex}`,
          name: `ESP32 — ${boiler.lotNumber}`,
          apiKeyHash: sha256(apiKey),
          apiKeyPreview: apiKey.slice(-6),
          boilerId: boiler.id,
          isActive: true,
          firmwareVersion: '1.0.0',
        }),
      );
      deviceIndex += 1;
    }

    const savedDevices = await devices.save(deviceRows, { chunk: 200 });
    console.log(`✔ ESP32 modullari: ${savedDevices.length}`);
    console.log(
      `  ⚑ Test moduli: deviceId="${DEMO_DEVICE_ID}", apiKey="${DEMO_API_KEY}"`,
    );

    // ─────────── 7. Telemetriya ───────────
    await seedTelemetry(ds, savedDevices, setting);
  }

  await ds.destroy();
  console.log('✔ Tayyor');
}

/**
 * SO'NGGI 48 SOATLIK TELEMETRIYA.
 *
 * ⚠️ Qadam 30 daqiqa, har signal emas: 48 soat × har 30 soniya × 1700
 * qurilma ≈ 9.8 mln qator bo'lardi va seed yarim soat ishlardi.
 * 30 daqiqalik qadam grafikni to'liq chizadi va ~160 ming qator beradi.
 *
 * ⚠️ Harorat TASODIFIY SAKRAMAYDI, balki kunlik to'lqin bo'yicha
 * o'zgaradi (kechasi sovuqroq). Tasodifiy qiymatlar bilan grafik
 * «shovqin» bo'lib ko'rinardi va uning to'g'ri ishlayotganini
 * tekshirib bo'lmasdi.
 */
async function seedTelemetry(
  ds: typeof AppDataSource,
  deviceRows: Device[],
  setting: SystemSetting,
): Promise<void> {
  const readings = ds.getRepository(TelemetryReading);
  const boilers = ds.getRepository(Boiler);

  const now = new Date();
  const stepMin = 30;
  const hours = 48;
  const steps = (hours * 60) / stepMin;

  const thresholds = {
    activeMinC: setting.activeMinC,
    mediumMinC: setting.mediumMinC,
    criticalMinC: setting.criticalMinC,
    offlineAfterMinutes: setting.offlineAfterMinutes,
  };

  let total = 0;
  const batch: Array<Partial<TelemetryReading>> = [];
  const lastByBoiler = new Map<string, { temp: number; at: Date }>();
  /*
   * ⚠️ QURILMANING oxirgi aloqasi ham yoziladi. Busiz dashboard'da
   * «modullar onlayn: 0 / 168» bo'lib turardi: telemetriya bor, kotyol
   * holati yangi, lekin `devices.last_seen_at` bo'sh — ya'ni ekranda
   * ikki raqam bir-biriga ZID bo'lardi va buni foydalanuvchi tizim
   * xatosi deb o'qirdi.
   */
  const lastByDevice = new Map<string, { at: Date; count: number }>();

  for (const device of deviceRows) {
    /*
     * HAR QURILMA UCHUN «XULQ-ATVOR» — demo manzarasi real bo'lsin:
     *   • 62% — yaxshi ishlaydi (55–75 °C)
     *   • 22% — o'rtacha (42–52 °C)
     *   • 10% — ishlamayapti (22–36 °C)
     *   • 6%  — aloqa uzilgan (ma'lumot eski bo'lib qoladi)
     */
    const roll = rnd();
    const profile =
      roll < 0.62
        ? 'good'
        : roll < 0.84
          ? 'medium'
          : roll < 0.94
            ? 'bad'
            : 'dead';

    const base =
      profile === 'good'
        ? between(57, 73)
        : profile === 'medium'
          ? between(43, 51)
          : between(23, 36);

    // «Aloqa uzilgan» qurilmada oxirgi signal 1–20 soat oldin.
    const silentSince =
      profile === 'dead' ? between(1, 20) * 60 * 60 * 1000 : 0;

    for (let step = steps; step >= 0; step -= 1) {
      const at = new Date(now.getTime() - step * stepMin * 60_000);
      if (silentSince && at.getTime() > now.getTime() - silentSince) break;

      // Kunlik to'lqin: kechasi ~3 °C sovuqroq.
      const hourOfDay = (at.getUTCHours() + 5) % 24;
      const wave = Math.cos(((hourOfDay - 15) / 24) * 2 * Math.PI) * 3;
      const noise = between(-1.2, 1.2);
      const temp = Math.round((base + wave + noise) * 100) / 100;

      const status = resolveBoilerStatus(
        { temperature: temp, lastReadingAt: at, now: at },
        thresholds,
      );

      batch.push({
        deviceId: device.id,
        boilerId: device.boilerId,
        temperature: temp,
        status,
        recordedAt: at,
        rawPayload: { deviceId: device.deviceId, temperature: temp },
      });

      if (device.boilerId) {
        lastByBoiler.set(device.boilerId, { temp, at });
      }
      const seen = lastByDevice.get(device.id);
      lastByDevice.set(device.id, {
        at,
        count: (seen?.count ?? 0) + 1,
      });

      if (batch.length >= 2000) {
        await readings.insert(
          batch as QueryDeepPartialEntity<TelemetryReading>[],
        );
        total += batch.length;
        batch.length = 0;
      }
    }
  }

  if (batch.length) {
    await readings.insert(batch as QueryDeepPartialEntity<TelemetryReading>[]);
    total += batch.length;
  }
  console.log(`✔ Telemetriya: ${total} o‘lchov (so‘nggi ${hours} soat)`);

  // ─────────── Qurilmalarning oxirgi aloqasi ───────────
  const devices = ds.getRepository(Device);
  for (const [deviceId, info] of lastByDevice) {
    await devices.update(deviceId, {
      lastSeenAt: info.at,
      readingsCount: String(info.count),
      lastIpAddress: '127.0.0.1',
    });
  }
  console.log(`✔ Qurilmalar aloqasi yangilandi: ${lastByDevice.size}`);

  // ─────────── Kotyollarning joriy holati ───────────
  /*
   * ⚠️ Holat AYNI `resolveBoilerStatus` bilan hisoblanadi — telemetriya
   * servisi va cron ishlatadigan funksiya bilan BIR XIL. Ikkinchi
   * nusxa yozilsa, seed'dan keyingi manzara ilova hisoblaydigan
   * manzaradan farq qilardi va buni hech kim sezmasdi.
   */
  let updated = 0;
  for (const [boilerId, last] of lastByBoiler) {
    const status = resolveBoilerStatus(
      { temperature: last.temp, lastReadingAt: last.at, now },
      thresholds,
    );
    await boilers.update(boilerId, {
      lastTemperature: last.temp,
      lastReadingAt: last.at,
      currentStatus: status,
      statusChangedAt: last.at,
      todayAvgTemperature: last.temp,
    });
    updated += 1;
  }
  console.log(`✔ Kotyollar holati yangilandi: ${updated}`);
}

main().catch((error: unknown) => {
  console.error('✖ Seed bajarilmadi:', error);
  process.exit(1);
});
