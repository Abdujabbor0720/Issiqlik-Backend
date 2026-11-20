import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  IsNull,
  Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  ACTIVE_INCIDENT_STATUSES,
  AuditAction,
  IncidentEventType,
  IncidentStatus,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  Incident,
  IncidentEvent,
  IncidentNotification,
} from '../../database/entities/incident.entities';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import {
  allowedFrom,
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUS_LABELS,
  nextStatus,
  type IncidentAction,
} from '../../helpers/incident-rules.helper';
import {
  ObjectAccessService,
  type ObjectScope,
} from '../access/object-access.service';
import { AuditService } from '../audit/audit.service';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import { ResponsiblesService } from '../responsibles/responsibles.service';
import type {
  IncidentCommentDto,
  IncidentQueryDto,
  IncidentReportQueryDto,
  NotificationQueryDto,
  RecurringQueryDto,
} from './dto/incident.dto';
import { IncidentNotifierService } from './incident-notifier.service';

const ACTION_LABELS: Record<IncidentAction, string> = {
  acknowledge: 'qabul qilish',
  start: 'chora boshlash',
  resolve: 'bartaraf etildi deb belgilash',
  close: 'yopish',
  reopen: 'qayta ochish',
};

const SEVERITY_ORDER = `CASE i.severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END`;

/**
 * XAVF — mas'ullar paneli uchun.
 *
 * ⚠️⚠️ HAR SO'ROV VAKOLAT CHEGARASIDAN O'TADI (`applyScope`): tuman
 * mas'uli — `district_id`, tashkilot mas'uli — `agency_id`, obyekt
 * javobgari — o'z obyektlari. Chegara hodisaga MUHRLANGAN yo'naltirish
 * bo'yicha: muassasa keyin boshqa idoraga o'tsa, eski hodisa yangi
 * idoraga «sizib» o'tmaydi.
 *
 * ⚠️ Vakolatdan tashqaridagi hodisa — 404 (403 emas): uning borligi ham
 * oshkor qilinmaydi.
 *
 * ⚠️ O'CHIRISH YO'Q. Holat o'zgarishi — CAS (`WHERE status = :o'qilgan`):
 * ikki mas'ul bir vaqtda bossa, ikkinchisi «holat o'zgardi» xatosini
 * oladi, tarixda esa ikkita bir-biriga zid yozuv paydo bo'lmaydi.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    @InjectRepository(IncidentEvent)
    private readonly events: Repository<IncidentEvent>,
    @InjectRepository(IncidentNotification)
    private readonly notifications: Repository<IncidentNotification>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly dataSource: DataSource,
    private readonly access: ObjectAccessService,
    private readonly responsibles: ResponsiblesService,
    private readonly notifier: IncidentNotifierService,
    private readonly districts: DistrictDirectoryService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════ Ro'yxat va karta ════════════════════════

  async list(query: IncidentQueryDto, user: AuthUser) {
    const scope = await this.access.resolve(user);
    const qb = this.incidents
      .createQueryBuilder('i')
      /*
       * ⚠️ Tartib: avval OG'IRLIK, keyin eng ESKI faol (uzoq kutayotgan
       * muammo yuqorida). `offset/limit` — `skip/take` emas: JOIN yo'q va
       * TypeORM xom ifodali tartibni (`CASE`) to'g'ri qo'yadi
       * (`alerts.service.ts` dagi izohga qarang).
       */
      .orderBy(SEVERITY_ORDER, 'DESC')
      .addOrderBy('i.detected_at', 'DESC')
      .offset(query.skip)
      .limit(query.limit);
    this.applyScope(qb, scope);

    qb.andWhere('i.status IN (:...statuses)', {
      statuses: query.statuses?.length
        ? query.statuses
        : [...ACTIVE_INCIDENT_STATUSES],
    });
    if (query.kinds?.length) {
      qb.andWhere('i.kind IN (:...kinds)', { kinds: query.kinds });
    }
    if (query.severity) {
      qb.andWhere('i.severity = :severity', { severity: query.severity });
    }
    if (query.districtIds?.length) {
      qb.andWhere('i.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }
    if (query.agencyIds?.length) {
      qb.andWhere('i.agency_id IN (:...agencyIds)', {
        agencyIds: query.agencyIds,
      });
    }
    if (query.organizationId) {
      qb.andWhere('i.organization_id = :organizationId', {
        organizationId: query.organizationId,
      });
    }
    if (query.boilerId) {
      qb.andWhere('i.boiler_id = :boilerId', { boilerId: query.boilerId });
    }
    if (query.escalated) qb.andWhere('i.escalation_level > 0');
    if (query.from) qb.andWhere('i.detected_at >= :from', { from: query.from });
    if (query.to) qb.andWhere('i.detected_at <= :to', { to: query.to });
    if (query.search) {
      qb.andWhere(
        `(i.title ILIKE :q OR i.organization_name ILIKE :q OR i.room_name ILIKE :q
          OR i.device_label ILIKE :q OR i.number::text = :exact)`,
        { q: `%${query.search}%`, exact: query.search.replace(/\D/g, '') },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    const views = await this.toViews(items, user);
    return new PaginatedResult(views, total, query.page, query.limit);
  }

  /** Ogohlantirish kartasi: obyekt, harorat, jadval, javobgarlar, tarix. */
  async detail(id: string, user: AuthUser) {
    const incident = await this.findVisible(id, user);
    const showRecipients = this.responsibles.canSeeContacts(user);
    const [[view], events, notifications, current] = await Promise.all([
      this.toViews([incident], user),
      this.events.find({
        where: { incidentId: id },
        order: { createdAt: 'ASC' },
      }),
      this.notifications.find({
        where: { incidentId: id },
        order: { level: 'ASC', createdAt: 'ASC' },
      }),
      this.responsibles.forBoilers([incident.boilerId]),
    ]);

    return {
      ...view,
      resolutionNote: incident.resolutionNote,
      closeNote: incident.closeNote,
      /** Hodisa paytidagi javobgarlar (muhrlangan). */
      responsibles: incident.responsibleSnapshot.map((snapshot) =>
        this.responsibles.presentSnapshot(snapshot, user),
      ),
      /** Hozirgi javobgarlar (keyin biriktirilgan bo'lishi mumkin). */
      currentResponsibles: (
        current.get(incident.boilerId)?.snapshots ?? []
      ).map((snapshot) => this.responsibles.presentSnapshot(snapshot, user)),
      timeline: events.map((event) => ({
        id: event.id,
        at: event.createdAt,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        actor: event.actorLabel,
        note: event.note,
        payload: showRecipients
          ? event.payload
          : this.withoutRecipients(event.payload),
      })),
      /*
       * ⚠️ Qabul qiluvchilarning ISM va LOGINI — faqat kontakt ruxsati
       * bilan (rahbarlar). Javobgar va kuzatuvchi «kimga, qaysi darajada,
       * o'qilganmi» ni ko'radi, lekin viloyat xodimlarining loginlarini emas.
       */
      notifications: notifications.map((row) => ({
        id: row.id,
        recipient: showRecipients ? row.recipientLabel : null,
        audience: row.audience,
        level: row.level,
        sentAt: row.createdAt,
        readAt: row.readAt,
      })),
      escalations: events
        .filter((event) => event.type === IncidentEventType.ESCALATED)
        .map((event) => ({
          at: event.createdAt,
          note: event.note,
          ...(event.payload ?? {}),
        })),
    };
  }

  // ════════════════════════ Jarayon ════════════════════════

  /**
   * HOLAT O'ZGARISHI (qabul, chora, bartaraf, yopish, qayta ochish).
   *
   * ⚠️ Oldinga sakrash mumkin (yangi → bartaraf), lekin «qabul qildi»
   * maydoni baribir to'ldiriladi: hisobotdagi «o'rtacha qabul qilish
   * vaqti» sakrab o'tilgan hodisalarda ham hisoblanishi kerak.
   */
  async transition(
    id: string,
    action: IncidentAction,
    note: string | null | undefined,
    actor: AuthUser,
  ) {
    const incident = await this.findVisible(id, actor);
    const to = nextStatus(action, incident.status);
    if (!to) {
      throw new ConflictException(
        `«${INCIDENT_STATUS_LABELS[incident.status]}» holatidagi hodisani ` +
          `${ACTION_LABELS[action]} mumkin emas (kerakli holat: ` +
          `${allowedFrom(action)
            .map((status) => INCIDENT_STATUS_LABELS[status])
            .join(', ')})`,
      );
    }

    const now = new Date();
    const patch: QueryDeepPartialEntity<Incident> = { status: to };
    const ackIfMissing = () => {
      if (!incident.acknowledgedAt) {
        patch.acknowledgedAt = now;
        patch.acknowledgedById = actor.id;
      }
    };
    switch (action) {
      case 'acknowledge':
        ackIfMissing();
        break;
      case 'start':
        ackIfMissing();
        patch.inProgressAt = now;
        break;
      case 'resolve':
        ackIfMissing();
        patch.resolvedAt = now;
        patch.resolvedById = actor.id;
        patch.resolution = 'manual';
        patch.resolutionNote = note ?? null;
        break;
      case 'close':
        patch.closedAt = now;
        patch.closedById = actor.id;
        patch.closeNote = note ?? null;
        break;
      case 'reopen':
        patch.resolvedAt = null;
        patch.resolvedById = null;
        patch.resolution = null;
        patch.resolutionNote = null;
        patch.inProgressAt = now;
        // ⚠️ Eskalatsiya muddati qayta ochilgan paytdan hisoblanadi.
        patch.openedAt = now;
        break;
    }

    /*
     * ⚠️ Holat va tarix yozuvi BITTA tranzaksiyada: oraliqda xato bo'lsa,
     * holat o'zgargan-u, «kim, qachon, nima uchun» yozilmay qolardi.
     */
    try {
      await this.dataSource.transaction(async (manager) => {
        const result = await manager
          .createQueryBuilder()
          .update(Incident)
          .set(patch)
          .where('id = :id AND status = :status', {
            id,
            status: incident.status,
          })
          .execute();
        if (!result.affected) {
          throw new ConflictException(
            'Hodisa holati hozirgina o‘zgardi — sahifani yangilab qayta urinib ko‘ring',
          );
        }
        await this.notifier.addEvent(
          id,
          IncidentEventType.STATUS_CHANGED,
          {
            actor,
            from: incident.status,
            to,
            note: note ?? null,
            payload: { action },
          },
          manager,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Bu muammo bo‘yicha yangi faol hodisa allaqachon ochilgan',
        );
      }
      throw error;
    }

    await this.audit.log({
      actor,
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Incident',
      entityId: id,
      summary:
        `XAVF №${incident.number}: ${INCIDENT_STATUS_LABELS[incident.status]} → ` +
        `${INCIDENT_STATUS_LABELS[to]}${note ? ` (${note.slice(0, 120)})` : ''}`,
      before: { status: incident.status },
      after: { status: to, note: note ?? null },
    });

    const updated = await this.incidents.findOneByOrFail({ id });
    this.notifier.broadcast(updated, action, await this.notifiedUsers(id));
    return this.detail(id, actor);
  }

  /** Izoh yoki bajarilgan ish — yopilgan hodisaga yozilmaydi. */
  async comment(id: string, dto: IncidentCommentDto, actor: AuthUser) {
    const incident = await this.findVisible(id, actor);
    if (incident.status === IncidentStatus.CLOSED) {
      throw new ConflictException('Yopilgan hodisaga izoh qo‘shib bo‘lmaydi');
    }
    await this.notifier.addEvent(
      id,
      dto.kind === 'action'
        ? IncidentEventType.ACTION
        : IncidentEventType.COMMENT,
      { actor, note: dto.note },
    );
    this.notifier.broadcast(incident, 'updated', await this.notifiedUsers(id));
    return this.detail(id, actor);
  }

  // ════════════════════════ Dashboard ════════════════════════

  /**
   * PANEL KARTALARI — vakolat doirasida.
   *
   * ⚠️ Viloyat va tashkilot paneli uchun tumanlar kesimi (`byDistrict`),
   * viloyat uchun tashkilotlar kesimi (`byAgency`) ham qaytadi.
   */
  async summary(user: AuthUser) {
    const scope = await this.access.resolve(user);
    const base = () => {
      const qb = this.incidents.createQueryBuilder('i');
      this.applyScope(qb, scope);
      return qb;
    };
    const active = [...ACTIVE_INCIDENT_STATUSES];

    const [totals, byKind, byDistrict, byAgency, timing, day] =
      await Promise.all([
        base()
          .select(
            'COUNT(*) FILTER (WHERE i.status IN (:...active))::int',
            'active',
          )
          .addSelect(
            `COUNT(*) FILTER (WHERE i.status = 'new')::int`,
            'unacknowledged',
          )
          .addSelect(
            `COUNT(*) FILTER (WHERE i.status = 'in_progress')::int`,
            'inProgress',
          )
          .addSelect(
            `COUNT(*) FILTER (WHERE i.status IN (:...active) AND i.severity = 'critical')::int`,
            'critical',
          )
          .addSelect(
            'COUNT(*) FILTER (WHERE i.status IN (:...active) AND i.escalation_level > 0)::int',
            'escalated',
          )
          .addSelect(
            `COUNT(*) FILTER (WHERE i.status = 'resolved')::int`,
            'awaitingClose',
          )
          .addSelect(
            'MIN(i.detected_at) FILTER (WHERE i.status IN (:...active))',
            'oldestActiveAt',
          )
          .setParameter('active', active)
          .getRawOne<Record<string, unknown>>(),
        base()
          .select('i.kind', 'kind')
          .addSelect('COUNT(*)::int', 'count')
          // ⚠️ `andWhere` — `where` vakolat chegarasini BOSIB ketardi.
          .andWhere('i.status IN (:...active)', { active })
          .groupBy('i.kind')
          .getRawMany<{ kind: string; count: number }>(),
        scope.kind === 'all' || scope.kind === 'agency'
          ? base()
              .select('i.district_id', 'districtId')
              .addSelect('COUNT(*)::int', 'active')
              .addSelect(
                `COUNT(*) FILTER (WHERE i.severity = 'critical')::int`,
                'critical',
              )
              .addSelect(
                'COUNT(*) FILTER (WHERE i.escalation_level > 0)::int',
                'escalated',
              )
              .andWhere('i.status IN (:...active)', { active })
              .groupBy('i.district_id')
              .getRawMany<{
                districtId: string;
                active: number;
                critical: number;
                escalated: number;
              }>()
          : Promise.resolve(null),
        scope.kind === 'all'
          ? base()
              .select('i.agency_id', 'agencyId')
              .addSelect('MAX(i.agency_name)', 'agencyName')
              .addSelect('COUNT(*)::int', 'active')
              .addSelect(
                'COUNT(*) FILTER (WHERE i.escalation_level > 0)::int',
                'escalated',
              )
              .andWhere('i.status IN (:...active)', { active })
              .groupBy('i.agency_id')
              .getRawMany<{
                agencyId: string | null;
                agencyName: string | null;
                active: number;
                escalated: number;
              }>()
          : Promise.resolve(null),
        base()
          .select(
            'AVG(EXTRACT(EPOCH FROM (i.acknowledged_at - i.detected_at)) / 60)',
            'avgAckMinutes',
          )
          .addSelect(
            'AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.detected_at)) / 60)',
            'avgResolveMinutes',
          )
          .andWhere(`i.detected_at >= now() - interval '30 days'`)
          .getRawOne<{
            avgAckMinutes: string | null;
            avgResolveMinutes: string | null;
          }>(),
        base()
          .select(
            `COUNT(*) FILTER (WHERE i.detected_at >= now() - interval '24 hours')::int`,
            'created',
          )
          .addSelect(
            `COUNT(*) FILTER (WHERE i.resolved_at >= now() - interval '24 hours')::int`,
            'resolved',
          )
          .getRawOne<{ created: number; resolved: number }>(),
      ]);

    const districtNames = new Map(
      (await this.districts.all()).map((d) => [d.id, d.name]),
    );
    const round = (value: string | null | undefined) =>
      value === null || value === undefined ? null : Math.round(Number(value));

    return {
      scope: scope.kind,
      active: Number(totals?.active ?? 0),
      unacknowledged: Number(totals?.unacknowledged ?? 0),
      inProgress: Number(totals?.inProgress ?? 0),
      critical: Number(totals?.critical ?? 0),
      escalated: Number(totals?.escalated ?? 0),
      awaitingClose: Number(totals?.awaitingClose ?? 0),
      oldestActiveAt: totals?.oldestActiveAt ?? null,
      byKind: byKind.map((row) => ({
        kind: row.kind,
        label:
          INCIDENT_KIND_LABELS[row.kind as keyof typeof INCIDENT_KIND_LABELS] ??
          row.kind,
        count: row.count,
      })),
      byDistrict:
        byDistrict?.map((row) => ({
          ...row,
          name: districtNames.get(row.districtId) ?? '—',
        })) ?? null,
      byAgency:
        byAgency?.map((row) => ({
          ...row,
          agencyName: row.agencyName ?? 'Tashkilot biriktirilmagan',
        })) ?? null,
      last30Days: {
        avgAckMinutes: round(timing?.avgAckMinutes),
        avgResolveMinutes: round(timing?.avgResolveMinutes),
      },
      last24Hours: {
        created: day?.created ?? 0,
        resolved: day?.resolved ?? 0,
      },
    };
  }

  /**
   * TAKRORLANAYOTGAN MUAMMOLAR — bir joyda bir xil muammo necha marta.
   *
   * ⚠️ Qayta ochilishlar ham sanaladi (`reopen_count`): chegara atrofida
   * sakragan xona bitta hodisa bo'lib qoladi, lekin u «tez-tez qaytadi»
   * degan signal yo'qolmasligi kerak.
   */
  async recurring(query: RecurringQueryDto, user: AuthUser) {
    const scope = await this.access.resolve(user);
    const qb = this.incidents
      .createQueryBuilder('i')
      .select('i.boiler_id', 'boilerId')
      .addSelect('i.room_id', 'roomId')
      .addSelect('i.kind', 'kind')
      .addSelect('MAX(i.organization_name)', 'organizationName')
      .addSelect('MAX(i.room_name)', 'roomName')
      .addSelect('MAX(i.device_label)', 'deviceLabel')
      .addSelect('MAX(i.district_id::text)', 'districtId')
      .addSelect('MAX(i.agency_name)', 'agencyName')
      .addSelect('COUNT(*)::int', 'incidents')
      .addSelect('SUM(i.reopen_count)::int', 'reopens')
      .addSelect('MIN(i.extreme_temperature)', 'lowestTemperature')
      .addSelect('MAX(i.detected_at)', 'lastDetectedAt')
      .where(`i.detected_at >= now() - make_interval(days => :days)`, {
        days: query.days,
      })
      .groupBy('i.boiler_id')
      .addGroupBy('i.room_id')
      .addGroupBy('i.kind')
      .having('COUNT(*) + SUM(i.reopen_count) >= :minCount', {
        minCount: query.minCount,
      })
      .orderBy('COUNT(*) + SUM(i.reopen_count)', 'DESC')
      .limit(200);
    this.applyScope(qb, scope);

    const rows = await qb.getRawMany<Record<string, unknown>>();
    const districtNames = new Map(
      (await this.districts.all()).map((d) => [d.id, d.name]),
    );
    const lots = await this.lotNumbers(rows.map((row) => String(row.boilerId)));
    return rows.map((row) => ({
      boilerId: row.boilerId,
      lotNumber: lots.get(String(row.boilerId)) ?? null,
      roomId: row.roomId,
      roomName: row.roomName,
      deviceLabel: row.deviceLabel,
      kind: row.kind,
      kindLabel:
        INCIDENT_KIND_LABELS[row.kind as keyof typeof INCIDENT_KIND_LABELS] ??
        row.kind,
      organizationName: row.organizationName,
      district: districtNames.get(String(row.districtId)) ?? '—',
      agencyName: row.agencyName,
      incidents: Number(row.incidents),
      reopens: Number(row.reopens),
      occurrences: Number(row.incidents) + Number(row.reopens),
      lowestTemperature:
        row.lowestTemperature === null ? null : Number(row.lowestTemperature),
      lastDetectedAt: row.lastDetectedAt,
    }));
  }

  /** DAVR HISOBOTI — tuman / tashkilot / muassasa / tur kesimida. */
  async report(query: IncidentReportQueryDto, user: AuthUser) {
    const scope = await this.access.resolve(user);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60_000);

    const column = {
      district: 'i.district_id',
      agency: 'i.agency_id',
      organization: 'i.organization_id',
      kind: 'i.kind',
    }[query.groupBy];
    const labelColumn = {
      district: 'NULL',
      agency: 'MAX(i.agency_name)',
      organization: 'MAX(i.organization_name)',
      kind: 'NULL',
    }[query.groupBy];

    const qb = this.incidents
      .createQueryBuilder('i')
      .select(`${column}::text`, 'key')
      .addSelect(labelColumn, 'label')
      .addSelect('COUNT(*)::int', 'total')
      .addSelect(
        'COUNT(*) FILTER (WHERE i.status IN (:...active))::int',
        'active',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE i.resolution = 'auto')::int`,
        'autoResolved',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE i.resolution = 'manual')::int`,
        'manuallyResolved',
      )
      .addSelect(`COUNT(*) FILTER (WHERE i.status = 'closed')::int`, 'closed')
      .addSelect(
        'COUNT(*) FILTER (WHERE i.escalation_level > 0)::int',
        'escalated',
      )
      .addSelect('SUM(i.reopen_count)::int', 'reopens')
      .addSelect(
        'AVG(EXTRACT(EPOCH FROM (i.acknowledged_at - i.detected_at)) / 60)',
        'avgAckMinutes',
      )
      .addSelect(
        'AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.detected_at)) / 60)',
        'avgResolveMinutes',
      )
      .where('i.detected_at BETWEEN :from AND :to', { from, to })
      .setParameter('active', [...ACTIVE_INCIDENT_STATUSES])
      .groupBy(column)
      .orderBy('COUNT(*)', 'DESC');
    this.applyScope(qb, scope);

    const rows = await qb.getRawMany<Record<string, unknown>>();
    const districtNames = new Map(
      (await this.districts.all()).map((d) => [d.id, d.name]),
    );
    const round = (value: unknown) =>
      value === null || value === undefined ? null : Math.round(Number(value));

    return {
      from,
      to,
      groupBy: query.groupBy,
      rows: rows.map((row) => ({
        key: row.key,
        label:
          query.groupBy === 'district'
            ? (districtNames.get(String(row.key)) ?? '—')
            : query.groupBy === 'kind'
              ? (INCIDENT_KIND_LABELS[
                  row.key as keyof typeof INCIDENT_KIND_LABELS
                ] ?? row.key)
              : (row.label ?? 'Biriktirilmagan'),
        total: Number(row.total),
        active: Number(row.active),
        autoResolved: Number(row.autoResolved),
        manuallyResolved: Number(row.manuallyResolved),
        closed: Number(row.closed),
        escalated: Number(row.escalated),
        reopens: Number(row.reopens ?? 0),
        avgAckMinutes: round(row.avgAckMinutes),
        avgResolveMinutes: round(row.avgResolveMinutes),
      })),
    };
  }

  // ════════════════════════ Shaxsiy ogohlantirishlar ════════════════════════

  async myNotifications(query: NotificationQueryDto, user: AuthUser) {
    const qb = this.notifications
      .createQueryBuilder('n')
      .innerJoin(Incident, 'i', 'i.id = n.incident_id')
      .select([
        'n.id AS id',
        'n.created_at AS "createdAt"',
        'n.read_at AS "readAt"',
        'n.level AS level',
        'n.audience AS audience',
        'i.id AS "incidentId"',
        'i.number AS number',
        'i.title AS title',
        'i.kind AS kind',
        'i.severity AS severity',
        'i.status AS status',
      ])
      .where('n.user_id = :userId', { userId: user.id })
      .orderBy('n.created_at', 'DESC')
      .offset(query.skip)
      .limit(query.limit);
    if (query.unreadOnly) qb.andWhere('n.read_at IS NULL');

    const [items, total, unread] = await Promise.all([
      qb.getRawMany<Record<string, unknown>>(),
      qb.clone().offset(undefined).limit(undefined).getCount(),
      this.notifications.count({
        where: { userId: user.id, readAt: IsNull() },
      }),
    ]);
    const page = new PaginatedResult(
      items.map((row) => ({ ...row, number: Number(row.number) })),
      total,
      query.page,
      query.limit,
    );
    /*
     * ⚠️ `unread` — `meta` ICHIDA: javob konverti (`TransformInterceptor`)
     * faqat `items` va `meta` ni oladi, yonidagi maydon jimgina yo'qolardi.
     */
    return { items: page.items, meta: { ...page.meta, unread } };
  }

  async markRead(id: string, user: AuthUser): Promise<{ updated: number }> {
    const result = await this.notifications.update(
      { id, userId: user.id, readAt: IsNull() },
      { readAt: new Date() },
    );
    return { updated: result.affected ?? 0 };
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.notifications.update(
      { userId: user.id, readAt: IsNull() },
      { readAt: new Date() },
    );
    return { updated: result.affected ?? 0 };
  }

  // ════════════════════════ ichki ════════════════════════

  private applyScope(
    qb: SelectQueryBuilder<Incident>,
    scope: ObjectScope,
  ): void {
    switch (scope.kind) {
      case 'all':
        return;
      case 'district':
        qb.andWhere('i.district_id = :scopeDistrict', {
          scopeDistrict: scope.districtId,
        });
        return;
      case 'agency':
        qb.andWhere('i.agency_id = :scopeAgency', {
          scopeAgency: scope.agencyId,
        });
        return;
      case 'responsible':
        qb.andWhere(
          '(i.boiler_id = ANY(:scopeBoilers) OR i.organization_id = ANY(:scopeOrgs))',
          {
            scopeBoilers: scope.boilerIds,
            scopeOrgs: scope.organizationIds,
          },
        );
        return;
    }
  }

  private async findVisible(id: string, user: AuthUser): Promise<Incident> {
    const qb = this.incidents
      .createQueryBuilder('i')
      .where('i.id = :id', { id });
    this.applyScope(qb, await this.access.resolve(user));
    const incident = await qb.getOne();
    if (!incident) throw new NotFoundException('Hodisa topilmadi');
    return incident;
  }

  private async toViews(items: Incident[], user: AuthUser) {
    if (items.length === 0) return [];
    const [districts, boilers] = await Promise.all([
      this.districts.all(),
      this.boilers.find({
        where: [...new Set(items.map((item) => item.boilerId))].map((id) => ({
          id,
        })),
        select: { id: true, lotNumber: true, address: true },
      }),
    ]);
    const districtNames = new Map(districts.map((d) => [d.id, d.name]));
    const boilerMap = new Map(boilers.map((b) => [b.id, b]));
    const now = Date.now();

    return items.map((incident) => {
      const end = (incident.closedAt ?? incident.resolvedAt)?.getTime() ?? now;
      const primary =
        incident.responsibleSnapshot.find((item) => item.isPrimary) ??
        incident.responsibleSnapshot[0] ??
        null;
      const boiler = boilerMap.get(incident.boilerId);
      return {
        id: incident.id,
        number: Number(incident.number),
        kind: incident.kind,
        kindLabel: INCIDENT_KIND_LABELS[incident.kind],
        severity: incident.severity,
        status: incident.status,
        statusLabel: INCIDENT_STATUS_LABELS[incident.status],
        title: incident.title,
        district: {
          id: incident.districtId,
          name: districtNames.get(incident.districtId) ?? '—',
        },
        organization: incident.organizationId
          ? { id: incident.organizationId, name: incident.organizationName }
          : null,
        agency: incident.agencyId
          ? { id: incident.agencyId, name: incident.agencyName }
          : null,
        boiler: {
          id: incident.boilerId,
          lotNumber: boiler?.lotNumber ?? null,
          address: boiler?.address ?? null,
        },
        room: incident.roomName
          ? { id: incident.roomId, name: incident.roomName }
          : null,
        device: incident.deviceLabel
          ? { id: incident.deviceId, label: incident.deviceLabel }
          : null,
        temperature: incident.temperature,
        currentTemperature: incident.currentTemperature,
        extremeTemperature: incident.extremeTemperature,
        threshold: incident.threshold,
        schedule: incident.scheduleSnapshot,
        detectedAt: incident.detectedAt,
        lastSeenAt: incident.lastSeenAt,
        durationMinutes: Math.max(
          0,
          Math.round((end - incident.detectedAt.getTime()) / 60_000),
        ),
        acknowledgedAt: incident.acknowledgedAt,
        inProgressAt: incident.inProgressAt,
        resolvedAt: incident.resolvedAt,
        resolution: incident.resolution,
        closedAt: incident.closedAt,
        escalationLevel: incident.escalationLevel,
        lastEscalatedAt: incident.lastEscalatedAt,
        reopenCount: incident.reopenCount,
        primaryResponsible: primary
          ? this.responsibles.presentSnapshot(primary, user)
          : null,
        responsibleCount: incident.responsibleSnapshot.length,
      };
    });
  }

  /** Tarix yozuvidan qabul qiluvchilar ro'yxatini olib tashlash (sonlar qoladi). */
  private withoutRecipients(
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!payload || !('recipients' in payload)) return payload;
    const { recipients: _recipients, ...rest } = payload;
    void _recipients;
    return rest;
  }

  private async lotNumbers(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.boilers.find({
      where: [...new Set(ids)].map((id) => ({ id })),
      select: { id: true, lotNumber: true },
    });
    return new Map(rows.map((row) => [row.id, row.lotNumber]));
  }

  private async notifiedUsers(incidentId: string): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ user_id: string }>>(
      `SELECT DISTINCT user_id FROM incident_notifications
        WHERE incident_id = $1 AND user_id IS NOT NULL`,
      [incidentId],
    );
    return rows.map((row) => row.user_id);
  }
}
