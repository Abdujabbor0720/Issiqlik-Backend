import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AlertSeverity,
  EscalationCondition,
  IncidentKind,
  IncidentStatus,
  NotifyAudience,
} from '../../../common/constants/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  toArray,
  toNullable,
  toOptionalBoolean,
  trim,
} from '../../../common/dto/transforms';

const ESCALATION_TARGETS = [
  NotifyAudience.DISTRICT,
  NotifyAudience.AGENCY,
  NotifyAudience.REGION,
];

export class IncidentQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: IncidentStatus,
    isArray: true,
    description: 'Sukut: faqat faol (new, acknowledged, in_progress)',
  })
  @Transform(toArray)
  @IsArray()
  @IsEnum(IncidentStatus, { each: true })
  @IsOptional()
  statuses?: IncidentStatus[];

  @ApiPropertyOptional({ enum: IncidentKind, isArray: true })
  @Transform(toArray)
  @IsArray()
  @IsEnum(IncidentKind, { each: true })
  @IsOptional()
  kinds?: IncidentKind[];

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

  @ApiPropertyOptional({ type: [String] })
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  agencyIds?: string[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  boilerId?: string;

  @ApiPropertyOptional({ description: 'Faqat eskalatsiya qilinganlar' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  escalated?: boolean;

  @ApiPropertyOptional({ description: 'Aniqlangan vaqt — dan (ISO)' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Aniqlangan vaqt — gacha (ISO)' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

/** Qabul qilish / yopish — izoh ixtiyoriy. */
export class IncidentOptionalNoteDto {
  @ApiPropertyOptional({ description: 'Izoh' })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string | null;
}

/**
 * Chora boshlash / bartaraf etish / qayta ochish — izoh MAJBURIY.
 *
 * ⚠️ «Bartaraf etildi» izohsiz qabul qilinmaydi: texnik topshiriq §6
 * «bajarilgan ishlar haqida ma'lumot» talab qiladi va aynan shu matn
 * keyin yopayotgan mas'ul uchun tekshiruv asosi.
 */
export class IncidentRequiredNoteDto {
  @ApiProperty({ description: 'Nima qilinmoqda / nima qilindi' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Izoh kiritilmagan' })
  @MinLength(3, { message: 'Izoh juda qisqa' })
  @MaxLength(2000)
  note!: string;
}

export class IncidentCommentDto extends IncidentRequiredNoteDto {
  @ApiPropertyOptional({
    enum: ['comment', 'action'],
    default: 'comment',
    description: '`action` — bajarilgan ish (hisobotda alohida)',
  })
  @IsIn(['comment', 'action'])
  @IsOptional()
  kind?: 'comment' | 'action';
}

export class RecurringQueryDto {
  @ApiPropertyOptional({ default: 30, description: 'Necha kunlik davr' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  days = 30;

  @ApiPropertyOptional({
    default: 2,
    description: 'Kamida necha marta (hodisa + qayta ochilish)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(1000)
  @IsOptional()
  minCount = 2;
}

export class IncidentReportQueryDto {
  @ApiPropertyOptional({ description: 'Davr boshi (ISO). Sukut: 30 kun oldin' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Davr oxiri (ISO). Sukut: hozir' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    enum: ['district', 'agency', 'organization', 'kind'],
    default: 'district',
  })
  @IsIn(['district', 'agency', 'organization', 'kind'])
  @IsOptional()
  groupBy: 'district' | 'agency' | 'organization' | 'kind' = 'district';
}

export class NotificationQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Faqat o‘qilmaganlar' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;
}

export class EscalationRuleItemDto {
  @ApiPropertyOptional({
    enum: AlertSeverity,
    nullable: true,
    description: 'Bo‘sh — barcha og‘irlik uchun',
  })
  @Transform(toNullable)
  @ValidateIf((_object, value) => value !== null)
  @IsEnum(AlertSeverity)
  @IsOptional()
  severity?: AlertSeverity | null;

  @ApiProperty({ minimum: 1, maximum: 9 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9)
  level!: number;

  @ApiProperty({ enum: EscalationCondition })
  @IsEnum(EscalationCondition)
  condition!: EscalationCondition;

  @ApiProperty({ minimum: 1, maximum: 10080, description: 'Daqiqa' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10080)
  afterMinutes!: number;

  @ApiProperty({ enum: ESCALATION_TARGETS })
  @IsIn(ESCALATION_TARGETS, {
    message: 'Eskalatsiya nishoni: district | agency | region',
  })
  target!: NotifyAudience;

  @ApiPropertyOptional({ default: true })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class ReplaceEscalationRulesDto {
  @ApiProperty({ type: [EscalationRuleItemDto] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => EscalationRuleItemDto)
  rules!: EscalationRuleItemDto[];
}
