import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  toNullable,
  toOptionalBoolean,
  trim,
  trimLower,
} from '../../../common/dto/transforms';

export class CreateCatalogItemDto {
  @ApiProperty({ example: 'Ferroli' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Nomi kiritilmagan' })
  @MaxLength(180)
  name!: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;

  // ── Faqat marka uchun ──
  @ApiPropertyOptional({
    description: 'Faqat marka: ishlab chiqaruvchi davlat',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  country?: string;

  // ── Faqat firma uchun ──
  @ApiPropertyOptional({ description: 'Faqat firma: STIR' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  @IsOptional()
  tin?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Faqat firma: rahbar F.I.Sh' })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  @IsOptional()
  directorName?: string;

  // ── Faqat tashkilot uchun ──
  @ApiPropertyOptional({ description: 'Obyekt turi', format: 'uuid' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  objectTypeId?: string | null;

  // ── Muassasa va MFY uchun: tuman kaliti (`asaka`, `andijon-sh`) ──
  @ApiPropertyOptional({
    description:
      'Muassasa va MFY: tuman kaliti (`districts.key`). MFY uchun majburiy.',
    example: 'asaka',
  })
  @Transform(trimLower)
  @Matches(/^[a-z][a-z0-9-]{1,31}$/, { message: 'Tuman kaliti noto‘g‘ri' })
  @IsOptional()
  districtKey?: string;

  @ApiPropertyOptional({ description: 'Faqat muassasa: MFY', format: 'uuid' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  mahallaId?: string | null;

  @ApiPropertyOptional({
    description:
      'Faqat muassasa: qaysi tashkilot/boshqarmaga qarashli (XAVF shu idoraga ham boradi)',
    format: 'uuid',
  })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  agencyId?: string | null;

  // ── Faqat obyekt turi uchun ──
  @ApiPropertyOptional({
    description: 'Mashina kaliti (`school`, `hospital`) — keyin o‘zgarmaydi',
    example: 'sport_school',
  })
  @Transform(trimLower)
  @Matches(/^[a-z0-9_]+$/, {
    message:
      'Kalitda faqat kichik lotin harflari, raqam va «_» bo‘lishi mumkin',
  })
  @MaxLength(40)
  @IsOptional()
  code?: string;
}

export class UpdateCatalogItemDto extends PartialType(CreateCatalogItemDto) {
  @ApiPropertyOptional({ description: 'Arxivlash — o‘chirish o‘rniga' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isArchived?: boolean;
}

export class CatalogQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Arxivlanganlar ham ko‘rsatilsinmi' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  includeArchived?: boolean;

  @ApiPropertyOptional({
    description: 'Muassasa va MFY: faqat shu tuman (kalit)',
    example: 'asaka',
  })
  @Transform(trimLower)
  @Matches(/^[a-z][a-z0-9-]{1,31}$/, { message: 'Tuman kaliti noto‘g‘ri' })
  @IsOptional()
  districtKey?: string;

  @ApiPropertyOptional({
    description: 'Muassasa: faqat shu obyekt turi',
    format: 'uuid',
  })
  @IsUUID('4')
  @IsOptional()
  objectTypeId?: string;

  @ApiPropertyOptional({
    description: 'Muassasa: faqat shu tashkilotga qarashlilar',
    format: 'uuid',
  })
  @IsUUID('4')
  @IsOptional()
  agencyId?: string;
}
