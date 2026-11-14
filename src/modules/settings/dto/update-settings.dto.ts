import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { toNumber, trim } from '../../../common/dto/transforms';

export class UpdateSettingsDto {
  @ApiPropertyOptional({ description: '«Faol» chegarasi, °C', example: 50 })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(150)
  @IsOptional()
  activeMinC?: number;

  @ApiPropertyOptional({ description: '«O‘rta» chegarasi, °C', example: 40 })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(150)
  @IsOptional()
  mediumMinC?: number;

  @ApiPropertyOptional({ description: 'Kritik chegara, °C', example: 20 })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(150)
  @IsOptional()
  criticalMinC?: number;

  @ApiPropertyOptional({ description: 'Ortiqcha qizish, °C', example: 95 })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(30)
  @Max(200)
  @IsOptional()
  overheatC?: number;

  /**
   * ⚠️ Chegara `Min(0.5)` dan boshlanadi, 0 dan EMAS: nol chegara
   * «sirkulyatsiya yo'q» xabarini har bir o'lchovda ochardi va
   * butun park bir zumda qizil bo'lib qolardi. Baza darajasida ham
   * shu himoya bor (`CHK_system_settings_min_delta`) — ikkalasi
   * kerak, chunki bazaga skript orqali ham yozish mumkin.
   */
  @ApiPropertyOptional({
    description: 'Sirkulyatsiya chegarasi (kirish-chiqish ayirmasi), °C',
    example: 3,
  })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(99)
  @IsOptional()
  minDeltaC?: number;

  @ApiPropertyOptional({ description: 'Aloqa yo‘q deb hisoblash, daqiqa' })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(1440)
  @IsOptional()
  offlineAfterMinutes?: number;

  @ApiPropertyOptional({ description: 'Me‘yoriy harorat, °C', example: 60 })
  @Transform(toNumber)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(150)
  @IsOptional()
  normTemperature?: number;

  @ApiPropertyOptional({ description: 'Telemetriya saqlash muddati, kun' })
  @Transform(toNumber)
  @IsInt()
  @Min(7)
  @Max(3650)
  @IsOptional()
  retentionDays?: number;

  @ApiPropertyOptional({ description: 'Mavsum yorlig‘i: «2026–2027»' })
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @IsOptional()
  seasonLabel?: string;
}
