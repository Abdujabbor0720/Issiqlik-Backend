import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  AuditAction,
  IncidentEventType,
  IncidentStatus,
  NotifyAudience,
  ROLE_LEVEL,
  UserRole,
} from '../../common/constants/enums';
import { ROLE_LABELS } from '../../common/constants/permissions';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  Incident,
  IncidentEvent,
  IncidentNotification,
} from '../../database/entities/incident.entities';
import { User } from '../../database/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** Tizim nomidan yozilgan tarix va audit yorlig'i. */
export const SYSTEM_ACTOR_LABEL = 'Tizim (avtomatik)';

export interface Recipient {
  userId: string;
  label: string;
}

export interface NotifyResult {
  /** Yangi yaratilgan ogohlantirishlar soni (takrorlari hisobga olinmaydi). */
  sent: number;
  byAudience: Partial<Record<NotifyAudience, number>>;
  /** «Kimga yuborilmadi» — jim bo'shliqlar. */
  gaps: string[];
}

/**
 * KIMGA, QANDAY YUBORILADI.
 *
 * ⚠️⚠️ PANEL OGOHLANTIRISHI = BAZADAGI QATOR + JONLI XABAR. Faqat soket
 * xabari bo'lsa, o'sha paytda brauzeri yopiq mas'ul hech narsa bilmasdi;
 * qator esa u kirganda «o'qilmagan» bo'lib kutadi va «kimga yuborilgan»
 * degan savolga hisobotda javob beradi.
 *
 * ⚠️⚠️ TAKROR YO'Q: `(hodisa, foydalanuvchi, daraja)` yagona — qayta
 * baholash, ikki server nusxasi yoki qayta ochilish bitta odamga bitta
 * darajada ikkinchi xabar yarata olmaydi (`ON CONFLICT DO NOTHING`).
 *
 * ⚠️ Bir odam bir nechta auditoriyaga tushsa (masalan, javobgar ham, tuman
 * mas'uli ham) — BITTA xabar, birinchi (eng yaqin) auditoriya bilan.
 */
@Injectable()
export class IncidentNotifierService {
  private readonly logger = new Logger(IncidentNotifierService.name);

  constructor(
    @InjectRepository(IncidentNotification)
    private readonly notifications: Repository<IncidentNotification>,
    @InjectRepository(IncidentEvent)
    private readonly events: Repository<IncidentEvent>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * OGOHLANTIRISH YUBORISH.
   *
   * @param responsibleUsers obyekt javobgarlarining panel hisoblari
   *   (`RESPONSIBLE` auditoriyasi uchun; hodisa yaratilganda muhrlanadi).
   */
  async notify(
    incident: Incident,
    input: {
      level: number;
      audiences: NotifyAudience[];
      responsibleUsers?: Recipient[];
      reason: string;
    },
  ): Promise<NotifyResult> {
    const result: NotifyResult = { sent: 0, byAudience: {}, gaps: [] };
    const seen = new Set<string>();
    const rows: Array<{
      incidentId: string;
      userId: string;
      recipientLabel: string;
      audience: NotifyAudience;
      level: number;
    }> = [];

    for (const audience of input.audiences) {
      const recipients = await this.recipients(
        audience,
        incident,
        input.responsibleUsers ?? [],
      );
      const gap = this.gapFor(audience, incident, recipients.length);
      if (gap) result.gaps.push(gap);

      for (const recipient of recipients) {
        if (seen.has(recipient.userId)) continue;
        seen.add(recipient.userId);
        rows.push({
          incidentId: incident.id,
          userId: recipient.userId,
          recipientLabel: recipient.label.slice(0, 200),
          audience,
          level: input.level,
        });
      }
    }

    let inserted: Array<{ id: string; user_id: string; audience: string }> = [];
    if (rows.length > 0) {
      const insert = await this.notifications
        .createQueryBuilder()
        .insert()
        .into(IncidentNotification)
        .values(rows)
        .orIgnore()
        .returning(['id', 'user_id', 'audience'])
        .execute();
      inserted = (insert.raw ?? []) as typeof inserted;
    }

    for (const row of inserted) {
      const audience = row.audience as NotifyAudience;
      result.byAudience[audience] = (result.byAudience[audience] ?? 0) + 1;
      result.sent += 1;
      this.realtime.emitNotification(row.user_id, {
        notificationId: row.id,
        incidentId: incident.id,
        number: Number(incident.number),
        title: incident.title,
        severity: incident.severity,
        level: input.level,
        audience,
        at: new Date().toISOString(),
      });
    }

    await this.addEvent(incident.id, IncidentEventType.NOTIFIED, {
      payload: {
        level: input.level,
        reason: input.reason,
        sent: result.sent,
        byAudience: result.byAudience,
        gaps: result.gaps,
        recipients: rows
          .filter((row) => inserted.some((item) => item.user_id === row.userId))
          .map((row) => ({
            label: row.recipientLabel,
            audience: row.audience,
          })),
      },
    });
    await this.audit.log({
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AuditAction.NOTIFY,
      entityName: 'Incident',
      entityId: incident.id,
      summary:
        `XAVF №${incident.number}: ogohlantirish yuborildi (${input.reason}) — ` +
        `${result.sent} ta qabul qiluvchi` +
        (result.gaps.length ? `; bo‘shliq: ${result.gaps.join('; ')}` : ''),
      after: { level: input.level, byAudience: result.byAudience },
    });

    if (result.gaps.length > 0) {
      this.logger.warn(`XAVF №${incident.number}: ${result.gaps.join('; ')}`);
    }
    return result;
  }

  /** Auditoriya bo'yicha FAOL qabul qiluvchilar. */
  async recipients(
    audience: NotifyAudience,
    incident: Pick<Incident, 'districtId' | 'agencyId'>,
    responsibleUsers: Recipient[],
  ): Promise<Recipient[]> {
    switch (audience) {
      case NotifyAudience.RESPONSIBLE:
        return responsibleUsers;
      case NotifyAudience.DISTRICT:
        return this.usersWhere({
          role: UserRole.OPERATOR,
          districtId: incident.districtId,
        });
      case NotifyAudience.AGENCY:
        if (!incident.agencyId) return [];
        return this.usersWhere({
          role: UserRole.AGENCY_OFFICER,
          agencyId: incident.agencyId,
        });
      case NotifyAudience.REGION:
        return this.usersWhere({
          role: In([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
        });
    }
  }

  /** XAVF tarixiga yozuv (append-only). */
  async addEvent(
    incidentId: string,
    type: IncidentEventType,
    data: {
      actor?: AuthUser | null;
      from?: IncidentStatus | null;
      to?: IncidentStatus | null;
      note?: string | null;
      payload?: Record<string, unknown> | null;
    } = {},
    /** Tranzaksiya ichida yozish uchun (holat + tarix birga). */
    manager?: EntityManager,
  ): Promise<void> {
    /*
     * ⚠️ `as QueryDeepPartialEntity` — `jsonb` ustuni uchun (`audit.service.ts`
     * dagi izohga qarang): TypeORM ixtiyoriy `Record` ni bog'liq entity deb
     * o'qiydi. Shakl yuqoridagi imzoda allaqachon tekshirilgan.
     */
    await (manager ? manager.getRepository(IncidentEvent) : this.events).insert(
      {
        incidentId,
        type,
        fromStatus: data.from ?? null,
        toStatus: data.to ?? null,
        actorId: data.actor?.id ?? null,
        actorLabel: data.actor
          ? `${data.actor.fullName} (${ROLE_LABELS[data.actor.role] ?? data.actor.role})`
          : SYSTEM_ACTOR_LABEL,
        note: data.note ?? null,
        payload: data.payload ?? null,
      } as QueryDeepPartialEntity<IncidentEvent>,
    );
  }

  /** Jonli yangilanish — vakolatli xonalarga. */
  broadcast(incident: Incident, change: string, userIds: string[] = []): void {
    this.realtime.emitIncident(
      {
        incidentId: incident.id,
        number: Number(incident.number),
        change,
        kind: incident.kind,
        severity: incident.severity,
        status: incident.status,
        title: incident.title,
        boilerId: incident.boilerId,
        districtId: incident.districtId,
        agencyId: incident.agencyId,
        escalationLevel: incident.escalationLevel,
        at: new Date().toISOString(),
      },
      {
        districtId: incident.districtId,
        agencyId: incident.agencyId,
        userIds,
      },
    );
  }

  // ───────────────── ichki ─────────────────

  private async usersWhere(
    where: Record<string, unknown>,
  ): Promise<Recipient[]> {
    const users = await this.users.find({
      where: { ...where, isActive: true },
      select: { id: true, fullName: true, login: true, role: true },
      order: { fullName: 'ASC' },
    });
    // ⚠️ Barqaror tartib: yuqori darajadagi birinchi (xabar ro'yxatida o'qish oson).
    return users
      .sort((a, b) => (ROLE_LEVEL[b.role] ?? 0) - (ROLE_LEVEL[a.role] ?? 0))
      .map((user) => ({
        userId: user.id,
        label: `${user.fullName} (${user.login}) — ${ROLE_LABELS[user.role] ?? user.role}`,
      }));
  }

  /**
   * ⚠️⚠️ BO'SHLIQ JIM QOLMAYDI: tumanda mas'ul yo'q yoki muassasa hech
   * qaysi boshqarmaga biriktirilmagan bo'lsa, bu hodisa tarixida va
   * jurnalda yoziladi. Aks holda «ogohlantirish yuborildi» degan ishonch
   * bilan hech kim xabar olmagan bo'lardi.
   */
  private gapFor(
    audience: NotifyAudience,
    incident: Pick<Incident, 'agencyId' | 'responsibleSnapshot'>,
    count: number,
  ): string | null {
    if (count > 0) return null;
    switch (audience) {
      case NotifyAudience.DISTRICT:
        return 'tumanda faol mas‘ul (operator) yo‘q';
      case NotifyAudience.AGENCY:
        return incident.agencyId
          ? 'tashkilotda faol mas‘ul yo‘q'
          : 'muassasa hech qaysi tashkilot/boshqarmaga biriktirilmagan';
      case NotifyAudience.RESPONSIBLE:
        return incident.responsibleSnapshot.length === 0
          ? 'obyektga javobgar shaxs biriktirilmagan'
          : null; // ⚠️ Javobgar bor, lekin panel hisobi yo'q — odatiy hol (telefon orqali).
      case NotifyAudience.REGION:
        return 'viloyat darajasida faol administrator yo‘q';
    }
  }
}
