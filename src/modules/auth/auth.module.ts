import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { User } from '../../database/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    /*
     * ⚠️ `JwtModule` sirsiz ro'yxatdan o'tadi: access va refresh
     * tokenlar BOSHQA-BOSHQA sir bilan imzolanadi va har imzolash
     * joyida sir aniq ko'rsatiladi (`auth.service.ts`). Modulda bitta
     * sir qo'yilsa, refresh tokenni access token o'rniga ishlatib
     * bo'lardi.
     */
    JwtModule.register({}),
    TypeOrmModule.forFeature([User, RefreshToken]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
