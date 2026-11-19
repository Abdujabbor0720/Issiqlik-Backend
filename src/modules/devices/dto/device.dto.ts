import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { DeviceType } from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { toOptionalBoolean, trim } from '../../../common/dto/transforms';

export class CreateDeviceDto {
  @ApiProperty({
    description: 'Proshivkadagi DEVICE_ID',
    example: 'modul1',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Qurilma identifikatori kiritilmagan' })
  @MaxLength(64)
  /*
   * ⚠️ Faqat lotin harfi, raqam, `-` va `_`. Sabab: bu qiymat
   * mikrokontroller kodiga QO'LDA ko'chiriladi va probel yoki kirill
   * harfi bo'lsa, montajchi xatoni topa olmasdi — qurilma 401 qaytarib
   * turardi, sababi esa ko'rinmas belgida bo'lardi.
   */
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      'Identifikatorda faqat lotin harflari, raqamlar, «-» va «_» bo‘lishi mumkin',
  })
  deviceId!: string;

  @ApiPropertyOptional({ example: '1-maktab qozonxonasi moduli' })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Qaysi kotyolga biriktiriladi' })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiPropertyOptional({ enum: DeviceType, default: DeviceType.KOTYOL })
  @IsEnum(DeviceType, { message: 'Qurilma turi: kotyol yoki xona' })
  @IsOptional()
  deviceType?: DeviceType;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Paneldagi tuman (tuman mas‘uli uchun — faqat o‘z tumani)',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  districtId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Paneldagi muassasa (katalog yozuvi)',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  organizationId?: string | null;

  @ApiPropertyOptional({
    description:
      'Mavjud kalit (proshivkada allaqachon yozilgan bo‘lsa). ' +
      'Bo‘sh qoldirilsa — tizim yangi kalit generatsiya qiladi.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(128)
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {
  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  /** ⚠️ Kalitni tahrirlash orqali almashtirib bo'lmaydi — alohida amal. */
  apiKey?: never;
}

export class DeviceQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Faqat kotyolga biriktirilmaganlar' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({ description: 'Faqat aloqasi uzilganlar' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  offline?: boolean;

  /**
   * Shu tumandagi modullar (plata tumani yoki kotyol tumani) + tumansiz
   * biriktirilmagan eski platalar. Kotyol formasida modul tanlash uchun.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  districtId?: string;

  /** Faqat shu turdagi modullar (`boiler` — qozonxona, `room` — xona). */
  @ApiPropertyOptional({ enum: DeviceType })
  @IsEnum(DeviceType)
  @IsOptional()
  deviceType?: DeviceType;

  @ApiPropertyOptional({
    enum: ['online', 'offline'],
    description: 'onlayn — oxirgi telemetriya 5 daqiqadan yangi',
  })
  @IsIn(['online', 'offline'])
  @IsOptional()
  status?: 'online' | 'offline';

  @ApiPropertyOptional({
    example: '2.1.0',
    description: 'Proshivka versiyasi; `none` — versiyasi noma‘lum',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @IsOptional()
  version?: string;

  @ApiPropertyOptional({
    description: 'Faqat tasdiqlanmagan joylashuv taklifi borlar',
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  hasSuggestion?: boolean;
}

export const DEVICE_STATUSES = ['online', 'offline'] as const;
export type DeviceStatusFilter = (typeof DEVICE_STATUSES)[number];

/** Joylashuv taklifini tasdiqlash — qaysi maydonlar (sukut: hammasi). */
export class ConfirmLocationDto {
  @ApiPropertyOptional({
    type: [String],
    enum: ['district', 'objectType', 'institution'],
  })
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(['district', 'objectType', 'institution'], { each: true })
  @IsOptional()
  fields?: Array<'district' | 'objectType' | 'institution'>;
}

/**
 * «Yangi qurilmalar» → ro'yxatga olish. Hamma maydon ixtiyoriy: berilmasa
 * plata aytgan qiymat (taklif) olinadi — «bir bosishda».
 */
export class RegisterPendingDto {
  @ApiPropertyOptional({ enum: DeviceType })
  @IsEnum(DeviceType, { message: 'Qurilma turi: kotyol yoki xona' })
  @IsOptional()
  deviceType?: DeviceType;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  @IsOptional()
  districtId?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Katalogda yo‘q bo‘lsa — yangi muassasa nomi',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(180)
  @IsOptional()
  institutionName?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  objectTypeId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiPropertyOptional({
    description:
      'Qurilma kaliti. Berilmasa — qurilma so‘nggi so‘rovda yuborgan token qabul qilinadi',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(128)
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}
