import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUUID } from 'class-validator';
import { toArray } from '../../../common/dto/transforms';

export class MapQueryDto {
  @ApiPropertyOptional({
    description: 'Tanlangan tumanlar — faqat shular bo‘yicha sanaladi',
    type: [String],
  })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  districtIds?: string[];
}

/** Xaritadagi bitta tuman ustida ko'rinadigan raqamlar. */
export interface DistrictStats {
  districtId: string;
  code: string;
  name: string;
  shortName: string;
  kind: string;
  centerLat: number;
  centerLng: number;
  /** Qozonxonalar (lotlar) soni. */
  total: number;
  /** Qozonxonalardagi kotyollar yig'indisi. */
  boilerUnits: number;
  active: number;
  medium: number;
  inactive: number;
  offline: number;
  /** Ishlayotgan (`active + medium`) ulushi, %. */
  workingPercent: number;
  /** O'rtacha chiqish harorati, °C. `null` — o'lchov yo'q. */
  avgTemperature: number | null;
  /** Ustun holat — xaritadagi belgi rangini shu beradi. */
  dominantStatus: string;
}

export interface DistrictGeoJson {
  type: 'FeatureCollection';
  bbox: number[] | null;
  features: Array<{
    type: 'Feature';
    properties: DistrictStats;
    geometry: Record<string, unknown> | null;
  }>;
}

/** Xaritadagi bitta kotyol nuqtasi. */
export interface BoilerPoint {
  id: string;
  lotNumber: string;
  organizationName: string | null;
  districtId: string;
  districtName: string;
  lat: number;
  lng: number;
  status: string;
  temperature: number | null;
  boilerCount: number;
  lastReadingAt: string | null;
  /**
   * XONALAR — nazoratdagi va dolzarb o'lchovlilar bo'yicha.
   * `null` — xona yo'q yoki hammasining o'lchovi eskirgan.
   */
  rooms: {
    count: number;
    avg: number | null;
    min: number | null;
    /** Minimumdan past xonalar soni. */
    cold: number;
  } | null;
}
