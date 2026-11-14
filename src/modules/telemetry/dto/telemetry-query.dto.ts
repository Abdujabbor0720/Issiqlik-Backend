import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { toArray, toNumber } from '../../../common/dto/transforms';

/** Grafik qadami — `hour` kunlik ko'rinish, `day` oylik ko'rinish uchun. */
export const BUCKETS = ['raw', 'hour', 'day'] as const;
export type Bucket = (typeof BUCKETS)[number];

export class TelemetryQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiPropertyOptional({ type: [String] })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  districtIds?: string[];

  @ApiPropertyOptional({ description: 'Boshlanish (ISO)' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Tugash (ISO)' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ enum: BUCKETS, default: 'hour' })
  @IsIn(BUCKETS)
  @IsOptional()
  bucket: Bucket = 'hour';

  @ApiPropertyOptional({ default: 500, maximum: 5000 })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  limit = 500;
}
