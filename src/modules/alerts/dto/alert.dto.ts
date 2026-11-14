import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  AlertSeverity,
  AlertState,
  AlertType,
} from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { toArray, trim } from '../../../common/dto/transforms';

export class AlertQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: AlertState, isArray: true })
  @Transform(toArray)
  @IsArray()
  @IsEnum(AlertState, { each: true })
  @IsOptional()
  states?: AlertState[];

  @ApiPropertyOptional({ enum: AlertType, isArray: true })
  @Transform(toArray)
  @IsArray()
  @IsEnum(AlertType, { each: true })
  @IsOptional()
  types?: AlertType[];

  @ApiPropertyOptional({ enum: AlertSeverity })
  @IsEnum(AlertSeverity)
  @IsOptional()
  severity?: AlertSeverity;

  @ApiPropertyOptional({ type: [String] })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  districtIds?: string[];
}

export class AcknowledgeDto {
  @ApiProperty({ description: 'Nima qilinmoqda — qisqa izoh' })
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note!: string;
}
