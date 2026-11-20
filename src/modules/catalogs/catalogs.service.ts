import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, UserRole } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  Agency,
  BoilerBrand,
  Firm,
  Mahalla,
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { AuditService } from '../audit/audit.service';
import { DistrictDirectoryService } from '../geo/district-directory.service';
import { ObjectTypeDirectoryService } from '../geo/object-type-directory.service';
import type {
  CatalogQueryDto,
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
} from './dto/catalog.dto';

/** URL dagi katalog nomi → repozitoriy va kotyoldagi ustun. */
export type CatalogKind =
  | 'brands'
  | 'firms'
  | 'organizations'
  | 'object-types'
  | 'mahallas'
  | 'agencies';

type CatalogEntityUnion =
  BoilerBrand | Firm | Organization | ObjectType | Mahalla | Agency;

interface CatalogMeta {
  repo: Repository<CatalogEntityUnion>;
  /**
   * `boilers` jadvalidagi ishora ustuni — o'chirishdan oldin
   * tekshiriladi. `null` — kotyol bu katalogga TO'G'RIDAN-TO'G'RI
   * ishora qilmaydi (obyekt turiga tashkilot orqali bog'lanadi).
   */
  boilerColumn: 'brand_id' | 'firm_id' | 'organization_id' | null;
  /** Boshqa jadvaldagi ishora — `{jadval, ustun}`. */
  usedBy?: { table: string; column: string };
  /**
   * Ro'yxatda birga yuklanadigan bog'liqlik.
   *
   * ⚠️ Busiz tashkilot ro'yxatida obyekt turi `null` bo'lib kelardi:
   * ustun jadvalda bor, qiymat esa doim «—». Xato ko'rinmas edi —
   * so'rov muvaffaqiyatli, maydon shunchaki bo'sh.
   */
  relations?: Array<{ property: string; alias: string; columns: string[] }>;
  /** Tumanga tegishli katalog (`district_key` ustuni bor). */
  districtScoped?: boolean;
  label: string;
  entityName: string;
}

@Injectable()
export class CatalogsService {
  private readonly meta: Record<CatalogKind, CatalogMeta>;

  constructor(
    @InjectRepository(BoilerBrand) brands: Repository<BoilerBrand>,
    @InjectRepository(Firm) firms: Repository<Firm>,
    @InjectRepository(Organization) organizations: Repository<Organization>,
    @InjectRepository(ObjectType) objectTypes: Repository<ObjectType>,
    @InjectRepository(Mahalla) mahallas: Repository<Mahalla>,
    @InjectRepository(Agency) agencies: Repository<Agency>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly audit: AuditService,
    private readonly districts: DistrictDirectoryService,
    private readonly objectTypeDirectory: ObjectTypeDirectoryService,
  ) {
    /*
     * ⚠️ TO'RTTA katalog BITTA servis bilan boshqariladi. Ularning qoidasi
     * aynan bir xil: nom yagona, o'chirish o'rniga arxivlash, ishora
     * qilinayotgan yozuv arxivga tushadi. Uchta alohida servis bo'lsa,
     * birinchi tuzatish faqat bittasiga tushib, qolganlari boshqacha
     * ishlay boshlardi.
     */
    this.meta = {
      brands: {
        repo: brands,
        boilerColumn: 'brand_id',
        label: 'Kotyol markasi',
        entityName: 'BoilerBrand',
      },
      firms: {
        repo: firms,
        boilerColumn: 'firm_id',
        label: 'DXSH firma',
        entityName: 'Firm',
      },
      organizations: {
        repo: organizations,
        boilerColumn: 'organization_id',
        relations: [
          {
            property: 'item.objectType',
            alias: 'objectType',
            columns: ['objectType.id', 'objectType.name', 'objectType.code'],
          },
          {
            property: 'item.mahalla',
            alias: 'mahalla',
            columns: ['mahalla.id', 'mahalla.name'],
          },
          {
            property: 'item.agency',
            alias: 'agency',
            columns: ['agency.id', 'agency.name'],
          },
        ],
        districtScoped: true,
        label: 'Muassasa',
        entityName: 'Organization',
      },
      /*
       * ⚠️ Obyekt turiga KOTYOL emas, TASHKILOT ishora qiladi.
       * Shuning uchun o'chirishdan oldin `boilers` emas,
       * `organizations` tekshiriladi — aks holda ishlatilayotgan tur
       * jimgina o'chib, tashkilotlar turkumsiz qolardi.
       */
      'object-types': {
        repo: objectTypes,
        boilerColumn: null,
        usedBy: { table: 'organizations', column: 'object_type_id' },
        label: 'Obyekt turi',
        entityName: 'ObjectType',
      },
      mahallas: {
        repo: mahallas,
        boilerColumn: null,
        usedBy: { table: 'organizations', column: 'mahalla_id' },
        districtScoped: true,
        label: 'MFY',
        entityName: 'Mahalla',
      },
      /*
       * ⚠️ TASHKILOT / BOSHQARMA — XAVF shu idora mas'ullariga ham boradi.
       * Tuman bo'yicha CHEKLANMAYDI (`districtScoped` yo'q): viloyat
       * boshqarmasi bir nechta tumanni qamraydi va tuman mas'uli ham uni
       * ro'yxatda ko'rishi kerak.
       */
      agencies: {
        repo: agencies,
        boilerColumn: null,
        usedBy: { table: 'organizations', column: 'agency_id' },
        label: 'Tashkilot',
        entityName: 'Agency',
      },
    };
  }

  /**
   * ⚠️ Tumanga tegishli kataloglarda (muassasa, MFY) TUMAN MAS'ULI faqat o'z
   * tumanini ko'radi — API darajasida (`districtKey` filtri majburlanadi).
   */
  async list(
    kind: CatalogKind,
    query: CatalogQueryDto,
    user?: AuthUser,
  ): Promise<PaginatedResult<CatalogEntityUnion>> {
    const meta = this.resolve(kind);
    const qb = meta.repo
      .createQueryBuilder('item')
      .orderBy('item.name', 'ASC')
      .skip(query.skip)
      .take(query.limit);

    for (const relation of meta.relations ?? []) {
      qb.leftJoin(relation.property, relation.alias).addSelect(
        relation.columns,
      );
    }

    if (meta.districtScoped) {
      let districtKey = query.districtKey;
      if (user?.role === UserRole.OPERATOR) {
        const own = await this.districts.byId(user.districtId);
        districtKey = own?.key ?? '__none__';
      }
      if (districtKey) {
        qb.andWhere('item.district_key = :districtKey', { districtKey });
      }
    }
    if (kind === 'organizations' && query.agencyId) {
      qb.andWhere('item.agency_id = :agencyId', { agencyId: query.agencyId });
    }
    if (kind === 'organizations' && query.objectTypeId) {
      qb.andWhere('item.object_type_id = :objectTypeId', {
        objectTypeId: query.objectTypeId,
      });
    }

    if (!query.includeArchived) {
      qb.andWhere('item.is_archived = false');
    }
    if (query.search) {
      qb.andWhere('item.name ILIKE :q', { q: `%${query.search}%` });
    }

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }

  async create(
    kind: CatalogKind,
    dto: CreateCatalogItemDto,
    actor: AuthUser,
  ): Promise<CatalogEntityUnion> {
    const { repo, label, entityName } = this.resolve(kind);
    const fields = this.pickFields(kind, dto);
    await this.validateLocationFields(kind, fields, true);
    const saved = await this.saveUnique(repo, repo.create(fields), label);
    if (kind === 'object-types') this.objectTypeDirectory.invalidate();

    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName,
      entityId: saved.id,
      summary: `${label} qo‘shildi: ${saved.name}`,
    });
    return saved;
  }

  async update(
    kind: CatalogKind,
    id: string,
    dto: UpdateCatalogItemDto,
    actor: AuthUser,
  ): Promise<CatalogEntityUnion> {
    const { repo, label, entityName } = this.resolve(kind);
    const entity = await repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`${label} topilmadi`);

    const before = { name: entity.name, isArchived: entity.isArchived };
    const fields = this.pickFields(kind, dto);
    await this.validateLocationFields(kind, { ...entity, ...fields }, false);
    Object.assign(entity, fields);
    if (dto.isArchived !== undefined) entity.isArchived = dto.isArchived;

    const saved = await this.saveUnique(repo, entity, label);
    if (kind === 'object-types') this.objectTypeDirectory.invalidate();
    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName,
      entityId: saved.id,
      summary: `${label} tahrirlandi: ${saved.name}`,
      before,
      after: { name: saved.name, isArchived: saved.isArchived },
    });
    return saved;
  }

  /**
   * ⚠️ O'CHIRISH — faqat HECH KIM ISHORA QILMAGAN yozuv uchun.
   * Ishora qilingani arxivlanadi: o'chirilsa, o'tgan mavsum hisoboti
   * «noma'lum marka» bilan to'lib ketardi va uni tiklash imkonsiz edi.
   */
  async remove(kind: CatalogKind, id: string, actor: AuthUser): Promise<void> {
    const meta = this.resolve(kind);
    const { repo, boilerColumn, label, entityName } = meta;
    const entity = await repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`${label} topilmadi`);

    const used = boilerColumn
      ? await this.boilers
          .createQueryBuilder('boiler')
          .where(`boiler.${boilerColumn} = :id`, { id })
          .getCount()
      : await this.countReferences(meta, id);

    if (used > 0) {
      throw new BadRequestException(
        `Bu yozuv ${used} ta yozuvda ishlatilgan — o‘chirish o‘rniga arxivlang`,
      );
    }

    await repo.delete(id);
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName,
      entityId: id,
      summary: `${label} o‘chirildi: ${entity.name}`,
      before: { name: entity.name },
    });
  }

  // ───────────────── ichki ─────────────────

  /** Boshqa jadvaldagi ishoralarni sanaydi (`usedBy`). */
  private async countReferences(
    meta: CatalogMeta,
    id: string,
  ): Promise<number> {
    if (!meta.usedBy) return 0;
    const rows = await this.boilers.manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "${meta.usedBy.table}" WHERE "${meta.usedBy.column}" = $1`,
      [id],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Tuman ichida takror nom — 409 (500 emas). */
  private async saveUnique(
    repo: Repository<CatalogEntityUnion>,
    entity: CatalogEntityUnion,
    label: string,
  ): Promise<CatalogEntityUnion> {
    try {
      return await repo.save(entity);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Bunday nomli ${label.toLowerCase()} allaqachon bor`,
        );
      }
      throw error;
    }
  }

  /**
   * MUASSASA / MFY JOYLASHUVI.
   * ⚠️ MFY — tumanning birligi: muassasaning MFYsi uning o'z tumanidan
   * bo'lishi SHART (aks holda «Asaka tumanidagi maktab, Xonobod MFYsi»).
   */
  private async validateLocationFields(
    kind: CatalogKind,
    fields: Record<string, unknown>,
    creating: boolean,
  ): Promise<void> {
    if (
      kind !== 'organizations' &&
      kind !== 'mahallas' &&
      kind !== 'agencies'
    ) {
      return;
    }
    const districtKey = fields.districtKey as string | null | undefined;
    if (kind === 'mahallas' && creating && !districtKey) {
      throw new BadRequestException('MFY uchun tuman tanlanishi shart');
    }
    if (districtKey && !(await this.districts.byKey(districtKey))) {
      throw new BadRequestException(`Noma‘lum tuman kaliti: ${districtKey}`);
    }
    const mahallaId = fields.mahallaId as string | null | undefined;
    if (kind === 'organizations' && mahallaId) {
      const mahalla = await this.meta.mahallas.repo.findOne({
        where: { id: mahallaId },
      });
      if (!mahalla) throw new BadRequestException('MFY topilmadi');
      if ((mahalla as Mahalla).districtKey !== districtKey) {
        throw new BadRequestException('MFY muassasa tumaniga tegishli emas');
      }
    }
    const agencyId = fields.agencyId as string | null | undefined;
    if (kind === 'organizations' && agencyId) {
      const agency = await this.meta.agencies.repo.findOne({
        where: { id: agencyId },
      });
      if (!agency) throw new BadRequestException('Tashkilot topilmadi');
    }
  }

  private resolve(kind: CatalogKind): CatalogMeta {
    const meta = this.meta[kind];
    if (!meta) throw new NotFoundException('Bunday katalog mavjud emas');
    return meta;
  }

  /**
   * ⚠️ Maydonlar KATALOG TURIGA qarab tanlanadi: `country` faqat
   * markada, `tin` faqat firmada bor. Hammasini ko'chirib qo'yilsa,
   * TypeORM «bunday ustun yo'q» xatosini QO'LLASH paytida berardi —
   * ya'ni foydalanuvchi formani to'ldirib bo'lgandan keyin.
   */
  private pickFields(
    kind: CatalogKind,
    dto: CreateCatalogItemDto | UpdateCatalogItemDto,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    if (dto.name !== undefined) base.name = dto.name;
    // ⚠️ MFYda `note` ustuni yo'q.
    if (dto.note !== undefined && kind !== 'mahallas') base.note = dto.note;

    if (kind === 'brands') {
      if (dto.country !== undefined) base.country = dto.country;
    }
    if (kind === 'firms') {
      if (dto.tin !== undefined) base.tin = dto.tin;
      if (dto.phone !== undefined) base.phone = dto.phone;
      if (dto.directorName !== undefined) base.directorName = dto.directorName;
    }
    if (kind === 'organizations') {
      if (dto.objectTypeId !== undefined) base.objectTypeId = dto.objectTypeId;
      if (dto.phone !== undefined) base.phone = dto.phone;
      if (dto.districtKey !== undefined) base.districtKey = dto.districtKey;
      if (dto.mahallaId !== undefined) base.mahallaId = dto.mahallaId;
      if (dto.agencyId !== undefined) base.agencyId = dto.agencyId;
    }
    if (kind === 'agencies') {
      if (dto.phone !== undefined) base.phone = dto.phone;
      if (dto.districtKey !== undefined) base.districtKey = dto.districtKey;
    }
    if (kind === 'mahallas') {
      if (dto.districtKey !== undefined) base.districtKey = dto.districtKey;
    }
    if (kind === 'object-types') {
      /*
       * ⚠️ Kalit FAQAT yaratishda beriladi va keyin O'ZGARMAYDI:
       * eski ma'lumot (seed, import) aynan kalit bo'yicha moslanadi
       * va u o'zgarsa, bog'lanish jimgina uzilardi.
       */
      if (dto.code !== undefined) base.code = dto.code;
    }
    return base;
  }
}
