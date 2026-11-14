import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  BoilerBrand,
  Firm,
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import { AuditService } from '../audit/audit.service';
import type {
  CatalogQueryDto,
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
} from './dto/catalog.dto';

/** URL dagi katalog nomi → repozitoriy va kotyoldagi ustun. */
export type CatalogKind = 'brands' | 'firms' | 'organizations' | 'object-types';

type CatalogEntityUnion = BoilerBrand | Firm | Organization | ObjectType;

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
  relation?: { property: string; alias: string; columns: string[] };
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
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly audit: AuditService,
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
        relation: {
          property: 'item.objectType',
          alias: 'objectType',
          columns: ['objectType.id', 'objectType.name', 'objectType.code'],
        },
        label: 'Tashkilot',
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
    };
  }

  async list(
    kind: CatalogKind,
    query: CatalogQueryDto,
  ): Promise<PaginatedResult<CatalogEntityUnion>> {
    const meta = this.resolve(kind);
    const qb = meta.repo
      .createQueryBuilder('item')
      .orderBy('item.name', 'ASC')
      .skip(query.skip)
      .take(query.limit);

    if (meta.relation) {
      qb.leftJoin(meta.relation.property, meta.relation.alias).addSelect(
        meta.relation.columns,
      );
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
    const entity = repo.create(this.pickFields(kind, dto));
    const saved = await repo.save(entity);

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
    Object.assign(entity, this.pickFields(kind, dto));
    if (dto.isArchived !== undefined) entity.isArchived = dto.isArchived;

    const saved = await repo.save(entity);
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
    if (dto.note !== undefined) base.note = dto.note;

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
