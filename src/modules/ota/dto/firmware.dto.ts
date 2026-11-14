import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RolloutStatus,
  RolloutTargetType,
} from '../../../common/constants/enums';
import { toArray, toNumber, trim } from '../../../common/dto/transforms';

/** Fayl bilan birga keladigan maydonlar (`multipart/form-data`). */
export class UploadFirmwareDto {
  /**
   * Administrator kiritgan versiya — IXTIYORIY.
   *
   * ⚠️⚠️ Bu qiymat versiyani BELGILAMAYDI: versiya `.bin` ichidagi
   * `XONOBOD_FW_VERSION=x.y.z;` belgisidan o'qiladi. Bu maydon faqat
   * TEKSHIRUV uchun: kiritilgani fayl ichidagisiga mos kelmasa,
   * yuklash RAD etiladi (§9.2). Ya'ni u administratorning «men nima
   * yuklayotganimni bilaman» degan tasdig'i.
   */
  @ApiPropertyOptional({ example: '2.0.1' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  @IsOptional()
  version?: string;

  @ApiPropertyOptional({ example: 'Obratka datchigi tuzatildi' })
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  note?: string;
}

export class CreateRolloutDto {
  @ApiProperty()
  @IsUUID()
  releaseId!: string;

  @ApiProperty({
    enum: RolloutTargetType,
    example: RolloutTargetType.DISTRICTS,
  })
  @IsEnum(RolloutTargetType)
  targetType!: RolloutTargetType;

  /**
   * Maqsad ro'yxati — tuman, obyekt turi yoki qurilma UUID lari.
   *
   * ⚠️ `ArrayMaxSize(2000)`: ro'yxat `jsonb` ustunga tushadi va
   * cheklovsiz bo'lsa, bitta so'rov bilan bazaga megabaytlab ma'lumot
   * yozib qo'yish mumkin bo'lardi.
   */
  @ApiPropertyOptional({ type: [String] })
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('4', { each: true })
  @IsOptional()
  targetIds?: string[];

  /**
   * SINOV REJIMI — bir vaqtda ko'pi bilan shuncha qurilma.
   *
   * ⚠️⚠️ `1` — «avval bitta qurilmada sinab ko'rish» (§9.3). Yaroqsiz
   * proshivka butun viloyatni bir zumda qaytish halqasiga solmaydi.
   * Yuqori chegara 2000: undan ko'p qurilma bir vaqtda 1.9 MB yuklab
   * olsa, kanal to'lib, telemetriya ham o'tmay qolardi.
   */
  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(2000)
  @IsOptional()
  maxDevices?: number;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

export class UpdateRolloutStatusDto {
  /**
   * ⚠️ `done` QO'LDA QO'YILMAYDI: u faqat barcha maqsadli qurilma
   * yangilanganda, server tomonidan belgilanadi. Qo'lda qo'yilsa,
   * tarqatish hali tugamagan bo'lsa ham «tugadi» bo'lib ko'rinardi
   * va qolgan qurilmalar jimgina eski versiyada qolardi. Shuning
   * uchun ro'yxatda faqat uch holat bor.
   */
  @ApiProperty({
    enum: [RolloutStatus.ACTIVE, RolloutStatus.PAUSED, RolloutStatus.CANCELLED],
  })
  @IsEnum(RolloutStatus)
  status!: RolloutStatus;
}
