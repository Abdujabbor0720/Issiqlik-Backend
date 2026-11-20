import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, LessThan, Repository } from 'typeorm';
import { AuditAction } from '../../common/constants/enums';
import { ROLE_PERMISSIONS } from '../../common/constants/permissions';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { User } from '../../database/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import type { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import type { JwtPayload } from './strategies/jwt.strategy';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * ⚠️ KECHIKTIRISH, BLOKLASH EMAS.
 *
 * Ketma-ket noto'g'ri urinishdan keyin hisob yopilmaydi, balki keyingi
 * urinish KECHIKTIRILADI. Bloklash «raqibning loginiga o'nta noto'g'ri
 * parol kiritib, uni tizimdan chiqarib qo'yish» hujumiga yo'l ochardi —
 * qishda tuman operatori ertalab tizimga kira olmay qolardi.
 */
const LOCK_AFTER_ATTEMPTS = 7;
const LOCK_MINUTES = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta): Promise<LoginResult> {
    /*
     * ⚠️ `passwordHash` ATAYLAB tanlanadi (`addSelect`): entity'da u
     * `select: false` — ya'ni boshqa hech bir so'rovda baza bo'ylab
     * tarqalmaydi va tasodifan javobga tushmaydi.
     *
     * ⚠️ Login REGISTRGA BOG'LIQ EMAS (`LOWER(...)`): «Masul.Asaka» va
     * «masul.asaka» bitta hisob. Aks holda bosh harfni ko'zda
     * tutmagan operator «login noto'g'ri» xabarini olardi va buning
     * sababini hech kim topa olmasdi.
     */
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.login) = LOWER(:login)', { login: dto.login })
      .getOne();

    if (!user) {
      await this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        entityName: 'User',
        summary: `Noma'lum login: ${dto.login}`,
        ipAddress: meta.ip ?? null,
      });
      // ⚠️ «Login topilmadi» DEYILMAYDI: aks holda forma qaysi
      // loginlar mavjudligini aytib beradigan vositaga aylanardi.
      throw new UnauthorizedException('Login yoki parol noto‘g‘ri');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 1000,
      );
      throw new UnauthorizedException(
        `Juda ko‘p urinish. ${seconds} soniyadan so‘ng qayta urinib ko‘ring`,
      );
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      await this.registerFailure(user, meta);
      throw new UnauthorizedException('Login yoki parol noto‘g‘ri');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Hisob faolsizlantirilgan — administratorga murojaat qiling',
      );
    }

    await this.users.update(user.id, {
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    });

    const authUser = this.toAuthUser(user);
    const tokens = await this.issueTokens(user, meta);

    await this.audit.log({
      actor: authUser,
      action: AuditAction.LOGIN,
      entityName: 'User',
      entityId: user.id,
      summary: `${user.fullName} tizimga kirdi`,
      ipAddress: meta.ip ?? null,
    });

    return { ...tokens, user: authUser };
  }

  /**
   * REFRESH — token ALMASHTIRILADI (rotation).
   *
   * ⚠️ Eski refresh token darhol bekor qilinadi. Agar u o'g'irlangan
   * bo'lsa, o'g'ri yoki egasi — faqat BITTASI yangi token oladi, ikkinchisi
   * esa «token bekor qilingan» xatosini ko'radi va o'g'irlik fakti
   * bilinadi. Token qayta ishlatiladigan bo'lsa, o'g'ri uni muddati
   * tugaguncha (30 kun) jimgina ishlatib yurardi.
   */
  async refresh(rawToken: string, meta: RequestMeta): Promise<LoginResult> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(rawToken, {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException(
        'Refresh token yaroqsiz yoki muddati tugagan',
      );
    }

    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Refresh token kutilgan edi');
    }

    const hash = this.hashToken(rawToken);
    const stored = await this.tokens.findOne({ where: { tokenHash: hash } });

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Refresh token bekor qilingan');
    }

    const user = await this.users.findOne({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Foydalanuvchi faol emas');
    }

    await this.tokens.update(stored.id, { revokedAt: new Date() });

    const tokens = await this.issueTokens(user, meta);
    return { ...tokens, user: this.toAuthUser(user) };
  }

  /** Chiqish — shu qurilmadagi refresh token bekor qilinadi. */
  async logout(rawToken: string | undefined, actor: AuthUser): Promise<void> {
    if (rawToken) {
      await this.tokens.update(
        { tokenHash: this.hashToken(rawToken) },
        { revokedAt: new Date() },
      );
    }
    await this.audit.log({
      actor,
      action: AuditAction.LOGOUT,
      entityName: 'User',
      entityId: actor.id,
      summary: `${actor.fullName} tizimdan chiqdi`,
    });
  }

  async changePassword(actor: AuthUser, dto: ChangePasswordDto): Promise<void> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: actor.id })
      .getOne();

    if (!user) throw new UnauthorizedException('Foydalanuvchi topilmadi');

    const matches = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!matches) throw new BadRequestException('Joriy parol noto‘g‘ri');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('Yangi parol eskisidan farq qilishi kerak');
    }

    await this.users.update(user.id, {
      passwordHash: await bcrypt.hash(dto.newPassword, 10),
    });

    /*
     * ⚠️ Parol o'zgarganda BARCHA refresh tokenlar bekor qilinadi.
     * Parolni almashtirishning asosiy sababi — «kimdir bilib qolgan»
     * degan shubha. Eski tokenlar qolsa, u shubha bekorga bo'lardi:
     * begona odam yana 30 kun kirib turardi.
     */
    /*
     * ⚠️⚠️ `IsNull()`, oddiy `null` EMAS. TypeORM `where` ichidagi xom
     * `null` ni `= NULL` deb yozadi va bu SQL da HECH QACHON rost
     * bo'lmaydi — ya'ni birorta token bekor qilinmasdi va «parolni
     * almashtirdim» degan amal hech narsa qilmasdi. Begona odam esa
     * eski tokeni bilan yana 30 kun kirib turardi.
     */
    await this.tokens.update(
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /** Muddati o'tgan tokenlarni tozalash — kunlik cron chaqiradi. */
  async purgeExpiredTokens(): Promise<number> {
    const result = await this.tokens.delete({
      expiresAt: LessThan(new Date()),
    });
    return result.affected ?? 0;
  }

  // ───────────────── ichki ─────────────────

  private toAuthUser(user: User): AuthUser {
    return {
      id: user.id,
      login: user.login,
      role: user.role,
      fullName: user.fullName,
      districtId: user.districtId,
      agencyId: user.agencyId,
      permissions: ROLE_PERMISSIONS[user.role] ?? [],
    };
  }

  private async registerFailure(user: User, meta: RequestMeta): Promise<void> {
    const attempts = user.failedAttempts + 1;
    const lockedUntil =
      attempts >= LOCK_AFTER_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60_000)
        : user.lockedUntil;

    await this.users.update(user.id, {
      failedAttempts: attempts >= LOCK_AFTER_ATTEMPTS ? 0 : attempts,
      lockedUntil,
    });

    await this.audit.log({
      action: AuditAction.LOGIN_FAILED,
      entityName: 'User',
      entityId: user.id,
      summary: `Noto‘g‘ri parol (${attempts}-urinish): ${user.login}`,
      ipAddress: meta.ip ?? null,
    });
  }

  private async issueTokens(
    user: User,
    meta: RequestMeta,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const base = { sub: user.id, login: user.login, role: user.role };

    /*
     * ⚠️ `JwtSignOptions['expiresIn']` ga cast. `jsonwebtoken` ning
     * tiplari muddatni `StringValue` shablon-literal turi bilan
     * ifodalaydi ('30m', '7d' …), `.env` dan esa oddiy `string`
     * keladi va kompilyator ularni mos kelmaydi deb hisoblaydi.
     * Qiymat `validation.schema.ts` da allaqachon tekshirilgan.
     */
    const accessTtl = this.config.getOrThrow<string>(
      'jwt.accessTtl',
    ) as JwtSignOptions['expiresIn'];
    const refreshTtl = this.config.getOrThrow<string>(
      'jwt.refreshTtl',
    ) as JwtSignOptions['expiresIn'];

    const accessToken = await this.jwt.signAsync(
      { ...base, typ: 'access' },
      {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
        expiresIn: accessTtl,
      },
    );

    /*
     * ⚠️ Refresh tokenga TASODIFIY `jti` qo'shiladi. Usiz bir soniyada
     * ikki marta chiqarilgan token BAYTMA-BAYT bir xil bo'lardi (payload
     * va `iat` bir xil), hash ham bir xil — va unique indeks ikkinchisini
     * rad etardi. Foydalanuvchi uchun bu «tizimga kira olmadim» degani.
     */
    const refreshToken = await this.jwt.signAsync(
      { ...base, typ: 'refresh', jti: randomBytes(12).toString('hex') },
      {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
        expiresIn: refreshTtl,
      },
    );

    const decoded = this.jwt.decode<{ exp?: number } | null>(refreshToken);
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await this.tokens.insert({
      userId: user.id,
      tokenHash: this.hashToken(refreshToken),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ipAddress: meta.ip?.slice(0, 64) ?? null,
    });

    const accessDecoded = this.jwt.decode<{
      exp?: number;
      iat?: number;
    } | null>(accessToken);
    const expiresIn =
      accessDecoded?.exp && accessDecoded?.iat
        ? accessDecoded.exp - accessDecoded.iat
        : 1800;

    return { accessToken, refreshToken, expiresIn };
  }

  /** ⚠️ Token BAZADA xom holda saqlanmaydi — faqat SHA-256 hash'i. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
