import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsUUID,
} from 'class-validator';
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
}
