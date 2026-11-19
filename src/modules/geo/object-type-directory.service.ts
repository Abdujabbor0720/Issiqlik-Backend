import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectType } from '../../database/entities/catalog.entities';
import { normalizeObjectTypeKey } from '../../helpers/device-profile.helper';

export interface ObjectTypeRecord {
  id: string;
  code: string;
  name: string;
}

/**
 * OBYEKT TURLARI MA'LUMOTNOMASI — qurilma yuborgan `object_type` kalitini
 * «Kataloglar → Obyekt turlari» bilan solishtirish.
 *
 * ⚠️ Noma'lum kalit so'rovni RAD ETMAYDI (§4): `resolve()` `null` qaytaradi
 * va maydon e'tiborsiz qoldiriladi. Kesh 10 daqiqa — telemetriya har
 * signalda bazaga bormasligi uchun; katalog o'zgarganda `invalidate()`.
 */
@Injectable()
export class ObjectTypeDirectoryService {
  private cache: { at: number; items: ObjectTypeRecord[] } | null = null;
  private static readonly TTL_MS = 10 * 60_000;

  constructor(
    @InjectRepository(ObjectType)
    private readonly types: Repository<ObjectType>,
  ) {}

  async resolve(raw: unknown): Promise<ObjectTypeRecord | null> {
    const key = normalizeObjectTypeKey(raw);
    if (!key) return null;
    return (await this.all()).find((item) => item.code === key) ?? null;
  }

  async byId(id: string | null | undefined): Promise<ObjectTypeRecord | null> {
    if (!id) return null;
    return (await this.all()).find((item) => item.id === id) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }

  async all(): Promise<ObjectTypeRecord[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < ObjectTypeDirectoryService.TTL_MS) {
      return this.cache.items;
    }
    const rows = await this.types.find({
      where: { isArchived: false },
      select: { id: true, code: true, name: true },
    });
    this.cache = {
      at: now,
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
      })),
    };
    return this.cache.items;
  }
}
