/**
 * KOORDINATALARNI TEKSHIRISH VA TO'G'RILASH.
 *
 * Har bir kotyolning nuqtasi O'Z TUMANINING chegarasi ichidami —
 * shuni tekshiradi. Tashqarida qolganlari xaritada «tumandan
 * tashqarida» bo'lib chiziladi va bu yo ma'lumot xatosi, yo demo
 * generatorining nuqsoni.
 *
 * ⚠️⚠️ SUKUT BO'YICHA HECH NARSA O'ZGARTIRMAYDI — faqat ro'yxatni
 * chiqaradi. Sabab: HAQIQIY koordinata tashqarida bo'lsa, bu
 * KIRITISH XATOSI va uni jimgina «to'g'rilab» qo'yish xatoni
 * yashirardi — qozonxona xaritada chiroyli turardi, lekin manzili
 * baribir noto'g'ri bo'lardi. Operator buni ko'rib, o'zi hal qilishi
 * kerak.
 *
 * `--apply` bayrog'i bilan esa tashqaridagilar tuman ichiga
 * ko'chiriladi — DEMO ma'lumotini tuzatish uchun.
 *
 *   npm run fix:coords            # faqat tekshirish
 *   npm run fix:coords -- --apply # demo ma'lumotini to'g'rilash
 */
import { AppDataSource } from '../src/config/data-source';
import { Boiler } from '../src/database/entities/boiler.entity';
import { District } from '../src/database/entities/district.entity';
import {
  pointInGeometry,
  randomPointInGeometry,
  type GeoJsonGeometry,
} from '../src/helpers/geo.helpers';

/**
 * ⚠️ Qat'iy urug'li tasodif: `--apply` ikki marta chaqirilsa, AYNI
 * nuqtalar chiqadi. `Math.random()` bilan har chaqiruvda xarita
 * manzarasi o'zgarib, «nega nuqtalar siljidi» degan savol tug'ilardi.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const ds = await AppDataSource.initialize();

  const districts = await ds.getRepository(District).find();
  const geometryById = new Map(
    districts.map((district) => [
      district.id,
      {
        name: district.shortName,
        geometry: district.geometry as GeoJsonGeometry | null,
        centerLat: district.centerLat,
        centerLng: district.centerLng,
      },
    ]),
  );

  const boilers = await ds.getRepository(Boiler).find({
    select: {
      id: true,
      lotNumber: true,
      districtId: true,
      lat: true,
      lng: true,
    },
  });

  const rnd = mulberry32(20261113);
  const outside: Array<{ id: string; lot: string; district: string }> = [];
  let missing = 0;
  let ok = 0;

  for (const boiler of boilers) {
    if (boiler.lat === null || boiler.lng === null) {
      missing += 1;
      continue;
    }
    const district = geometryById.get(boiler.districtId);
    if (!district?.geometry) continue;

    if (pointInGeometry(boiler.lng, boiler.lat, district.geometry)) {
      ok += 1;
      continue;
    }
    outside.push({
      id: boiler.id,
      lot: boiler.lotNumber ?? '(lotsiz)',
      district: district.name,
    });
  }

  console.log(`▶ Jami kotyol: ${boilers.length}`);
  console.log(`  ✔ tuman ichida : ${ok}`);
  console.log(`  ✖ tashqarida   : ${outside.length}`);
  console.log(`  — koordinatasiz: ${missing}`);

  if (outside.length === 0) {
    await ds.destroy();
    return;
  }

  // Tuman kesimida qisqa hisobot — qaysi tumanda muammo ko'p.
  const byDistrict = new Map<string, number>();
  for (const row of outside) {
    byDistrict.set(row.district, (byDistrict.get(row.district) ?? 0) + 1);
  }
  console.log('\n  Tumanlar kesimida:');
  for (const [name, count] of [...byDistrict].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(14)} ${count}`);
  }

  if (!apply) {
    console.log(
      '\n  ⚠️ Hech narsa o‘zgartirilmadi. To‘g‘rilash uchun: --apply',
    );
    await ds.destroy();
    return;
  }

  let moved = 0;
  let failed = 0;
  for (const row of outside) {
    const boiler = boilers.find((item) => item.id === row.id);
    const district = boiler ? geometryById.get(boiler.districtId) : undefined;
    if (!district) continue;

    const point = randomPointInGeometry(district.geometry, rnd) ??
      /* ⚠️ Markaz — oxirgi chora. U har doim ko'pburchak ichida
         bo'lmasligi mumkin (yarim oy shaklidagi tuman), lekin
         koordinatasiz qoldirishdan yaxshiroq: kotyol xaritada
         umuman ko'rinmasdi. */
      { lng: district.centerLng, lat: district.centerLat };

    await ds.getRepository(Boiler).update(row.id, {
      lat: point.lat,
      lng: point.lng,
    });
    if (pointInGeometry(point.lng, point.lat, district.geometry)) moved += 1;
    else failed += 1;
  }

  console.log(`\n  ✔ Tuman ichiga ko‘chirildi: ${moved}`);
  if (failed > 0) {
    console.log(`  ⚠ Markazga qo‘yildi (ichkariga tushmadi): ${failed}`);
  }

  await ds.destroy();
}

void main();
