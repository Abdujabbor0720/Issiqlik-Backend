import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction, NotifyAudience } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { EscalationRule } from '../../database/entities/incident.entities';
import { AuditService } from '../audit/audit.service';
import type { ReplaceEscalationRulesDto } from './dto/incident.dto';

/**
 * ESKALATSIYA QOIDALARI — administrator sozlaydi (texnik topshiriq §7).
 *
 * ⚠️ Qoidalar BUTUNLAY almashtiriladi (PUT): ro'yxat kichik (≤ 30) va uni
 * yaxlit ko'rib tahrirlash tabiiy. Qatorma-qator tahrirda «2-daraja bor,
 * 1-daraja yo'q» kabi oraliq holatlar paydo bo'lardi.
 *
 * ⚠️ Kesh 60 s — dvigatel har daqiqada o'qiydi; yozishda darhol tozalanadi.
 */
@Injectable()
export class EscalationRulesService {
  private cache: { at: number; rules: EscalationRule[] } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(
    @InjectRepository(EscalationRule)
    private readonly repo: Repository<EscalationRule>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Dvigatel uchun (faolsizlari ham: aniq og'irlikdagi faolsiz qoida umumiyni o'chiradi). */
  async rules(): Promise<EscalationRule[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < EscalationRulesService.TTL_MS) {
      return this.cache.rules;
    }
    const rules = await this.repo.find({ order: { level: 'ASC' } });
    this.cache = { at: now, rules };
    return rules;
  }

  list(): Promise<EscalationRule[]> {
    return this.repo.find({ order: { level: 'ASC', severity: 'ASC' } });
  }

  async replace(
    dto: ReplaceEscalationRulesDto,
    actor: AuthUser,
  ): Promise<EscalationRule[]> {
    const seen = new Set<string>();
    for (const rule of dto.rules) {
      const key = `${rule.severity ?? '*'}:${rule.level}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `Takroriy qoida: og‘irlik «${rule.severity ?? 'hammasi'}», ${rule.level}-daraja`,
        );
      }
      seen.add(key);
      // ⚠️ Eskalatsiya YUQORIGA boradi — obyekt javobgariga «ko'tarish» ma'nosiz.
      if (rule.target === NotifyAudience.RESPONSIBLE) {
        throw new BadRequestException(
          'Eskalatsiya javobgarga emas, yuqori mas‘ulga yuboriladi',
        );
      }
    }

    const before = await this.list();
    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .delete()
        .from(EscalationRule)
        .execute();
      if (dto.rules.length > 0) {
        await manager.insert(
          EscalationRule,
          dto.rules.map((rule) => ({
            severity: rule.severity ?? null,
            level: rule.level,
            condition: rule.condition,
            afterMinutes: rule.afterMinutes,
            target: rule.target,
            isActive: rule.isActive ?? true,
          })),
        );
      }
    });
    this.cache = null;

    const after = await this.list();
    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'EscalationRule',
      summary: `Eskalatsiya qoidalari yangilandi (${after.length} ta)`,
      before: { rules: before.map((rule) => this.shape(rule)) },
      after: { rules: after.map((rule) => this.shape(rule)) },
    });
    return after;
  }

  private shape(rule: EscalationRule): Record<string, unknown> {
    return {
      severity: rule.severity,
      level: rule.level,
      condition: rule.condition,
      afterMinutes: rule.afterMinutes,
      target: rule.target,
      isActive: rule.isActive,
    };
  }
}
