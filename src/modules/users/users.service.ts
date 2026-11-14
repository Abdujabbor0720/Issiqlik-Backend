import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsNull, Repository } from 'typeorm';
import {
  AuditAction,
  ROLE_LEVEL,
  UserRole,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { District } from '../../database/entities/district.entity';
import { User } from '../../database/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import type {
  CreateUserDto,
  UpdateUserDto,
  UserQueryDto,
} from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    private readonly audit: AuditService,
  ) {}

  async list(query: UserQueryDto): Promise<PaginatedResult<User>> {
    const qb = this.repo
      .createQueryBuilder('user')
      .leftJoin('user.district', 'district')
      .addSelect(['district.id', 'district.name', 'district.shortName'])
      .orderBy('user.createdAt', 'DESC')
      .skip(query.skip)
      .take(query.limit);

    if (query.search) {
      qb.andWhere(
        '(user.full_name ILIKE :q OR user.login ILIKE :q OR user.phone ILIKE :q)',
        { q: `%${query.search}%` },
      );
    }
    if (query.role) qb.andWhere('user.role = :role', { role: query.role });
    if (query.districtId) {
      qb.andWhere('user.district_id = :districtId', {
        districtId: query.districtId,
      });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('user.is_active = :isActive', { isActive: query.isActive });
    }

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }

  async findOne(id: string): Promise<User> {
    const user = await this.repo.findOne({
      where: { id },
      relations: { district: true },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return user;
  }

  async create(dto: CreateUserDto, actor: AuthUser): Promise<User> {
    this.assertCanAssignRole(actor, dto.role);
    await this.assertLoginFree(dto.login);
    this.assertDistrictRule(dto.role, dto.districtId ?? null);

    const user = this.repo.create({
      login: dto.login,
      passwordHash: await bcrypt.hash(dto.password, 10),
      fullName: dto.fullName,
      role: dto.role,
      districtId: dto.districtId ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      position: dto.position ?? null,
      isActive: true,
    });

    const saved = await this.repo.save(user);
    await this.audit.log({
      actor,
      action: AuditAction.CREATE,
      entityName: 'User',
      entityId: saved.id,
      summary: `Foydalanuvchi yaratildi: ${saved.fullName} (${saved.login})`,
      after: { login: saved.login, role: saved.role },
    });
    return this.findOne(saved.id);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<User> {
    const user = await this.findOne(id);
    const before = {
      role: user.role,
      isActive: user.isActive,
      login: user.login,
    };

    if (dto.login && dto.login !== user.login) {
      await this.assertLoginFree(dto.login);
    }

    const role = dto.role ?? user.role;
    /*
     * ⚠️ IKKI tekshiruv: yangi rol ham, MAVJUD rol ham o'z darajasidan
     * past bo'lishi kerak. Faqat yangisi tekshirilsa, administrator
     * `super_admin` hisobini `operator` ga tushirib, keyin uni
     * egallab olardi.
     */
    if (dto.role && dto.role !== user.role) {
      this.assertCanAssignRole(actor, dto.role);
    }
    this.assertCanManage(actor, user);

    const districtId =
      dto.districtId !== undefined ? dto.districtId : user.districtId;
    this.assertDistrictRule(role, districtId ?? null);

    /*
     * ⚠️ OXIRGI SUPERADMINNI O'CHIRIB BO'LMAYDI va uning rolini
     * pasaytirib ham bo'lmaydi. Aks holda tizimda sozlamalarga va
     * foydalanuvchilarga kira oladigan birorta hisob qolmasdi — buni
     * tiklashning yagona yo'li baza bilan qo'lda ishlash bo'lardi.
     */
    if (user.role === UserRole.SUPER_ADMIN) {
      const demoting = dto.role && dto.role !== UserRole.SUPER_ADMIN;
      const deactivating = dto.isActive === false;
      if (demoting || deactivating) {
        await this.assertNotLastSuperAdmin(user.id);
      }
    }

    Object.assign(user, {
      login: dto.login ?? user.login,
      fullName: dto.fullName ?? user.fullName,
      role,
      districtId: districtId ?? null,
      email: dto.email !== undefined ? dto.email : user.email,
      phone: dto.phone !== undefined ? dto.phone : user.phone,
      position: dto.position !== undefined ? dto.position : user.position,
      isActive: dto.isActive !== undefined ? dto.isActive : user.isActive,
    });

    const saved = await this.repo.save(user);

    // Faolsizlantirilgan foydalanuvchining sessiyalari darhol yopiladi.
    if (dto.isActive === false) await this.revokeTokens(saved.id);

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'User',
      entityId: saved.id,
      summary: `Foydalanuvchi tahrirlandi: ${saved.fullName}`,
      before,
      after: { role: saved.role, isActive: saved.isActive, login: saved.login },
    });
    return this.findOne(saved.id);
  }

  async resetPassword(
    id: string,
    newPassword: string,
    actor: AuthUser,
  ): Promise<void> {
    const user = await this.findOne(id);
    this.assertCanManage(actor, user);
    await this.repo.update(id, {
      passwordHash: await bcrypt.hash(newPassword, 10),
      failedAttempts: 0,
      lockedUntil: null,
    });
    // ⚠️ Parol almashgach eski sessiyalar yopiladi (`auth.service` bilan AYNI qoida).
    await this.revokeTokens(id);

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'User',
      entityId: id,
      summary: `Parol administrator tomonidan almashtirildi: ${user.fullName}`,
    });
  }

  async remove(id: string, actor: AuthUser): Promise<void> {
    const user = await this.findOne(id);
    if (user.id === actor.id) {
      throw new BadRequestException('O‘z hisobingizni o‘chira olmaysiz');
    }
    this.assertCanManage(actor, user);
    if (user.role === UserRole.SUPER_ADMIN) {
      await this.assertNotLastSuperAdmin(user.id);
    }

    await this.repo.delete(id);
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'User',
      entityId: id,
      summary: `Foydalanuvchi o‘chirildi: ${user.fullName} (${user.login})`,
      before: { login: user.login, role: user.role },
    });
  }

  /**
   * TUMAN MAS'ULLARI — har bir tuman va unga biriktirilgan shaxs(lar).
   *
   * ⚠️⚠️ Ro'yxat TUMANLARDAN boshlanadi, foydalanuvchilardan EMAS.
   * Foydalanuvchilardan boshlansa, MAS'ULI YO'Q tuman ro'yxatda
   * umuman ko'rinmasdi — holbuki bu ekranning butun maqsadi aynan shu
   * bo'shliqni ko'rsatish: «16 ta tumandan 3 tasida mas'ul yo'q».
   *
   * ⚠️ Bitta tumanda bir nechta mas'ul bo'lishi MUMKIN va bu ataylab.
   * Qat'iy «bitta tumanga bitta mas'ul» qoidasi qo'yilsa, mas'ul
   * almashganda eskisini AVVAL o'chirish kerak bo'lardi — ya'ni uning
   * audit jurnalidagi shaxsi yo'qolardi. Endi eskisi faolsizlantiriladi,
   * yangisi qo'shiladi va tarix butun qoladi.
   */
  async districtResponsibles(): Promise<
    Array<{
      districtId: string;
      code: string;
      name: string;
      shortName: string;
      kind: string;
      responsibles: User[];
    }>
  > {
    const [districts, users] = await Promise.all([
      this.districts.find({ order: { name: 'ASC' } }),
      this.repo.find({
        where: { role: UserRole.OPERATOR },
        order: { fullName: 'ASC' },
      }),
    ]);

    /*
     * ⚠️ Guruhlash XOTIRADA, tuman bo'yicha alohida so'rovlar bilan
     * EMAS: 16 ta tuman uchun 16 ta so'rov — bu «N+1» va u sahifa
     * ochilish vaqtini bekorga uzaytirardi. Ikkala jadval ham kichik.
     */
    const byDistrict = new Map<string, User[]>();
    for (const user of users) {
      if (!user.districtId) continue;
      const list = byDistrict.get(user.districtId) ?? [];
      list.push(user);
      byDistrict.set(user.districtId, list);
    }

    return districts.map((district) => ({
      districtId: district.id,
      code: district.code,
      name: district.name,
      shortName: district.shortName,
      kind: district.kind,
      responsibles: byDistrict.get(district.id) ?? [],
    }));
  }

  // ───────────────── ichki ─────────────────

  /**
   * ⚠️⚠️ HUQUQ OSHIRISHNING OLDINI OLADI: foydalanuvchi O'ZIDAN
   * YUQORI yoki O'ZIGA TENG darajadagi rolni bera olmaydi.
   *
   * Busiz `users.create` huquqi bor administrator o'ziga yangi
   * `super_admin` yaratib, butun tizimni egallab olardi. Bu tekshiruv
   * SERVERDA bo'lishi shart: frontend'da rol ro'yxatini qisqartirish
   * faqat ko'rinishni boshqaradi, so'rovni esa to'g'ridan-to'g'ri
   * yuborish mumkin.
   */
  private assertCanAssignRole(actor: AuthUser, role: UserRole): void {
    const actorLevel = ROLE_LEVEL[actor.role] ?? 0;
    if ((ROLE_LEVEL[role] ?? 0) >= actorLevel) {
      throw new ForbiddenException(
        'O‘zingizdan yuqori yoki teng darajadagi rolni bera olmaysiz',
      );
    }
  }

  /**
   * ⚠️ O'ZIDAN yuqori/teng darajadagi hisobni TAHRIRLAB, parolini
   * almashtirib yoki o'chirib ham bo'lmaydi — aks holda administrator
   * `super_admin` ning parolini almashtirib, uning hisobiga kirib
   * olardi.
   *
   * ⚠️ O'Z hisobiga tegish mumkin (parol, F.I.Sh) — u o'zining
   * darajasiga teng bo'lsa ham.
   */
  private assertCanManage(actor: AuthUser, target: User): void {
    if (actor.id === target.id) return;
    const actorLevel = ROLE_LEVEL[actor.role] ?? 0;
    if ((ROLE_LEVEL[target.role] ?? 0) >= actorLevel) {
      throw new ForbiddenException(
        'Bu hisob sizdan yuqori yoki teng darajada — unga tegib bo‘lmaydi',
      );
    }
  }

  private async assertLoginFree(login: string): Promise<void> {
    const exists = await this.repo
      .createQueryBuilder('user')
      .where('LOWER(user.login) = LOWER(:login)', { login })
      .getExists();
    if (exists) throw new ConflictException('Bunday login allaqachon mavjud');
  }

  /**
   * ⚠️ OPERATORGA TUMAN MAJBURIY. Tumansiz operator — ma'lumot chegarasi
   * yo'q operator, ya'ni amalda administrator: u butun viloyat
   * kotyollarini tahrirlay olardi. Teskarisi ham: viloyat darajasidagi
   * rolga tuman biriktirilsa, u o'z huquqining bir qismini jimgina
   * yo'qotardi.
   */
  private assertDistrictRule(role: UserRole, districtId: string | null): void {
    if (role === UserRole.OPERATOR && !districtId) {
      throw new BadRequestException(
        'Tuman operatori uchun tuman tanlanishi shart',
      );
    }
    if (role !== UserRole.OPERATOR && districtId) {
      throw new BadRequestException(
        'Tuman faqat «Tuman operatori» roliga biriktiriladi',
      );
    }
  }

  private async assertNotLastSuperAdmin(excludeId: string): Promise<void> {
    const count = await this.repo.count({
      where: { role: UserRole.SUPER_ADMIN, isActive: true },
    });
    if (count <= 1) {
      throw new BadRequestException(
        'Tizimda kamida bitta faol bosh administrator qolishi kerak',
      );
    }
    void excludeId;
  }

  private async revokeTokens(userId: string): Promise<void> {
    // ⚠️ `IsNull()` — xom `null` `= NULL` ga aylanib, hech bir qatorga
    // mos kelmasdi (`auth.service.ts` dagi izohga qarang).
    await this.tokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }
}
