import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { trim } from '../../../common/dto/transforms';
import { CreateBoilerDto } from '../../boilers/dto/boiler.dto';

/** Modul bilan nima qilinadi. */
export enum SetupDeviceMode {
  /** Modulsiz — keyin biriktiriladi. */
  NONE = 'none',
  /**
   * RO'YXATDAGI biriktirilmagan modul — eng ko'p uchraydigan holat:
   * plata umumiy token bilan o'zi ro'yxatga tushgan.
   */
  EXISTING = 'existing',
  /** YANGI modul — identifikator qo'lda (plata hali ulanmagan). */
  NEW = 'new',
}

export class SetupDeviceDto {
  @ApiProperty({ enum: SetupDeviceMode, example: SetupDeviceMode.EXISTING })
  @IsEnum(SetupDeviceMode, { message: 'Modul rejimi noto‘g‘ri' })
  mode!: SetupDeviceMode;

  /** `existing` — tizimdagi qurilma yozuvining UUID'i. */
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((dto: SetupDeviceDto) => dto.mode === SetupDeviceMode.EXISTING)
  @IsUUID('4', { message: 'Biriktiriladigan modul tanlanmagan' })
  existingId?: string;

  /**
   * `new` — ESP32 identifikatori (`esp32-a4cf12…`).
   *
   * ⚠️ Shakl `CreateDeviceDto.deviceId` bilan AYNI: bu ham qurilma
   * yaratish yo'li va bir yo'ldan o'tmaydigan identifikator ikkinchisidan
   * o'tib ketmasligi kerak.
   */
  @ApiPropertyOptional({ example: 'esp32-a4cf12e8b901' })
  @ValidateIf((dto: SetupDeviceDto) => dto.mode === SetupDeviceMode.NEW)
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Modul identifikatori kiritilmagan' })
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      'Identifikatorda faqat lotin harflari, raqamlar, «-» va «_» bo‘lishi mumkin',
  })
  deviceId?: string;

  @ApiPropertyOptional({ example: '4-maktab qozonxonasi moduli' })
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  @IsOptional()
  name?: string;
}

/**
 * KOTYOL + MODUL — BITTA FORMADA.
 *
 * ⚠️⚠️ BITTA TRANZAKSIYA: muassasa (kerak bo'lsa) → kotyol → modul.
 * Biror qadam yiqilsa, HECH NARSA yozilmaydi. Aks holda «modul band»
 * xatosidan keyin kotyol baribir yaratilib qolardi va foydalanuvchi
 * formani qayta yuborganda «lot raqami band» degan ikkinchi xatoga
 * urilardi.
 */
export class BoilerSetupDto {
  @ApiProperty({ type: CreateBoilerDto })
  @ValidateNested()
  @Type(() => CreateBoilerDto)
  boiler!: CreateBoilerDto;

  /**
   * YANGI MUASSASA NOMI — ro'yxatda yo'q bo'lsa.
   *
   * ⚠️⚠️ Tuman mas'ulida katalogni boshqarish huquqi (`catalogs.manage`)
   * YO'Q va bu ataylab: u markalar, firmalar va turlarni butun viloyat
   * bo'yicha o'zgartirishga ruxsat berardi. Bu yerda esa FAQAT o'z
   * kotyoli uchun muassasa NOMINI qo'shadi — tahrirlash yoki arxivlash
   * emas. Nom allaqachon bo'lsa (katta-kichik harf farqisiz), mavjudi
   * ishlatiladi — nusxa yaratilmaydi.
   *
   * `boiler.organizationId` bilan BIRGA yuborilmaydi.
   */
  @ApiPropertyOptional({ example: 'Xonobod shahar 4-umumta‘lim maktabi' })
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Muassasa nomi juda qisqa' })
  @MaxLength(180)
  @IsOptional()
  newOrganizationName?: string;

  /** Yangi muassasa turi (maktab, bog'cha…) — `object_types` dan. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  newOrganizationTypeId?: string;

  @ApiProperty({ type: SetupDeviceDto })
  @ValidateNested()
  @Type(() => SetupDeviceDto)
  device!: SetupDeviceDto;
}
