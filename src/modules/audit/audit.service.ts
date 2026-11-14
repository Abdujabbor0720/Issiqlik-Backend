import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AuditAction } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  PaginatedResult,
  PaginationDto,
} from '../../common/dto/pagination.dto';
import { AuditLog } from '../../database/entities/audit-log.entity';

export interface AuditInput {
  actor?: AuthUser | null;
  action: AuditAction;
  entityName: string;
  entityId?: string | null;
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  /**
   * Audit yozuvi.
   *
   * ⚠️ XATO YUTILADI va bu ATAYLAB. Audit — yon ta'sir: jurnalga yozish
   * yiqilsa, kotyolni saqlash ham bekor bo'lib qolardi. Foydalanuvchi
   * uchun natija: «saqlanmadi» xatosi, sababi esa butunlay boshqa
   * joyda. Shuning uchun xato jurnalga chiqadi, lekin yuqoriga
   * ko'tarilmaydi.
   */
  async log(input: AuditInput): Promise<void> {
    try {
      /*
       * ⚠️ `as QueryDeepPartialEntity` — `jsonb` ustuni uchun. TypeORM
       * `QueryDeepPartialEntity` ni REKURSIV hisoblaydi va ixtiyoriy
       * shakldagi `Record<string, unknown>` ni «bog'liq entity» deb
       * o'qiydi. Tip xavfsizligi bu yerda yo'qolmaydi: obyekt
       * yuqorida `AuditInput` bilan allaqachon tekshirilgan.
       */
      await this.repo.insert({
        userId: input.actor?.id ?? null,
        actorLabel: input.actor
          ? `${input.actor.fullName} (${input.actor.login})`
          : null,
        action: input.action,
        entityName: input.entityName,
        entityId: input.entityId ?? null,
        summary: input.summary ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        ipAddress: input.ipAddress ?? null,
      } as QueryDeepPartialEntity<AuditLog>);
    } catch (error) {
      this.logger.error(
        `Audit yozilmadi: ${input.action} ${input.entityName}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(query: PaginationDto): Promise<PaginatedResult<AuditLog>> {
    const qb = this.repo
      .createQueryBuilder('log')
      .leftJoin('log.user', 'user')
      .addSelect(['user.id', 'user.login', 'user.fullName'])
      .orderBy('log.createdAt', 'DESC')
      .skip(query.skip)
      .take(query.limit);

    if (query.search) {
      qb.andWhere(
        '(log.summary ILIKE :q OR log.actor_label ILIKE :q OR log.entity_name ILIKE :q)',
        { q: `%${query.search}%` },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }
}
