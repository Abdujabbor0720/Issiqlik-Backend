import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../database/entities/user.entity';
import { RealtimeGateway } from './realtime.gateway';

/** ⚠️ Global: telemetriya ham, ogohlantirish ham, cron ham xabar yuboradi. */
@Global()
@Module({
  /*
   * ⚠️ `JwtModule` sirsiz (`auth.module.ts` bilan AYNI sabab): sir har
   * tekshiruvda aniq beriladi — refresh token bilan ulanib bo'lmasin.
   */
  imports: [JwtModule.register({}), TypeOrmModule.forFeature([User])],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
