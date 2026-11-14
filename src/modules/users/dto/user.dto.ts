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
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  toOptionalBoolean,
  trim,
  trimLower,
} from '../../../common/dto/transforms';

export class CreateUserDto {
  @ApiProperty({ example: 'operator.jalaquduq' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Login kiritilmagan' })
  @MinLength(3, { message: 'Login kamida 3 belgi bo‘lishi kerak' })
  @MaxLength(64)
  login!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Parol kamida 8 belgi bo‘lishi kerak' })
  @MaxLength(128)
  password!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'F.I.Sh kiritilmagan' })
  @MaxLength(160)
  fullName!: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole, { message: 'Rol noto‘g‘ri' })
  role!: UserRole;

  @ApiPropertyOptional({ description: 'Operator uchun — biriktirilgan tuman' })
  @IsUUID('4')
  @IsOptional()
  districtId?: string;

  @ApiPropertyOptional()
  @Transform(trimLower)
  @IsEmail({}, { message: 'Email formati noto‘g‘ri' })
  @IsOptional()
  email?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  @IsOptional()
  position?: string;
}

/**
 * ⚠️ `password` yangilashda ALOHIDA endpoint orqali: `PartialType` ichida
 * qolsa, foydalanuvchini tahrirlash formasi tasodifan parolni ham
 * yuborib yuborardi (bo'sh satr bilan ham).
 */
export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  password?: never;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Parol kamida 8 belgi bo‘lishi kerak' })
  @MaxLength(128)
  newPassword!: string;
}

export class UserQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: UserRole })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @ApiPropertyOptional()
  @IsUUID('4')
  @IsOptional()
  districtId?: string;

  @ApiPropertyOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
