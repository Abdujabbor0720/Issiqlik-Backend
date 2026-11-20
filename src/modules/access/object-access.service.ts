import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { ResponsiblePerson } from '../../database/entities/responsible.entities';
import { DistrictDirectoryService } from '../geo/district-directory.service';

/**
 * FOYDALANUVCHI KO'RA OLADIGAN OBYEKTLAR CHEGARASI.
 *
 *   • `all`         — viloyat darajasi (super_admin, admin, viewer);
 *   • `district`    — tuman mas'uli: faqat o'z tumani;
 *   • `agency`      — tashkilot mas'uli: o'z idorasiga qarashli muassasalar;
 *   • `responsible` — obyekt javobgari: o'zi biriktirilgan obyektlar.
 */
export type ObjectScope =
  | { kind: 'all' }
  | { kind: 'district'; districtId: string; districtKey: string }
  | { kind: 'agency'; agencyId: string }
  | {
      kind: 'responsible';
      responsibleId: string | null;
      boilerIds: string[];
      organizationIds: string[];
    };

/** Kirish tekshiruvi uchun obyektning joylashuvi. */
export interface BoilerPlacement {
  id: string;
  districtId: string;
  organizationId: string | null;
  agencyId: string | null;
}

/**
 * VAKOLAT CHEGARASI — XAVF, javobgarlar reyestri va jadval uchun BITTA joy.
 *
 * ⚠️⚠️ Uchta modul (incidents, responsibles, monitoring) bir xil savolga
 * javob beradi: «bu odam shu obyektni ko'ra oladimi?». Har biri o'z
 * nusxasini yozsa, bittasida tashkilot mas'uli boshqa tumanni ko'rib
 * qolardi — shuning uchun qoida shu yerda va faqat shu yerda.
 *
 * ⚠️ Ma'lumot chegarasi TOKENDAN emas, BAZADAN: rol va `districtId` /
 * `agencyId` har so'rovda `jwt.strategy.ts` da yangidan o'qiladi;
 * javobgarning obyektlari esa bu yerda — biriktirish olib tashlansa,
 * keyingi so'rovdayoq ko'rinmaydi.
 */
@Injectable()
export class ObjectAccessService {
  constructor(
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    @InjectRepository(ResponsiblePerson)
    private readonly persons: Repository<ResponsiblePerson>,
    private readonly districts: DistrictDirectoryService,
  ) {}

  async resolve(user: AuthUser): Promise<ObjectScope> {
    switch (user.role) {
      case UserRole.SUPER_ADMIN:
      case UserRole.ADMIN:
      case UserRole.VIEWER:
        return { kind: 'all' };

      case UserRole.OPERATOR: {
        /*
         * ⚠️ Tumansiz operator — ma'lumot xatosi (`scope.helper.ts` bilan
         * AYNI qoida): bo'sh ro'yxat emas, aniq xato. Bo'sh ro'yxat
         * «XAVF yo'q» deb o'qilib, haqiqiy muammoni yashirardi.
         */
        const district = await this.districts.byId(user.districtId);
        if (!district) {
          throw new ForbiddenException(
            'Hisobingizga tuman biriktirilmagan — administratorga murojaat qiling',
          );
        }
        return {
          kind: 'district',
          districtId: district.id,
          districtKey: district.key,
        };
      }

      case UserRole.AGENCY_OFFICER:
        if (!user.agencyId) {
          throw new ForbiddenException(
            'Hisobingizga tashkilot biriktirilmagan — administratorga murojaat qiling',
          );
        }
        return { kind: 'agency', agencyId: user.agencyId };

      default:
        // ⚠️ Obyekt javobgari (va har qanday noma'lum rol) — faqat o'z obyektlari.
        return this.responsibleScope(user.id);
    }
  }

  /** Obyekt joylashuvi (muassasa idorasi bilan) — topilmasa 404. */
  async placement(boilerId: string): Promise<BoilerPlacement> {
    const row = await this.boilers
      .createQueryBuilder('boiler')
      .leftJoin(Organization, 'org', 'org.id = boiler.organization_id')
      .select('boiler.id', 'id')
      .addSelect('boiler.district_id', 'districtId')
      .addSelect('boiler.organization_id', 'organizationId')
      .addSelect('org.agency_id', 'agencyId')
      .where('boiler.id = :boilerId', { boilerId })
      .getRawOne<BoilerPlacement>();
    if (!row) throw new NotFoundException('Obyekt topilmadi');
    return row;
  }

  /** Obyekt shu chegaraga kiradimi. */
  covers(scope: ObjectScope, placement: BoilerPlacement): boolean {
    switch (scope.kind) {
      case 'all':
        return true;
      case 'district':
        return placement.districtId === scope.districtId;
      case 'agency':
        return placement.agencyId === scope.agencyId;
      case 'responsible':
        return (
          scope.boilerIds.includes(placement.id) ||
          (placement.organizationId !== null &&
            scope.organizationIds.includes(placement.organizationId))
        );
    }
  }

  /** Obyektga kirish — yo'q bo'lsa 403. */
  async assertBoiler(
    user: AuthUser,
    boilerId: string,
  ): Promise<BoilerPlacement> {
    const placement = await this.placement(boilerId);
    if (!this.covers(await this.resolve(user), placement)) {
      throw new ForbiddenException('Bu obyekt sizning vakolatingizga kirmaydi');
    }
    return placement;
  }

  /** Muassasa shu chegaraga kiradimi. */
  coversOrganization(
    scope: ObjectScope,
    organization: Pick<Organization, 'id' | 'districtKey' | 'agencyId'>,
  ): boolean {
    switch (scope.kind) {
      case 'all':
        return true;
      case 'district':
        return organization.districtKey === scope.districtKey;
      case 'agency':
        return organization.agencyId === scope.agencyId;
      case 'responsible':
        return scope.organizationIds.includes(organization.id);
    }
  }

  /**
   * JAVOBGARNING OBYEKTLARI: o'ziga biriktirilgan qozonxonalar + o'ziga
   * biriktirilgan muassasalarning BARCHA qozonxonalari.
   *
   * ⚠️ Faqat FAOL javobgar: faolsizlantirilgan shaxsning hisobi tirik
   * qolgan bo'lsa ham, u endi hech narsa ko'rmaydi.
   */
  private async responsibleScope(userId: string): Promise<ObjectScope> {
    const empty: ObjectScope = {
      kind: 'responsible',
      responsibleId: null,
      boilerIds: [],
      organizationIds: [],
    };
    const person = await this.persons.findOne({
      where: { userId, isActive: true },
      select: { id: true },
    });
    if (!person) return empty;

    const assignments = await this.boilers.manager.query<
      Array<{ organization_id: string | null; boiler_id: string | null }>
    >(
      `SELECT organization_id, boiler_id FROM responsible_assignments
        WHERE responsible_id = $1`,
      [person.id],
    );
    const organizationIds = assignments
      .map((row) => row.organization_id)
      .filter((id): id is string => id !== null);
    const boilerIds = new Set(
      assignments
        .map((row) => row.boiler_id)
        .filter((id): id is string => id !== null),
    );
    if (organizationIds.length > 0) {
      const rows = await this.boilers.manager.query<Array<{ id: string }>>(
        `SELECT id FROM boilers WHERE organization_id = ANY($1::uuid[])`,
        [organizationIds],
      );
      for (const row of rows) boilerIds.add(row.id);
    }

    return {
      kind: 'responsible',
      responsibleId: person.id,
      boilerIds: [...boilerIds],
      organizationIds,
    };
  }
}
