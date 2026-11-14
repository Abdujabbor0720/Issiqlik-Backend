/**
 * GEOMETRIYA YORDAMCHILARI — nuqta ko'pburchak ichidami.
 *
 * ⚠️ PostGIS ISHLATILMAYDI (`district.entity.ts` dagi izoh): tizimda
 * birorta fazoviy SO'ROV yo'q, chegara faqat chizish uchun kerak.
 * Lekin DEMO ma'lumot va ma'lumot tekshiruvi uchun «nuqta shu tumanda
 * turibdimi» degan savolga javob kerak — u ham xuddi shu `jsonb`
 * geometriyadan, kodda hisoblanadi.
 */

/** GeoJSON halqasi: `[[lng, lat], …]`. */
type Ring = number[][];
/** Ko'pburchak: birinchi halqa — tashqi chegara, qolganlari TESHIK. */
type Polygon = Ring[];

export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/**
 * NUR TASHLASH (ray casting) usuli.
 *
 * ⚠️ Chegaradagi nuqta uchun natija aniq emas va bu MUHIM EMAS:
 * koordinata 7 kasrli (≈1 sm) va chegaraga aynan tushish ehtimoli
 * amalda nolga teng.
 */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const crosses =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * ⚠️ TESHIKLAR hisobga olinadi. Andijon viloyatida anklavlar bor
 * (bir tuman ichida ikkinchisining bo'lagi) va ularsiz nuqta
 * «qo'shni tumanda» bo'lib turgani holda «shu tumanda» deb
 * hisoblanardi.
 */
function pointInPolygon(lng: number, lat: number, polygon: Polygon): boolean {
  if (polygon.length === 0) return false;
  if (!pointInRing(lng, lat, polygon[0])) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(lng, lat, polygon[index])) return false;
  }
  return true;
}

/** Nuqta geometriya ichidami (`Polygon` va `MultiPolygon`). */
export function pointInGeometry(
  lng: number,
  lat: number,
  geometry: GeoJsonGeometry | null | undefined,
): boolean {
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    return pointInPolygon(lng, lat, geometry.coordinates as Polygon);
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as Polygon[]).some((polygon) =>
      pointInPolygon(lng, lat, polygon),
    );
  }
  return false;
}

/** Geometriyaning chegaralovchi to'rtburchagi: `[minLng, minLat, maxLng, maxLat]`. */
export function geometryBbox(
  geometry: GeoJsonGeometry | null | undefined,
): [number, number, number, number] | null {
  if (!geometry) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const visit = (coords: unknown): void => {
    if (
      Array.isArray(coords) &&
      typeof coords[0] === 'number' &&
      typeof coords[1] === 'number'
    ) {
      const [lng, lat] = coords as [number, number];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(coords)) coords.forEach(visit);
  };

  visit(geometry.coordinates);
  return minLng === Infinity ? null : [minLng, minLat, maxLng, maxLat];
}

/**
 * KO'PBURCHAK ICHIDAGI TASODIFIY NUQTA — rad etish bilan tanlash.
 *
 * ⚠️⚠️ Ilgari demo koordinatalari tuman MARKAZI atrofidagi KVADRATGA
 * tarqatilardi (`markaz ± 0.09`). Tuman shakli esa kvadrat emas:
 * Xonobod shahrining markazi uning g'arbiy chekkasida va nuqtalarning
 * yarmi chegaradan TASHQARIDA chizilardi — ekranda «qozonxonalar
 * tumandan tashqarida» bo'lib ko'rinardi.
 *
 * ⚠️ Urinishlar soni CHEKLANGAN (`maxTries`). Juda ingichka
 * geometriyada (daryo bo'yidagi tor tuman) tasodifiy nuqta uzoq vaqt
 * ichkariga tushmasligi mumkin va sikl cheksiz bo'lib qolardi —
 * seed esa butunlay osilib qolardi. Chegaraga yetilsa, `null`
 * qaytadi va chaqiruvchi markazdan foydalanadi.
 */
export function randomPointInGeometry(
  geometry: GeoJsonGeometry | null | undefined,
  random: () => number,
  maxTries = 300,
): { lng: number; lat: number } | null {
  const bbox = geometryBbox(geometry);
  if (!bbox) return null;

  const [minLng, minLat, maxLng, maxLat] = bbox;

  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    const lng = minLng + random() * (maxLng - minLng);
    const lat = minLat + random() * (maxLat - minLat);
    if (pointInGeometry(lng, lat, geometry)) {
      return {
        lng: Math.round(lng * 1e7) / 1e7,
        lat: Math.round(lat * 1e7) / 1e7,
      };
    }
  }
  return null;
}
