import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { District } from '../../database/entities/district.entity';
import {
  matchDistrict,
  type DistrictRecord,
} from '../../helpers/district-ref.helper';

/**
 * TUMANLAR MA'LUMOTNOMASI — plata yuborgan tuman kodini aniqlash uchun.
 *
 * ⚠️ XOTIRADA KESHLANADI (10 daqiqa): tuman har telemetriya signalida
 * aniqlanadi (sekundiga o'nlab marta), tumanlar esa amalda o'zgarmaydi
 * (16 ta, bootstrap yaratadi). Har signalda bazaga borish sof isrof.
 */
@Injectable()
export class DistrictDirectoryService {
  private cache: { at: number; items: DistrictRecord[] } | null = null;
  private static readonly TTL_MS = 10 * 60_000;

  constructor(
    @InjectRepository(District)
    private readonly districts: Repository<District>,
  ) {}

  /** Plata yuborgan qiymat bo'yicha tuman (aniq, yagona moslik) yoki `null`. */
  async resolve(raw: unknown): Promise<DistrictRecord | null> {
    if (raw === undefined || raw === null || raw === '') return null;
    return matchDistrict(raw, await this.all());
  }

  private async all(): Promise<DistrictRecord[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < DistrictDirectoryService.TTL_MS) {
      return this.cache.items;
    }
    const rows = await this.districts.find({
      select: { id: true, code: true, soato: true, name: true },
    });
    this.cache = {
      at: now,
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        soato: row.soato,
        name: row.name,
      })),
    };
    return this.cache.items;
  }
}
