import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { BoilerStatus, FuelType } from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  toArray,
  toNullable,
  toNullableNumber,
  toNumber,
  toOptionalBoolean,
  trim,
} from '../../../common/dto/transforms';

export class CreateBoilerDto {
  // ── Hujjat ma'lumotlari (foydalanuvchi bergan ro'yxat) ──

  @ApiProperty({ description: 'Tuman / shahar', format: 'uuid' })
  @IsUUID('4', { message: 'Tuman tanlanmagan' })
  districtId!: string;

  @ApiProperty({ description: 'Lot raqami', example: '2026-LOT-0114' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Lot raqami kiritilmagan' })
  @MaxLength(64)
  lotNumber!: string;

  @ApiPropertyOptional({ description: 'DXSH firma nomi', format: 'uuid' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  firmId?: string | null;

  @ApiPropertyOptional({ description: 'Tashkilot nomi', format: 'uuid' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  organizationId?: string | null;

  @ApiPropertyOptional({ description: 'Kotyol markasi', format: 'uuid' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  brandId?: string | null;

  @ApiProperty({ description: 'Kotyol soni', example: 2, default: 1 })
  @Transform(toNumber)
  @IsInt({ message: 'Kotyol soni butun son bo‘lishi kerak' })
  @Min(1, { message: 'Kotyol soni kamida 1 bo‘lishi kerak' })
  @Max(500)
  boilerCount = 1;

  @ApiPropertyOptional({
    description: '60 gradusda norma (hujjatdagi me‘yoriy ko‘rsatkich)',
    example: 1250.5,
  })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  normAt60?: number | null;

  // ── Qo'shimcha pasport ma'lumotlari ──

  @ApiPropertyOptional({ enum: FuelType, default: FuelType.GAS })
  @IsEnum(FuelType)
  @IsOptional()
  fuelType?: FuelType;

  @ApiPropertyOptional({ description: 'Quvvat, kVt' })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  capacityKw?: number | null;

  @ApiPropertyOptional({ description: 'O‘rnatilgan yil' })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1950)
  @Max(2100)
  @IsOptional()
  installedYear?: number | null;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string | null;

  @ApiPropertyOptional({ description: 'Xaritadagi kenglik' })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsLatitude({ message: 'Kenglik (lat) noto‘g‘ri' })
  @IsOptional()
  lat?: number | null;

  @ApiPropertyOptional({ description: 'Xaritadagi uzunlik' })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsLongitude({ message: 'Uzunlik (lng) noto‘g‘ri' })
  @IsOptional()
  lng?: number | null;

  @ApiPropertyOptional({ description: 'Mas‘ul shaxs' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(160)
  @IsOptional()
  responsibleName?: string | null;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(32)
  @IsOptional()
  responsiblePhone?: string | null;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string | null;
}

export class UpdateBoilerDto extends PartialType(CreateBoilerDto) {}

export class ArchiveBoilerDto {
  @ApiProperty({ description: 'Arxivlash sababi' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Sabab kiritilmagan' })
  @MaxLength(500)
  reason!: string;
}

export class BoilerQueryDto extends PaginationDto {
  @ApiPropertyOptional({ type: [String], description: 'Tumanlar' })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  districtIds?: string[];

  @ApiPropertyOptional({ enum: BoilerStatus, isArray: true })
  @Transform(toArray)
  @IsArray()
  @IsEnum(BoilerStatus, { each: true })
  @IsOptional()
  statuses?: BoilerStatus[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  firmId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  brandId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Arxivlanganlar ham ko‘rsatilsinmi' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  includeArchived?: boolean;

  @ApiPropertyOptional({ description: 'Faqat ESP32 moduli ulanmaganlar' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  withoutDevice?: boolean;
}
