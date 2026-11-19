import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { toArray } from '../../../common/dto/transforms';

export const TREND_RANGES = ['24h', '7d', '30d'] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

export class DashboardQueryDto {
  @ApiPropertyOptional({ type: [String], description: 'Tanlangan tumanlar' })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  districtIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Obyekt turlari («Kataloglar → Obyekt turlari» id)',
  })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  objectTypeIds?: string[];
}

export class TrendQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({ enum: TREND_RANGES, default: '24h' })
  @IsIn(TREND_RANGES)
  @IsOptional()
  range: TrendRange = '24h';
}

/**
 * DASHBOARD KARTALARI.
 *
 * ⚠️ `total` — QOZONXONALAR (lotlar) soni, `boilerUnits` esa ulardagi
 * kotyollar YIG'INDISI. Ikkalasi ham kerak va ular ALOHIDA: bitta
 * qozonxonada 3 ta kotyol bo'lishi mumkin va «196 ta obyekt» bilan
 * «412 ta kotyol» butunlay boshqa raqamlar. Bitta maydon bo'lsa,
 * hisobotdagi raqam hujjatdagi raqam bilan mos kelmasdi.
 */
export interface DashboardSummary {
  total: number;
  boilerUnits: number;
  /** `active + medium` — umumiy ishlayotganlar. */
  working: number;
  workingPercent: number;
  active: number;
  activePercent: number;
  medium: number;
  mediumPercent: number;
  inactive: number;
  inactivePercent: number;
  offline: number;
  offlinePercent: number;
  avgTemperature: number | null;
  /** Hujjatdagi me'yor (60 °C) — kartadagi taqqoslash uchun. */
  normTemperature: number;
  openAlerts: number;
  devicesTotal: number;
  devicesOnline: number;
  readingsLast24h: number;
  /** Xaritada ko'rinmaydigan (koordinatasiz) kotyollar soni. */
  withoutCoordinates: number;
  /** ESP32 moduli ulanmagan kotyollar soni. */
  withoutDevice: number;
  updatedAt: string;
}

export interface DistrictRow {
  districtId: string;
  /** Proshivka kaliti (`asaka`). */
  districtKey: string;
  name: string;
  shortName: string;
  /** Faol qurilmalar (amaldagi tumani shu tuman). */
  devicesTotal: number;
  /** Oxirgi telemetriya 5 daqiqadan yangi. */
  devicesOnline: number;
  devicesOffline: number;
  /** O'lchovi bor va chiqish harorati me'yordan past kotyollar. */
  belowNorm: number;
  /** Ochiq ogohlantirishlar (kotyol va xona). */
  openAlerts: number;
  total: number;
  boilerUnits: number;
  active: number;
  medium: number;
  inactive: number;
  offline: number;
  workingPercent: number;
  avgTemperature: number | null;
}

export interface TrendPoint {
  t: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  active: number;
  medium: number;
  inactive: number;
  offline: number;
}

/**
 * MUASSASALAR SHKALASI — bitta kotyol (qozonxona) qatori.
 *
 * ⚠️ `inletDelta` / `outletDelta` — OLDINGI o'lchovga nisbatan o'zgarish
 * (°C, 0,1 gacha). Oldingi o'lchov yo'q yoki unda shu qiymat bo'lmasa —
 * `null` («o'zgarish noma'lum», nol emas).
 */
export interface GaugeItem {
  boilerId: string;
  lotNumber: string | null;
  organizationName: string | null;
  objectTypeId: string | null;
  objectTypeName: string | null;
  objectTypeCode: string | null;
  districtId: string;
  districtName: string;
  districtShortName: string;
  status: string;
  inlet: number | null;
  outlet: number | null;
  inletDelta: number | null;
  outletDelta: number | null;
  lastReadingAt: string | null;
  hasDevice: boolean;
}

export interface GaugeBoard {
  /** Shkaladagi me'yor belgisi (chiqish), °C — sozlamalardan. */
  normTemperature: number;
  items: GaugeItem[];
  updatedAt: string;
}
