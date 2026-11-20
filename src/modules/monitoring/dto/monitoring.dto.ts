import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ScheduleMode, ScheduleScope } from '../../../common/constants/enums';
import {
  toNullable,
  toNullableNumber,
  toOptionalBoolean,
  trim,
} from '../../../common/dto/transforms';

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HM_MESSAGE = 'Vaqt HH:mm ko‘rinishida bo‘lishi kerak (masalan 07:00)';

/**
 * JADVALNI SAQLASH — nishon bo'yicha UPSERT (bitta nishonda bitta jadval).
 *
 * ⚠️ `schedule` rejimida kunlar va to'rtala vaqt MAJBURIY (servisda
 * tekshiriladi): yarim to'ldirilgan jadval «07:00 dan …qachongacha?»
 * degan savolni ochiq qoldirardi va XAVF jimgina yo ochilmas, yo
 * yopilmas edi.
 */
export class UpsertScheduleDto {
  @ApiProperty({ enum: ScheduleScope })
  @IsEnum(ScheduleScope, { message: 'Jadval darajasi noto‘g‘ri' })
  scopeType!: ScheduleScope;

  @ApiPropertyOptional({
    description:
      'Qozonxona / muassasa / obyekt turi identifikatori (`global` da bo‘sh)',
    format: 'uuid',
  })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  scopeId?: string | null;

  @ApiProperty({ enum: ScheduleMode })
  @IsEnum(ScheduleMode, { message: 'Rejim noto‘g‘ri (always | schedule)' })
  mode!: ScheduleMode;

  @ApiPropertyOptional({
    description: 'ISO hafta kunlari: 1 — dushanba … 7 — yakshanba',
    example: [1, 2, 3, 4, 5, 6],
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  @IsOptional()
  activeDays?: number[];

  @ApiPropertyOptional({ example: '06:00', description: 'Isitish boshlanishi' })
  @Matches(HM, { message: HM_MESSAGE })
  @IsOptional()
  heatingStart?: string;

  @ApiPropertyOptional({ example: '18:00', description: 'Isitish tugashi' })
  @Matches(HM, { message: HM_MESSAGE })
  @IsOptional()
  heatingEnd?: string;

  @ApiPropertyOptional({
    example: '07:00',
    description: 'Past xona harorati XAVF monitoringi boshlanishi',
  })
  @Matches(HM, { message: HM_MESSAGE })
  @IsOptional()
  monitorStart?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @Matches(HM, { message: HM_MESSAGE })
  @IsOptional()
  monitorEnd?: string;

  @ApiPropertyOptional({
    description:
      'Minimal xona harorati, °C. Bo‘sh — tasdiqlangan umumiy sozlamadan',
    example: 18,
  })
  @Transform(toNullableNumber)
  @ValidateIf((_object, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(40)
  @IsOptional()
  minRoomTemperature?: number | null;

  @ApiPropertyOptional({
    description: 'Bayram kunlari monitoringdan chiqariladimi',
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  observeHolidays?: boolean;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string | null;
}

export class ScheduleQueryDto {
  @ApiPropertyOptional({ enum: ScheduleScope })
  @IsEnum(ScheduleScope)
  @IsOptional()
  scopeType?: ScheduleScope;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  scopeId?: string;
}

export class EffectiveScheduleQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Qozonxona (obyekt)' })
  @IsUUID('4')
  boilerId!: string;
}

export class CreateHolidayDto {
  @ApiProperty({ example: '2027-01-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Sana YYYY-MM-DD ko‘rinishida bo‘lishi kerak',
  })
  day!: string;

  @ApiProperty({ example: 'Yangi yil' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Nomi kiritilmagan' })
  @MaxLength(160)
  name!: string;
}

export class HolidayQueryDto {
  @ApiPropertyOptional({ example: 2027 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  @IsOptional()
  year?: number;
}
