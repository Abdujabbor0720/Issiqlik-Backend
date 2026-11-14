import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** ⚠️ Global: telemetriya ham, ogohlantirish ham, cron ham xabar yuboradi. */
@Global()
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
