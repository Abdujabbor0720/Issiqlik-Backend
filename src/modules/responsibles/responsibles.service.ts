import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import {
  AuditAction,
  ResponsibilityType,
  UserRole,
} from '../../common/constants/enums';
import { PERMISSIONS } from '../../common/constants/permissions';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { District } from '../../database/entities/district.entity';
import type { ResponsibleSnapshot } from '../../database/entities/incident.entities';
import {
  ResponsibleAssignment,
  ResponsiblePerson,
} from '../../database/entities/responsible.entities';
import { User } from '../../database/entities/user.entity';
import { lotRef } from '../../helpers/boiler-label.helper';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { maskEmail, maskPhone } from '../../helpers/incident-rules.helper';
import {
  ObjectAccessService,
  type ObjectScope,
} from '../access/object-access.service';
import { AuditService } from '../audit/audit.service';
import type {
  CreateAssignmentDto,
  CreateResponsibleDto,
  ResponsibleQueryDto,
  UpdateAssignmentDto,
  UpdateResponsibleDto,
} from './dto/responsible.dto';

export const RESPONSIBILITY_LABELS: Record<ResponsibilityType, string> = {
  [ResponsibilityType.DIRECTOR]: 'Muassasa rahbari',
  [ResponsibilityType.FACILITIES]: 'Xo‘jalik ishlari bo‘yicha mas‘ul',
  [ResponsibilityType.HEATING_TECHNICIAN]: 'Isitish tizimi texnik mas‘uli',
  [ResponsibilityType.OTHER]: 'Boshqa',
};

/** Kartada tartib: rahbar, xo'jalik, texnik, boshqa. */
const TYPE_ORDER: Record<string, number> = {
  [ResponsibilityType.DIRECTOR]: 0,
  [ResponsibilityType.FACILITIES]: 1,
  [ResponsibilityType.HEATING_TECHNICIAN]: 2,
  [ResponsibilityType.OTHER]: 3,
};

export interface AssignmentView {
  id: string;
  organization: { id: string; name: string; districtKey: string | null } | null;
  boiler: { id: string; label: string } | null;
  responsibilityType: ResponsibilityType;
  responsibilityLabel: string;
  isPrimary: boolean;
  note: string | null;
}

export interface ResponsibleView {
  id: string;
  fullName: string;
  position: string;
  employer: string | null;
  phone: string;
  email: string | null;
  /** Telefon va email niqoblanganmi (`responsibles.contacts` yo'q). */
  contactsMasked: boolean;
  district: { id: string; name: string } | null;
  user: { id: string; login: string } | null;
  isActive: boolean;
  note: string | null;
  assignments: AssignmentView[];
  updatedAt: Date;
}

/** Dvigatel uchun: obyektning javobgarlari + panelga ega hisoblari. */
export interface BoilerResponsibles {
  snapshots: ResponsibleSnapshot[];
  /** Panelga kiradigan FAOL hisoblar (`responsible` roli). */
  users: Array<{ userId: string; label: string }>;
}

/**
 * JAVOBGAR SHAXSLAR REYESTRI.
 *
 * ⚠️⚠️ CHEGARA (`ObjectAccessService`): tuman mas'uli o'z tumani
 * shaxslarini va o'z tumanidagi obyektlarga biriktirilganlarni ko'radi;
 * tashkilot mas'uli — o'z idorasi muassasalariga biriktirilganlarni;
 * obyekt javobgari — faqat o'zini.
 *
 * ⚠️⚠️ TELEFON VA EMAIL — `responsibles.contacts` ruxsati bilan.
 * Ruxsatsiz foydalanuvchi niqoblangan qiymat oladi (`maskPhone`):
 * «qaysi javobgar» ajraladi, raqam esa tarqalmaydi.
 */
@Injectable()
export class ResponsiblesService {
  constructor(
    @InjectRepository(ResponsiblePerson)
    private readonly persons: Repository<ResponsiblePerson>,
    @InjectRepository(ResponsibleAssignment)
    private readonly assignments: Repository<ResponsibleAssignment>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly access: ObjectAccessService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════ O'qish ════════════════════════

  async list(
    query: ResponsibleQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResult<ResponsibleView>> {
    const scope = await this.access.resolve(user);
    const qb = this.persons
      .createQueryBuilder('p')
      .orderBy('p.full_name', 'ASC')
      .offset(query.skip)
      .limit(query.limit);
    this.applyScope(qb, scope);

    if (query.search) {
      /*
       * ⚠️⚠️ Telefon bo'yicha qidiruv FAQAT kontakt ruxsati bilan: aks holda
       * niqoblangan raqamni raqamma-raqam qidirib («+99890…», «+998901…»)
       * to'liq tiklab olish mumkin bo'lardi.
       */
      const phone = this.canSeeContacts(user) ? ' OR p.phone ILIKE :q' : '';
      qb.andWhere(
        `(p.full_name ILIKE :q OR p.position ILIKE :q OR p.employer ILIKE :q${phone})`,
        { q: `%${query.search}%` },
      );
    }
    if (query.districtId) {
      qb.andWhere('p.district_id = :districtId', {
        districtId: query.districtId,
      });
    }
    if (query.organizationId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM responsible_assignments fa
                  WHERE fa.responsible_id = p.id AND fa.organization_id = :orgId)`,
        { orgId: query.organizationId },
      );
    }
    if (query.boilerId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM responsible_assignments fa
                   LEFT JOIN boilers fb ON fb.id = :boilerId
                  WHERE fa.responsible_id = p.id
                    AND (fa.boiler_id = :boilerId OR fa.organization_id = fb.organization_id))`,
        { boilerId: query.boilerId },
      );
    }
    if (query.isActive !== undefined) {
      qb.andWhere('p.is_active = :isActive', { isActive: query.isActive });
    }

    const [items, total] = await qb.getManyAndCount();
    const views = await this.toViews(items, user, scope);
    return new PaginatedResult(views, total, query.page, query.limit);
  }

  async findOne(id: string, user: AuthUser): Promise<ResponsibleView> {
    const person = await this.findVisible(id, user);
    const [view] = await this.toViews([person], user);
    return view;
  }

  /**
   * QAMROV — «qaysi muassasada asosiy javobgar YO'Q».
   *
   * ⚠️ Texnik topshiriq §3: «har bir muassasaga kamida bitta asosiy
   * javobgar». Buni bazada majburlab bo'lmaydi (muassasa javobgarsiz
   * yaratiladi), shuning uchun BO'SHLIQ shu hisobotda ko'rinadi: XAVF
   * ochilganda javobgari yo'q obyekt «hech kimga» qolmasligi kerak.
   * Faqat qozonxonasi bor (monitoringdagi) muassasalar sanaladi.
   */
  async coverage(user: AuthUser) {
    const scope = await this.access.resolve(user);
    const qb = this.organizations
      .createQueryBuilder('o')
      .innerJoin(
        Boiler,
        'b',
        'b.organization_id = o.id AND b.is_archived = false',
      )
      .select('o.id', 'id')
      .addSelect('o.name', 'name')
      .addSelect('o.district_key', 'districtKey')
      .addSelect('o.agency_id', 'agencyId')
      .addSelect('COUNT(DISTINCT b.id)::int', 'boilerCount')
      .addSelect(
        `(SELECT COUNT(*)::int FROM responsible_assignments a
            JOIN responsible_persons p ON p.id = a.responsible_id AND p.is_active
           WHERE a.organization_id = o.id)`,
        'responsibleCount',
      )
      .addSelect(
        `EXISTS (SELECT 1 FROM responsible_assignments a
                   JOIN responsible_persons p ON p.id = a.responsible_id AND p.is_active
                  WHERE a.organization_id = o.id AND a.is_primary)`,
        'hasPrimary',
      )
      .where('o.is_archived = false')
      .groupBy('o.id')
      .orderBy('o.district_key', 'ASC')
      .addOrderBy('o.name', 'ASC');

    if (scope.kind === 'district') {
      qb.andWhere('o.district_key = :key', { key: scope.districtKey });
    } else if (scope.kind === 'agency') {
      qb.andWhere('o.agency_id = :agencyId', { agencyId: scope.agencyId });
    } else if (scope.kind === 'responsible') {
      qb.andWhere('o.id = ANY(:orgIds)', { orgIds: scope.organizationIds });
    }

    const rows = await qb.getRawMany<{
      id: string;
      name: string;
      districtKey: string | null;
      agencyId: string | null;
      boilerCount: number;
      responsibleCount: number;
      hasPrimary: boolean;
    }>();

    const withoutPrimary = rows.filter((row) => !row.hasPrimary);
    return {
      total: rows.length,
      withPrimary: rows.length - withoutPrimary.length,
      withoutPrimary: withoutPrimary.length,
      /** Asosiy javobgari yo'q muassasalar — bo'shliq ro'yxati. */
      missing: withoutPrimary,
    };
  }

  // ════════════════════════ Yozish ════════════════════════

  async create(
    dto: CreateResponsibleDto,
    actor: AuthUser,
  ): Promise<ResponsibleView> {
    const districtId = await this.resolveDistrictForWrite(
      actor,
      dto.districtId ?? null,
    );
    if (dto.userId) await this.assertLinkableUser(dto.userId, null);

    let saved: ResponsiblePerson;
    try {
      saved = await this.persons.save(
        this.persons.create({
          fullName: dto.fullName,
          position: dto.position,
          employer: dto.employer ?? null,
          phone: dto.phone,
          email: dto.email ?? null,
          districtId,
          userId: dto.userId ?? null,
          note: dto.note ?? null,
          isActive: true,
        }),
      );
    } catch (error) {
      throw this.mapUnique(error);
    }

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'ResponsiblePerson',
      entityId: saved.id,
      summary: `Javobgar shaxs qo‘shildi: ${saved.fullName} (${saved.position})`,
    });
    return this.findOne(saved.id, actor);
  }

  async update(
    id: string,
    dto: UpdateResponsibleDto,
    actor: AuthUser,
  ): Promise<ResponsibleView> {
    const person = await this.persons.findOne({ where: { id } });
    if (!person) throw new NotFoundException('Javobgar shaxs topilmadi');
    await this.assertCanManagePerson(actor, person);

    const before = this.auditShape(person);
    if (dto.districtId !== undefined) {
      person.districtId = await this.resolveDistrictForWrite(
        actor,
        dto.districtId,
      );
    }
    if (dto.userId !== undefined && dto.userId !== person.userId) {
      if (dto.userId) await this.assertLinkableUser(dto.userId, person.id);
      person.userId = dto.userId;
    }
    if (dto.fullName !== undefined) person.fullName = dto.fullName;
    if (dto.position !== undefined) person.position = dto.position;
    if (dto.employer !== undefined) person.employer = dto.employer;
    if (dto.phone !== undefined) person.phone = dto.phone;
    if (dto.email !== undefined) person.email = dto.email;
    if (dto.note !== undefined) person.note = dto.note;
    if (dto.isActive !== undefined) person.isActive = dto.isActive;

    try {
      await this.persons.save(person);
    } catch (error) {
      throw this.mapUnique(error);
    }

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'ResponsiblePerson',
      entityId: id,
      summary: `Javobgar shaxs tahrirlandi: ${person.fullName}`,
      before,
      after: this.auditShape(person),
    });
    return this.findOne(id, actor);
  }

  /**
   * BIRIKTIRISH.
   *
   * ⚠️ `isPrimary: true` — nishondagi ESKI asosiy javobgar shu
   * tranzaksiyada qo'shimchaga o'tkaziladi. Aks holda asosiyni almashtirish
   * ikki qadam bo'lardi («avval eskisini olib tashla») va oraliqda obyekt
   * asosiy javobgarsiz qolardi.
   */
  async addAssignment(
    responsibleId: string,
    dto: CreateAssignmentDto,
    actor: AuthUser,
  ): Promise<ResponsibleView> {
    const person = await this.persons.findOne({ where: { id: responsibleId } });
    if (!person) throw new NotFoundException('Javobgar shaxs topilmadi');
    await this.assertCanManagePerson(actor, person);

    if (Boolean(dto.organizationId) === Boolean(dto.boilerId)) {
      throw new BadRequestException(
        'Muassasa YOKI aniq obyekt tanlanishi kerak (bittasi)',
      );
    }
    const label = await this.assertTargetWritable(actor, {
      organizationId: dto.organizationId ?? null,
      boilerId: dto.boilerId ?? null,
    });

    try {
      await this.dataSource.transaction(async (manager) => {
        if (dto.isPrimary) {
          await manager.update(
            ResponsibleAssignment,
            dto.organizationId
              ? { organizationId: dto.organizationId, isPrimary: true }
              : { boilerId: dto.boilerId, isPrimary: true },
            { isPrimary: false },
          );
        }
        await manager.insert(ResponsibleAssignment, {
          responsibleId,
          organizationId: dto.organizationId ?? null,
          boilerId: dto.boilerId ?? null,
          responsibilityType: dto.responsibilityType,
          isPrimary: dto.isPrimary ?? false,
          note: dto.note ?? null,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Bu shaxs shu muassasa/obyektga allaqachon biriktirilgan',
        );
      }
      throw error;
    }

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'ResponsibleAssignment',
      entityId: responsibleId,
      summary:
        `Javobgar biriktirildi: ${person.fullName} → ${label} ` +
        `(${RESPONSIBILITY_LABELS[dto.responsibilityType]}${dto.isPrimary ? ', asosiy' : ''})`,
    });
    return this.findOne(responsibleId, actor);
  }

  async updateAssignment(
    id: string,
    dto: UpdateAssignmentDto,
    actor: AuthUser,
  ): Promise<ResponsibleView> {
    const assignment = await this.assignments.findOne({ where: { id } });
    if (!assignment) throw new NotFoundException('Biriktirish topilmadi');
    const person = await this.persons.findOneOrFail({
      where: { id: assignment.responsibleId },
    });
    await this.assertCanManagePerson(actor, person);
    const label = await this.assertTargetWritable(actor, assignment);
    const before = {
      responsibilityType: assignment.responsibilityType,
      isPrimary: assignment.isPrimary,
    };

    await this.dataSource.transaction(async (manager) => {
      if (dto.isPrimary && !assignment.isPrimary) {
        await manager.update(
          ResponsibleAssignment,
          assignment.organizationId
            ? { organizationId: assignment.organizationId, isPrimary: true }
            : { boilerId: assignment.boilerId as string, isPrimary: true },
          { isPrimary: false },
        );
      }
      await manager.update(ResponsibleAssignment, id, {
        ...(dto.responsibilityType !== undefined
          ? { responsibilityType: dto.responsibilityType }
          : {}),
        ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      });
    });

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'ResponsibleAssignment',
      entityId: id,
      summary: `Biriktirish tahrirlandi: ${person.fullName} → ${label}`,
      before,
      after: {
        responsibilityType:
          dto.responsibilityType ?? assignment.responsibilityType,
        isPrimary: dto.isPrimary ?? assignment.isPrimary,
      },
    });
    return this.findOne(person.id, actor);
  }

  async removeAssignment(id: string, actor: AuthUser): Promise<void> {
    const assignment = await this.assignments.findOne({ where: { id } });
    if (!assignment) throw new NotFoundException('Biriktirish topilmadi');
    const person = await this.persons.findOneOrFail({
      where: { id: assignment.responsibleId },
    });
    await this.assertCanManagePerson(actor, person);
    const label = await this.assertTargetWritable(actor, assignment);

    await this.assignments.delete(id);
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'ResponsibleAssignment',
      entityId: id,
      summary: `Javobgar biriktirishdan olindi: ${person.fullName} ← ${label}`,
      before: {
        responsibilityType: assignment.responsibilityType,
        isPrimary: assignment.isPrimary,
      },
    });
  }

  // ════════════════════════ XAVF dvigateli uchun ════════════════════════

  /**
   * OBYEKTLARNING FAOL JAVOBGARLARI — BITTA so'rovda.
   *
   * ⚠️ Obyektga ham, uning muassasasiga ham biriktirilgan bitta shaxs bir
   * marta chiqadi (obyekt darajasidagisi ustun). Tartib: asosiy, keyin
   * rahbar → xo'jalik → texnik.
   */
  async forBoilers(
    boilerIds: string[],
  ): Promise<Map<string, BoilerResponsibles>> {
    const result = new Map<string, BoilerResponsibles>();
    if (boilerIds.length === 0) return result;

    const rows = await this.dataSource.query<
      Array<{
        boiler_id: string;
        responsible_id: string;
        full_name: string;
        position: string;
        employer: string | null;
        phone: string;
        email: string | null;
        responsibility_type: string;
        is_primary: boolean;
        via: 'organization' | 'boiler';
        user_id: string | null;
        user_login: string | null;
      }>
    >(
      `SELECT b.id AS boiler_id, p.id AS responsible_id, p.full_name, p.position,
              p.employer, p.phone, p.email, a.responsibility_type, a.is_primary,
              CASE WHEN a.boiler_id IS NOT NULL THEN 'boiler' ELSE 'organization' END AS via,
              u.id AS user_id, u.login AS user_login
         FROM boilers b
         JOIN responsible_assignments a
           ON a.boiler_id = b.id
           OR (a.organization_id IS NOT NULL AND a.organization_id = b.organization_id)
         JOIN responsible_persons p ON p.id = a.responsible_id AND p.is_active
         LEFT JOIN users u
           ON u.id = p.user_id AND u.is_active AND u.role = 'responsible'
        WHERE b.id = ANY($1::uuid[])`,
      [boilerIds],
    );

    for (const row of rows) {
      const entry = result.get(row.boiler_id) ?? { snapshots: [], users: [] };
      const existing = entry.snapshots.find(
        (item) => item.responsibleId === row.responsible_id,
      );
      const snapshot: ResponsibleSnapshot = {
        responsibleId: row.responsible_id,
        fullName: row.full_name,
        position: row.position,
        employer: row.employer,
        phone: row.phone,
        email: row.email,
        responsibilityType: row.responsibility_type,
        isPrimary: row.is_primary,
        via: row.via,
      };
      if (existing) {
        // ⚠️ Obyekt darajasidagi biriktirish ustun; «asosiy» belgisi yo'qolmasin.
        const wasPrimary = existing.isPrimary;
        if (row.via === 'boiler') Object.assign(existing, snapshot);
        existing.isPrimary = wasPrimary || row.is_primary;
      } else {
        entry.snapshots.push(snapshot);
      }
      if (
        row.user_id &&
        !entry.users.some((item) => item.userId === row.user_id)
      ) {
        entry.users.push({
          userId: row.user_id,
          label: `${row.full_name} (${row.user_login}) — javobgar`,
        });
      }
      result.set(row.boiler_id, entry);
    }

    for (const entry of result.values()) {
      entry.snapshots.sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          (TYPE_ORDER[a.responsibilityType] ?? 9) -
            (TYPE_ORDER[b.responsibilityType] ?? 9) ||
          a.fullName.localeCompare(b.fullName),
      );
    }
    return result;
  }

  /** Muhrlangan javobgarni foydalanuvchiga ko'rsatish (niqob bilan). */
  presentSnapshot(snapshot: ResponsibleSnapshot, user: AuthUser) {
    const canSee = this.canSeeContacts(user);
    return {
      ...snapshot,
      responsibilityLabel:
        RESPONSIBILITY_LABELS[
          snapshot.responsibilityType as ResponsibilityType
        ] ?? snapshot.responsibilityType,
      phone: canSee ? snapshot.phone : maskPhone(snapshot.phone),
      email: canSee ? snapshot.email : maskEmail(snapshot.email),
      contactsMasked: !canSee,
    };
  }

  canSeeContacts(user: AuthUser): boolean {
    return user.permissions.includes(PERMISSIONS.RESPONSIBLES_CONTACTS);
  }

  // ════════════════════════ ichki ════════════════════════

  private applyScope(
    qb: SelectQueryBuilder<ResponsiblePerson>,
    scope: ObjectScope,
  ): void {
    switch (scope.kind) {
      case 'all':
        return;
      case 'district':
        qb.andWhere(
          new Brackets((inner) =>
            inner
              .where('p.district_id = :scopeDistrict', {
                scopeDistrict: scope.districtId,
              })
              .orWhere(
                `EXISTS (SELECT 1 FROM responsible_assignments sa
                           LEFT JOIN organizations so ON so.id = sa.organization_id
                           LEFT JOIN boilers sb ON sb.id = sa.boiler_id
                          WHERE sa.responsible_id = p.id
                            AND (so.district_key = :scopeDistrictKey
                                 OR sb.district_id = :scopeDistrict))`,
                {
                  scopeDistrict: scope.districtId,
                  scopeDistrictKey: scope.districtKey,
                },
              ),
          ),
        );
        return;
      case 'agency':
        qb.andWhere(
          `EXISTS (SELECT 1 FROM responsible_assignments sa
                     LEFT JOIN boilers sb ON sb.id = sa.boiler_id
                     JOIN organizations so
                       ON so.id = COALESCE(sa.organization_id, sb.organization_id)
                    WHERE sa.responsible_id = p.id AND so.agency_id = :scopeAgency)`,
          { scopeAgency: scope.agencyId },
        );
        return;
      case 'responsible':
        // ⚠️ Obyekt javobgari reyestrda faqat O'ZINI ko'radi.
        qb.andWhere('p.id = :scopeSelf', {
          scopeSelf:
            scope.responsibleId ?? '00000000-0000-0000-0000-000000000000',
        });
        return;
    }
  }

  private async findVisible(
    id: string,
    user: AuthUser,
  ): Promise<ResponsiblePerson> {
    const qb = this.persons.createQueryBuilder('p').where('p.id = :id', { id });
    this.applyScope(qb, await this.access.resolve(user));
    const person = await qb.getOne();
    // ⚠️ Vakolatdan tashqaridagi yozuv — 404 (borligi ham oshkor qilinmaydi).
    if (!person) throw new NotFoundException('Javobgar shaxs topilmadi');
    return person;
  }

  private async toViews(
    persons: ResponsiblePerson[],
    user: AuthUser,
    knownScope?: ObjectScope,
  ): Promise<ResponsibleView[]> {
    if (persons.length === 0) return [];
    const ids = persons.map((person) => person.id);
    const scope = knownScope ?? (await this.access.resolve(user));

    const [assignmentRows, districts, users] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          responsible_id: string;
          organization_id: string | null;
          org_name: string | null;
          org_district_key: string | null;
          org_agency_id: string | null;
          boiler_id: string | null;
          boiler_district_id: string | null;
          boiler_org_agency_id: string | null;
          boiler_lot: string | null;
          boiler_org: string | null;
          responsibility_type: ResponsibilityType;
          is_primary: boolean;
          note: string | null;
        }>
      >(
        `SELECT a.id, a.responsible_id, a.organization_id, o.name AS org_name,
                o.district_key AS org_district_key, o.agency_id AS org_agency_id,
                a.boiler_id, b.district_id AS boiler_district_id,
                bo.agency_id AS boiler_org_agency_id,
                b.lot_number AS boiler_lot, bo.name AS boiler_org,
                a.responsibility_type, a.is_primary, a.note
           FROM responsible_assignments a
           LEFT JOIN organizations o ON o.id = a.organization_id
           LEFT JOIN boilers b ON b.id = a.boiler_id
           LEFT JOIN organizations bo ON bo.id = b.organization_id
          WHERE a.responsible_id = ANY($1::uuid[])
          ORDER BY a.is_primary DESC, a.created_at ASC`,
        [ids],
      ),
      this.districts.find({ select: { id: true, name: true } }),
      this.users.find({
        where: persons
          .filter((person) => person.userId)
          .map((person) => ({ id: person.userId as string })),
        select: { id: true, login: true },
      }),
    ]);

    const districtNames = new Map(districts.map((d) => [d.id, d.name]));
    const userLogins = new Map(users.map((u) => [u.id, u.login]));
    const canSee = this.canSeeContacts(user);

    /*
     * ⚠️⚠️ BIRIKTIRISHLAR HAM VAKOLAT BO'YICHA. Shaxs ko'rinishi (bitta
     * biriktirish o'z tumanida) uning BOSHQA tuman / idoradagi obyektlarini
     * ochib bermasligi kerak — tuman mas'uli faqat o'z hududidagini ko'radi.
     */
    const assignmentVisible = (row: (typeof assignmentRows)[number]) => {
      switch (scope.kind) {
        case 'all':
        case 'responsible': // ⚠️ javobgar faqat O'Z yozuvini ko'radi
          return true;
        case 'district':
          return (
            row.org_district_key === scope.districtKey ||
            row.boiler_district_id === scope.districtId
          );
        case 'agency':
          return (
            row.org_agency_id === scope.agencyId ||
            row.boiler_org_agency_id === scope.agencyId
          );
      }
    };

    return persons.map((person) => {
      // ⚠️ O'z yozuvini ko'rayotgan javobgar o'z raqamini niqobsiz ko'radi.
      const showContacts = canSee || person.userId === user.id;
      return {
        id: person.id,
        fullName: person.fullName,
        position: person.position,
        employer: person.employer,
        phone: showContacts ? person.phone : (maskPhone(person.phone) ?? ''),
        email: showContacts ? person.email : maskEmail(person.email),
        contactsMasked: !showContacts,
        district: person.districtId
          ? {
              id: person.districtId,
              name: districtNames.get(person.districtId) ?? '—',
            }
          : null,
        user: person.userId
          ? {
              id: person.userId,
              login: userLogins.get(person.userId) ?? '—',
            }
          : null,
        isActive: person.isActive,
        note: person.note,
        updatedAt: person.updatedAt,
        assignments: assignmentRows
          .filter(
            (row) => row.responsible_id === person.id && assignmentVisible(row),
          )
          .map((row) => ({
            id: row.id,
            organization: row.organization_id
              ? {
                  id: row.organization_id,
                  name: row.org_name ?? '—',
                  districtKey: row.org_district_key,
                }
              : null,
            boiler: row.boiler_id
              ? {
                  id: row.boiler_id,
                  label: `${row.boiler_org ? `${row.boiler_org}, ` : ''}${lotRef(row.boiler_lot)}`,
                }
              : null,
            responsibilityType: row.responsibility_type,
            responsibilityLabel:
              RESPONSIBILITY_LABELS[row.responsibility_type] ??
              row.responsibility_type,
            isPrimary: row.is_primary,
            note: row.note,
          })),
      };
    });
  }

  /**
   * ⚠️ Tuman mas'uli FAQAT o'z tumanidagi shaxslarni boshqaradi; viloyat
   * darajasidagi (`districtId = null`) yoki boshqa tuman shaxsiga tega
   * olmaydi — u boshqa tumanlarning ham javobgari bo'lishi mumkin.
   */
  private async assertCanManagePerson(
    actor: AuthUser,
    person: ResponsiblePerson,
  ): Promise<void> {
    const scope = await this.access.resolve(actor);
    if (scope.kind === 'all') return;
    if (scope.kind === 'district' && person.districtId === scope.districtId) {
      return;
    }
    throw new ForbiddenException(
      'Bu javobgar shaxs sizning tumaningizga tegishli emas',
    );
  }

  /** Yozishda uy tumani: tuman mas'uli uchun — majburan o'z tumani. */
  private async resolveDistrictForWrite(
    actor: AuthUser,
    requested: string | null,
  ): Promise<string | null> {
    const scope = await this.access.resolve(actor);
    if (scope.kind === 'district') {
      if (requested && requested !== scope.districtId) {
        throw new ForbiddenException(
          'Faqat o‘z tumaningiz uchun qo‘sha olasiz',
        );
      }
      return scope.districtId;
    }
    if (scope.kind !== 'all') {
      throw new ForbiddenException('Javobgarlar reyestrini boshqara olmaysiz');
    }
    if (
      requested &&
      !(await this.districts.exist({ where: { id: requested } }))
    ) {
      throw new BadRequestException('Tuman topilmadi');
    }
    return requested;
  }

  /** Nishon mavjud va yozuvchi vakolatida — yorlig'ini qaytaradi. */
  private async assertTargetWritable(
    actor: AuthUser,
    target: { organizationId: string | null; boilerId: string | null },
  ): Promise<string> {
    const scope = await this.access.resolve(actor);
    if (target.organizationId) {
      const org = await this.organizations.findOne({
        where: { id: target.organizationId },
        select: { id: true, name: true, districtKey: true, agencyId: true },
      });
      if (!org) throw new BadRequestException('Muassasa topilmadi');
      if (
        scope.kind !== 'all' &&
        !(scope.kind === 'district' && org.districtKey === scope.districtKey)
      ) {
        throw new ForbiddenException(
          'Bu muassasa sizning tumaningizga tegishli emas',
        );
      }
      return `muassasa «${org.name}»`;
    }

    const placement = await this.access
      .placement(target.boilerId as string)
      .catch(() => {
        throw new BadRequestException('Obyekt topilmadi');
      });
    if (
      scope.kind !== 'all' &&
      !(scope.kind === 'district' && placement.districtId === scope.districtId)
    ) {
      throw new ForbiddenException(
        'Bu obyekt sizning tumaningizga tegishli emas',
      );
    }
    const boiler = await this.boilers.findOne({
      where: { id: placement.id },
      select: { id: true, lotNumber: true },
    });
    return `obyekt ${lotRef(boiler?.lotNumber ?? null)}`;
  }

  /**
   * ⚠️ Panel hisobi FAQAT `responsible` rolida bo'lishi kerak: aks holda
   * tuman mas'uli o'z hisobini javobgarga bog'lab, ko'rish chegarasini
   * aralashtirib yuborardi (kimning paneli qaysi kesimda ishlashi
   * noaniq bo'lardi).
   */
  private async assertLinkableUser(
    userId: string,
    personId: string | null,
  ): Promise<void> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new BadRequestException('Foydalanuvchi topilmadi');
    if (user.role !== UserRole.RESPONSIBLE) {
      throw new BadRequestException(
        'Faqat «Obyekt javobgari» rolidagi hisob bog‘lanadi',
      );
    }
    const linked = await this.persons.findOne({
      where: { userId },
      select: { id: true, fullName: true },
    });
    if (linked && linked.id !== personId) {
      throw new ConflictException(
        `Bu hisob boshqa javobgarga bog‘langan: ${linked.fullName}`,
      );
    }
  }

  private mapUnique(error: unknown): unknown {
    if (isUniqueViolation(error)) {
      return new ConflictException('Bu hisob boshqa javobgarga bog‘langan');
    }
    return error;
  }

  private auditShape(person: ResponsiblePerson): Record<string, unknown> {
    return {
      fullName: person.fullName,
      position: person.position,
      employer: person.employer,
      districtId: person.districtId,
      userId: person.userId,
      isActive: person.isActive,
    };
  }
}
