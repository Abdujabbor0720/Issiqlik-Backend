import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { trim } from '../../../common/dto/transforms';

export class LoginDto {
  // ⚠️ Misol HAQIQIY login bo'lmasligi kerak — Swagger ommaviy ko'rinadi.
  @ApiProperty({ example: 'masul.asaka' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Login kiritilmagan' })
  @MaxLength(64)
  login!: string;

  /*
   * ⚠️ Swagger misoli HAQIQIY parol bo'lmasligi kerak: u ommaviy
   *    repozitoriyada ham, /docs sahifasida ham ko'rinadi.
   */
  @ApiProperty({ example: '••••••••' })
  @IsString()
  @IsNotEmpty({ message: 'Parol kiritilmagan' })
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Refresh token yuborilmagan' })
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Joriy parol kiritilmagan' })
  currentPassword!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Yangi parol kamida 8 belgi bo‘lishi kerak' })
  @MaxLength(128)
  newPassword!: string;
}

export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiPropertyOptional({ description: 'Access token muddati, soniya' })
  expiresIn!: number;
}
