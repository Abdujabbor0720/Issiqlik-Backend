import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { toNumber, trim } from '../../../common/dto/transforms';

/**
 * ESP32 DAN KELADIGAN YUK — ikki avlod proshivka uchun BIR XIL DTO.
 *
 * ⚠️⚠️ MAYDON NOMLARI BIR NECHTA SHAKLDA qabul qilinadi. Sabab:
 * dalada IKKI XIL proshivka ishlaydi va ularni bir kunda
 * almashtirib bo'lmaydi:
 *
 *   • eski (`modul1`, birinchi avlod v1.x):
 *       {"deviceId":"modul1","temperature":54.5}
 *       {"institution_id":"maktab-1","device_id":"esp32-…","temperature_c":54.5}
 *   • yangi (v2.0.0, ikki datchik):
 *       {"institution_id":"maktab-4","device_id":"esp32-…",
 *        "inlet_temperature_c":45.12,"outlet_temperature_c":60.50}
 *       {"…","temperature_c":60.50,"probe":"outlet"}
 *
 * Normallashtirish `normalizePayload()` da, BIR joyda.
 *
 * ⚠️⚠️ HARORAT CHEGARASI BU YERDA QO'YILMAYDI. Diapazon
 * (`-55…125 °C`) `classifyProbeReading()` da tekshiriladi va u
 * yaroqsiz qiymatni («sim uzilgan» `-127`) RAD ETMAY, DALIL sifatida
 * qaytaradi. Chegara DTO'da bo'lsa, so'rov 400 bilan to'xtab,
 * nosozlik sababi hech qayerga yozilmasdi — operator esa «signal
 * kelmayapti» degan noto'g'ri xulosaga kelardi.
 *
 * ⚠️ `whitelist: true` global pipe'da yoqilgan, lekin bu DTO
 * `@Body()` sifatida ISHLATILMAYDI: xom yuk kontrollerda qo'lda
 * normallashtiriladi. Aks holda `forbidNonWhitelisted` proshivkadagi
 * har bir noma'lum maydonni xato deb qaytarardi (§3: «Noma'lum
 * maydonlarni RAD ETMA»).
 */
export class IngestDto {
  @ApiProperty({ example: 'esp32-f42dc987e788' })
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  deviceId!: string;

  @ApiPropertyOptional({
    description: 'Kirish (obratka) harorati, °C',
    example: 45.12,
  })
  @Transform(toNumber)
  @IsNumber({}, { message: 'Kirish harorati son bo‘lishi kerak' })
  @IsOptional()
  inletTemperature?: number;

  @ApiPropertyOptional({
    description: 'Chiqish harorati, °C',
    example: 60.5,
  })
  @Transform(toNumber)
  @IsNumber({}, { message: 'Chiqish harorati son bo‘lishi kerak' })
  @IsOptional()
  outletTemperature?: number;

  /**
   * YAKKA harorat — juftlik kelmaganda.
   *
   * ⚠️ `probe` bilan birga ma'noga ega bo'ladi: ishorasiz qiymat
   * chiqish deb olinadi (eski proshivka xatti-harakati).
   */
  @ApiPropertyOptional({ description: 'Yakka harorat, °C', example: 60.5 })
  @Transform(toNumber)
  @IsNumber({}, { message: 'Harorat son bo‘lishi kerak' })
  @IsOptional()
  singleTemperature?: number;

  @ApiPropertyOptional({ description: 'inlet | outlet', example: 'outlet' })
  @Transform(trim)
  @IsString()
  @MaxLength(16)
  @IsOptional()
  probeHint?: string;

  /**
   * Proshivkada tanlangan muassasa — FAQAT MA'LUMOT UCHUN.
   *
   * ⚠️⚠️ Bu qiymat ma'lumotni yo'naltirish uchun ISHLATILMAYDI
   * (§3: «institution_id ga ko'r-ko'rona ishonma»). Kotyol qurilma
   * yozuvidagi `boilerId` orqali aniqlanadi. Bu maydon faqat
   * saqlanadi va mos kelmasa ogohlantirish beradi.
   */
  @ApiPropertyOptional({ example: 'maktab-4' })
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  @IsOptional()
  institutionId?: string;

  @ApiPropertyOptional({ description: 'Proshivka versiyasi', example: '2.0.0' })
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @IsOptional()
  firmware?: string;

  /*
   * ⚠️ `measured_at` ATAYLAB YO'Q: yangi proshivka uni yubormaydi va o'lchov
   * vaqti — SERVER vaqti. Eski proshivka yuborsa ham e'tiborsiz qoldiriladi
   * (normallashtirishda o'qilmaydi), ya'ni buzuq sana 400 ga olib kelmaydi.
   */
}

/**
 * XOM YUKNI NORMALLASHTIRISH — proshivka qanday yozilgan bo'lsa ham.
 *
 * ⚠️ Harorat SATR bo'lib kelishi mumkin (`"54.50"`): Arduino'da
 * `String(temp)` bilan yuborish keng tarqalgan. `Number()` buni
 * to'g'rilaydi, lekin `""` → `0` ga aylanishiga YO'L QO'YILMAYDI:
 * bo'sh qiymat 0 °C bo'lib yozilsa, kotyol «sovib qolgan» bo'lib
 * ko'rinardi.
 */
export function normalizePayload(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };

  /*
   * ⚠️ Faqat SATR, SON va BOOLEAN matnga aylantiriladi. Xom
   * `String(value)` ishlatilsa, proshivka tasodifan obyekt yuborganda
   * u `"[object Object]"` ga aylanib, bazaga shu matn tushib ketardi
   * — «modul1» o'rniga shunday identifikator bilan qurilma hech
   * qachon topilmasdi va xato sababi ko'rinmasdi.
   */
  const asText = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return undefined;
  };

  const asNumber = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    // Obyekt yoki massiv kelsa — `NaN`, validatsiya uni rad etadi.
    return Number.NaN;
  };

  return {
    deviceId: asText(
      pick('deviceId', 'device_id', 'device', 'id', 'DEVICE_ID'),
    ),

    /*
     * ⚠️ ANIQ ATALGAN JUFTLIK — v2.0.0 proshivkasining asosiy shakli.
     * `inlet_temperature_c` / `outlet_temperature_c` nomlari
     * PROSHIVKADA QOTIRILGAN (`main.cpp` dagi `buildJson`) va
     * o'zgartirilmaydi.
     */
    inletTemperature: asNumber(
      pick(
        'inlet_temperature_c',
        'inletTemperature',
        'inlet_temperature',
        'inlet',
        'kirish',
      ),
    ),
    outletTemperature: asNumber(
      pick(
        'outlet_temperature_c',
        'outletTemperature',
        'outlet_temperature',
        'outlet',
      ),
    ),

    /*
     * ⚠️⚠️ YAKKA HARORAT — IKKI XIL ESKI SHAKL BIRLASHTIRILGAN:
     *   • bizning `modul1`: `temperature` / `temp` / `t` / `chiqish`;
     *   • v1.x va v2.x ning yakka rejimi: `temperature_c`.
     * `outTemp` / `out_temp` ham qoldirilgan — ular bizning eski
     * proshivkada ishlatilgan va dalada hali turishi mumkin.
     *
     * ⚠️ `outlet` ro'yxatida `outTemp` YO'Q: u yakka qiymat sifatida
     * yuborilgan va `probe` ishorasi bilan kelmaydi. Juftlik a'zosi
     * deb qabul qilinsa, kirish `null` bo'lgani uchun o'lchov
     * `OUTLET` ga tushardi — natija bir xil, lekin `UNKNOWN`
     * («taxmin qilindi») belgisi yo'qolardi.
     */
    singleTemperature: asNumber(
      pick(
        'temperature_c',
        'temperature',
        'temp',
        't',
        'value',
        'outTemp',
        'out_temp',
        'chiqish',
      ),
    ),

    probeHint: asText(pick('probe', 'probe_kind', 'sensor')),

    institutionId: asText(
      pick('institution_id', 'institutionId', 'inst', 'muassasa'),
    ),

    firmware: asText(pick('firmware', 'fw', 'version', 'firmwareVersion')),
  };
}

/**
 * SO'ROVDAN QURILMA KALITINI AJRATIB OLISH — qaysi shaklda kelsa ham.
 *
 * ⚠️⚠️ `x-device-token` BIRINCHI o'rinda: v2.0.0 proshivkasi aynan
 * shu sarlavhani yuboradi (`net.cpp:20`) va u YANGI, ASOSIY kontrakt.
 * Qolganlari — eski proshivkalar uchun (`x-api-key` bizning
 * `modul1` da) va ular SAQLANADI: «Shu davrda ikkala format ham
 * ishlashi kerak» (§10).
 *
 * ⚠️ Kalit `query` dan ham o'qiladi, lekin bu ENG ZAIF usul: u
 * server loglariga tushadi. Shuning uchun u oxirgi o'rinda va faqat
 * eski proshivkalar uchun qoldirilgan.
 */
export function extractApiKey(
  headers: Record<string, unknown>,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
): string | null {
  const header = (name: string): string | null => {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
  };

  const bearer = header('authorization');
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }

  return (
    header('x-device-token') ??
    header('x-api-key') ??
    header('api-key') ??
    header('x-device-key') ??
    (typeof body.apiKey === 'string' ? body.apiKey.trim() : null) ??
    (typeof body.api_key === 'string' ? body.api_key.trim() : null) ??
    (typeof query.apiKey === 'string' ? query.apiKey.trim() : null) ??
    (typeof query.key === 'string' ? query.key.trim() : null) ??
    bearer
  );
}

/**
 * QURILMA IDENTIFIKATORINI SARLAVHADAN OLISH.
 *
 * ⚠️⚠️ `X-Device-Id` — BARCHA so'rovlarda bor (`net.cpp:21`), shu
 * jumladan OTA'ning `GET` so'rovlarida, u yerda esa TANA YO'Q.
 * Shuning uchun qurilma kimligining YAGONA universal manbai aynan
 * shu sarlavha.
 */
export function extractDeviceId(
  headers: Record<string, unknown>,
): string | null {
  const value = headers['x-device-id'];
  if (typeof value === 'string' && value.trim())
    return value.trim().slice(0, 64);
  return null;
}

/**
 * PROSHIVKA VERSIYASINI SARLAVHADAN OLISH (`X-Firmware-Version`).
 *
 * ⚠️ Eski proshivkada bu sarlavha YO'Q (§2) — `null` qaytadi va
 * qurilma yozuvidagi versiya O'ZGARMAYDI (`undefined` bilan
 * yangilanadi). Bo'sh satr yozilsa, kabinetda «versiya: —» paydo
 * bo'lib, qurilma yangilangandek ko'rinardi.
 */
export function extractFirmwareVersion(
  headers: Record<string, unknown>,
): string | null {
  const value = headers['x-firmware-version'];
  if (typeof value === 'string' && value.trim())
    return value.trim().slice(0, 40);
  return null;
}

/**
 * QURILMA TURI SARLAVHASI (`X-Device-Type: kotyol|xona`) — xom ko'rinishda.
 *
 * ⚠️ YANGI kontrakt (kotyol v2.1.0, xona v1.1.0). Eski proshivkada bu
 * sarlavha YO'Q — `null` qaytadi va tur tanadan aniqlanadi
 * (`inferDeviceType`). `X-Module-Type` — oraliq sinov proshivkasining
 * nomi, zaxira sifatida o'qiladi. Talqin — `parseDeviceType()`.
 */
export function extractDeviceTypeHeader(
  headers: Record<string, unknown>,
): string | null {
  for (const name of ['x-device-type', 'x-module-type']) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim())
      return value.trim().slice(0, 32);
  }
  return null;
}

/**
 * QURILMA SO'ROVINI O'QISH — IKKI KONTROLLER UCHUN BITTA joy.
 *
 * ⚠️⚠️ NIMA UCHUN ALOHIDA FUNKSIYA. Qurilma telemetriyasi UCH xil
 * manzilga kelishi mumkin:
 *   • `POST /api/data`                               — bizning eski `modul1`;
 *   • `POST /index.php/api/integrations/telemetry`   — v2.0.0 (qotirilgan);
 *   • `POST /api/v1/telemetry/ingest`                — toza, yangi manzil.
 * Ilgari ikkita kontrollerda AYNI kod (normallashtirish + validatsiya +
 * kalit ajratish) nusxa bo'lib turardi. Uchinchi manzil qo'shilganda
 * nusxa uchtaga chiqardi va `X-Device-Id` tekshiruvi ulardan faqat
 * bittasiga qo'shilib qolishi — vaqt masalasi edi.
 *
 * @throws BadRequestException — yuk shakli buzuq yoki kimlik ziddiyatli.
 */
export async function parseDeviceRequest(
  headers: Record<string, unknown>,
  body: unknown,
  query: Record<string, unknown>,
): Promise<{
  dto: IngestDto;
  apiKey: string | null;
  raw: Record<string, unknown>;
  firmwareVersion: string | null;
  deviceTypeHeader: string | null;
}> {
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const normalized = normalizePayload(raw);
  const headerDeviceId = extractDeviceId(headers);
  const bodyDeviceId =
    typeof normalized.deviceId === 'string' ? normalized.deviceId : null;

  /*
   * ⚠️⚠️ KIMLIK ZIDDIYATI — 400.
   *
   * v2.0.0 proshivkasi `X-Device-Id` sarlavhasini ham, tanadagi
   * `device_id` ni ham AYNI o'zgaruvchidan yasaydi (`net.cpp:21` va
   * `main.cpp` dagi `buildJson`), demak ular hech qachon farq
   * qilmaydi. Farq qilsa — bu yo'lda o'zgartirilgan so'rov yoki
   * buzuq proksi. Bunday yukni «bittasini tanlab» qabul qilish
   * ma'lumotni NOTO'G'RI kotyolga yozib qo'yishi mumkin edi.
   *
   * ⚠️ 400 ataylab: §3 bo'yicha qurilma 400/422 ni «butunlay yaroqsiz»
   * deb o'qiydi va o'lchovni TASHLAYDI — cheksiz qayta urinmaydi.
   */
  if (headerDeviceId && bodyDeviceId && headerDeviceId !== bodyDeviceId) {
    throw new BadRequestException(
      'X-Device-Id sarlavhasi tanadagi device_id bilan mos emas',
    );
  }

  /*
   * ⚠️ SARLAVHA USTUN TURADI: u BARCHA so'rovlarda bor, tana esa
   * faqat `POST` larda. Bitta manba tanlash kerak bo'lsa — universal
   * bo'lgani tanlanadi.
   */
  normalized.deviceId = headerDeviceId ?? bodyDeviceId ?? undefined;

  const dto = plainToInstance(IngestDto, normalized, {
    enableImplicitConversion: false,
  });

  /*
   * ⚠️ `forbidNonWhitelisted: false` — MAJBURIY. Proshivka `rssi`,
   * `uptime`, `heap` kabi qo'shimcha maydonlar yuborishi mumkin va
   * §3 ularni rad etishni TAQIQLAYDI («Noma'lum maydonlarni RAD
   * ETMA»). Ortiqcha maydonlar `rawPayload` ga tushadi va saqlanadi.
   */
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  if (errors.length) {
    const first = Object.values(errors[0].constraints ?? {})[0];
    throw new BadRequestException(first ?? 'Yuk formati noto‘g‘ri');
  }

  return {
    dto,
    apiKey: extractApiKey(headers, raw, query),
    raw,
    firmwareVersion: extractFirmwareVersion(headers),
    deviceTypeHeader: extractDeviceTypeHeader(headers),
  };
}
