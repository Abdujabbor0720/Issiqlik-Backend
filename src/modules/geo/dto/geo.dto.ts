import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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
  /** Proshivka kaliti (`asaka`). */
  key: string;
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
  lotNumber: string | null;
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

/**
 * YANGI TUMAN. ⚠️ `key` — proshivka menyusidagi kalit bilan AYNI bo'lishi
 * shart va keyin o'zgartirilmaydi.
 */
export class CreateDistrictDto {
  @ApiProperty({ example: 'yangi-tuman', description: 'Proshivka kaliti' })
  @Matches(/^[a-z][a-z0-9-]{1,31}$/, {
    message: 'Kalit: kichik lotin harflari, raqam va «-», 2–32 belgi',
  })
  key!: string;

  @ApiProperty({ example: 'Yangi tumani' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: 'Yangi' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  shortName?: string;

  @ApiProperty({ enum: ['city', 'district'] })
  @IsIn(['city', 'district'])
  kind!: 'city' | 'district';

  @ApiPropertyOptional({ example: '1703250' })
  @Matches(/^\d{4,10}$/)
  @IsOptional()
  soato?: string;

  @ApiProperty({ example: 40.78 })
  @IsNumber()
  @Min(39)
  @Max(42)
  centerLat!: number;

  @ApiProperty({ example: 72.34 })
  @IsNumber()
  @Min(70)
  @Max(74)
  centerLng!: number;
}
