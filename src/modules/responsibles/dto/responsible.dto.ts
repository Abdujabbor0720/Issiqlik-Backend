import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ResponsibilityType } from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  toNullable,
  toOptionalBoolean,
  trim,
} from '../../../common/dto/transforms';

/** Xizmat telefoni: raqamlar, `+`, bo'shliq, qavs, chiziqcha. */
const PHONE = /^\+?[0-9][0-9 ()-]{6,30}$/;

export class CreateResponsibleDto {
  @ApiProperty({ example: 'Karimov Anvar Tohirovich' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'F.I.Sh kiritilmagan' })
  @MaxLength(160)
  fullName!: string;

  @ApiProperty({ example: 'Xo‘jalik ishlari bo‘yicha direktor o‘rinbosari' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Lavozimi kiritilmagan' })
  @MaxLength(160)
  position!: string;

  @ApiPropertyOptional({ example: 'Baliqchi tumani 4-sonli maktab' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(200)
  @IsOptional()
  employer?: string | null;

  @ApiProperty({ example: '+998 90 123 45 67', description: 'Xizmat telefoni' })
  @Transform(trim)
  @Matches(PHONE, { message: 'Telefon raqami noto‘g‘ri' })
  phone!: string;

  @ApiPropertyOptional({ description: 'Xizmat email manzili' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.trim() === ''
        ? null
        : value.trim().toLowerCase()
      : value,
  )
  @ValidateIf((_object, value) => value !== null)
  @IsEmail({}, { message: 'Email formati noto‘g‘ri' })
  @MaxLength(160)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({
    description:
      'Uy tumani. Tuman mas‘uli uchun — majburan o‘z tumani; bo‘sh — viloyat darajasi',
    format: 'uuid',
  })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  districtId?: string | null;

  @ApiPropertyOptional({
    description: 'Panelga kiradigan hisob (`responsible` roli)',
    format: 'uuid',
  })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  userId?: string | null;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string | null;
}

/**
 * ⚠️ O'CHIRISH YO'Q — faqat `isActive: false`. O'tgan hodisalar javobgarni
 * muhrlab olgan, reyestrdan esa u «kim edi» degan savolga javob beradi.
 */
export class UpdateResponsibleDto extends PartialType(CreateResponsibleDto) {
  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class ResponsibleQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  districtId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Shu muassasaga biriktirilganlar',
  })
  @IsUUID('4')
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Shu obyektga (yoki uning muassasasiga) biriktirilganlar',
  })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** Biriktirish: muassasa YOKI aniq obyekt (bittasi). */
export class CreateAssignmentDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Muassasa' })
  @IsUUID('4')
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Aniq qozonxona (obyekt)',
  })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiProperty({ enum: ResponsibilityType })
  @IsEnum(ResponsibilityType, { message: 'Javobgarlik turi noto‘g‘ri' })
  responsibilityType!: ResponsibilityType;

  @ApiPropertyOptional({
    description:
      'Asosiy javobgar. Nishonda boshqa asosiy bo‘lsa — u qo‘shimchaga o‘tkaziladi',
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(300)
  @IsOptional()
  note?: string | null;
}

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ enum: ResponsibilityType })
  @IsEnum(ResponsibilityType)
  @IsOptional()
  responsibilityType?: ResponsibilityType;

  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(300)
  @IsOptional()
  note?: string | null;
}
