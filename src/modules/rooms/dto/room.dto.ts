import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { toBoolean, toNumber, trim } from '../../../common/dto/transforms';
import type { RoomCondition } from '../../../helpers/room-reading.helper';

/**
 * XONANI TAHRIRLASH.
 *
 * ⚠️ `sensorKey` BU YERDA YO'Q va bu ataylab: kalit — datchikning
 * jismoniy manzili. Uni kabinetdan o'zgartirish mumkin bo'lsa, xona
 * boshqa datchikka «ko'chib», tarixi esa eski datchikniki bo'lib
 * qolardi — grafikda bitta chiziq ikki xil xonani ko'rsatardi.
 */
export class UpdateRoomDto {
  @ApiPropertyOptional({ example: '1-sinf' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Xona nomi bo‘sh bo‘lmasligi kerak' })
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: '2-qavat, chap tomon' })
  @Transform(trim)
  @IsString()
  @MaxLength(400)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({ example: 1 })
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(10_000)
  @IsOptional()
  sortOrder?: number;

  /**
   * `false` — xona ko'rinadi, lekin o'rtachaga va ogohlantirishga
   * KIRMAYDI (qozonxona xonasi, ta'mirdagi xona).
   */
  @ApiPropertyOptional({ example: true })
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  isMonitored?: boolean;
}

export class RoomHistoryQueryDto {
  /**
   * ⚠️ Yuqori chegara 31 kun: tarix 10 daqiqada bitta, ya'ni 10 xona
   * × 31 kun ≈ 45 000 nuqta. Undan ko'pi brauzerda grafikni qotirib
   * qo'yardi va baribir ekranga sig'masdi.
   */
  @ApiPropertyOptional({ example: 24, description: 'Necha soatlik, 1…744' })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(744)
  @IsOptional()
  hours?: number;
}

export class RoomSummaryQueryDto {
  @ApiPropertyOptional({ description: 'Tuman bo‘yicha cheklash' })
  @IsUUID('4')
  @IsOptional()
  districtId?: string;
}

/** Kabinetga qaytadigan xona ko'rinishi. */
export interface RoomView {
  id: string;
  boilerId: string;
  sensorKey: string;
  name: string;
  note: string | null;
  sortOrder: number;
  isAutoCreated: boolean;
  isMonitored: boolean;
  temperature: number | null;
  lastReadingAt: string | null;
  /** O'lchov `offlineAfterMinutes` dan yangi. */
  isFresh: boolean;
  /** Faqat dolzarb o'lchovda; aks holda `null` (holat NOMA'LUM). */
  condition: RoomCondition | null;
}

export interface BoilerRoomsView {
  thresholds: { minC: number; normC: number };
  rooms: RoomView[];
}

export interface RoomHistorySeries {
  roomId: string;
  name: string;
  points: Array<{ t: number; at: string }>;
}

/** Dashboard kartasi — butun viloyat (yoki tuman) bo'yicha. */
export interface RoomsSummary {
  /** Nazoratdagi, dolzarb o'lchovi bor xonalar. */
  measured: number;
  /** Nazoratdagi, lekin o'lchovi ESKIRGAN xonalar. */
  stale: number;
  avg: number | null;
  min: number | null;
  cold: number;
  cool: number;
  normal: number;
  /** Kamida bitta sovuq xonasi bor binolar. */
  buildingsWithCold: number;
  minC: number;
  normC: number;
  coldest: Array<{
    roomId: string;
    roomName: string;
    temperature: number;
    boilerId: string;
    lotNumber: string;
    organizationName: string | null;
    districtName: string;
  }>;
}
