import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { ROLE_PERMISSIONS } from '../../../common/constants/permissions';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import { User } from '../../../database/entities/user.entity';

export interface JwtPayload {
  sub: string;
  login: string;
  role: string;
  /** Token turini ajratish: `access` yoki `refresh`. */
  typ: 'access' | 'refresh';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.accessSecret'),
    });
  }

  /**
   * ⚠️ Har so'rovda FOYDALANUVCHI BAZADAN o'qiladi, token ichidagi
   * ma'lumotga ishonilmaydi. Sabab: token 30 daqiqa amal qiladi va shu
   * vaqt ichida xodim o'chirilishi, roli pasaytirilishi yoki boshqa
   * tumanga o'tkazilishi mumkin. Token ichidagi eski rol bilan u
   * o'chirilgan huquqdan yarim soat foydalanib turardi.
   *
   * ⚠️ Ruxsatlar ham TOKENDAN emas, ROLDAN hisoblanadi: ruxsat ro'yxati
   * kodda o'zgarganda allaqachon berilgan tokenlar eski ro'yxat bilan
   * qolib ketmaydi.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Access token kutilgan edi');
    }

    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: {
        id: true,
        login: true,
        fullName: true,
        role: true,
        districtId: true,
        isActive: true,
      },
    });

    if (!user) throw new UnauthorizedException('Foydalanuvchi topilmadi');
    if (!user.isActive) {
      throw new UnauthorizedException('Hisob faolsizlantirilgan');
    }

    return {
      id: user.id,
      login: user.login,
      role: user.role,
      fullName: user.fullName,
      districtId: user.districtId,
      permissions: ROLE_PERMISSIONS[user.role] ?? [],
    };
  }
}
