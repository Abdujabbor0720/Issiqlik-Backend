import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { BootstrapModule } from './database/bootstrap/bootstrap.module';
import { ENTITIES } from './database/entities/entity-list';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuditModule } from './modules/audit/audit.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { BoilersModule } from './modules/boilers/boilers.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DevicesModule } from './modules/devices/devices.module';
import { GeoModule } from './modules/geo/geo.module';
import { OtaModule } from './modules/ota/ota.module';
import { HealthModule } from './modules/health/health.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ResponsiblesModule } from './modules/responsibles/responsibles.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      cache: true,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('database.host'),
        port: config.getOrThrow<number>('database.port'),
        username: config.getOrThrow<string>('database.username'),
        password: config.getOrThrow<string>('database.password'),
        database: config.getOrThrow<string>('database.name'),
        entities: ENTITIES,
        // ⚠️ `synchronize` HECH QACHON yoqilmaydi — sxema faqat
        // migratsiya orqali o'zgaradi (`src/config/data-source.ts`).
        synchronize: false,
        autoLoadEntities: false,
        logging: config.get<boolean>('database.logging')
          ? (['query', 'error'] as const)
          : (['error'] as const),
        ssl: config.get<boolean>('database.ssl')
          ? { rejectUnauthorized: false }
          : false,
        /*
         * ⚠️ Hovuz KENGROQ (30): telemetriya oqimi doimiy va u
         * dashboard so'rovlari bilan bitta hovuzni bo'lishadi. Hovuz
         * tor bo'lsa, og'ir hisobot so'rovi paytida kelgan signallar
         * ulanish kutib, qurilmaning timeout'iga tushardi.
         */
        extra: {
          max: 30,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('throttle.ttl') ?? 60) * 1000,
            limit: config.get<number>('throttle.limit') ?? 300,
          },
        ],
      }),
    }),

    ScheduleModule.forRoot(),

    // ⚠️ Domen modullaridan OLDIN: bo'sh bazada hududlar va birinchi
    // administrator shu yerda yoziladi. `onApplicationBootstrap` baribir
    // hamma modul tayyor bo'lgach ishlaydi, lekin ro'yxatdagi o'rni
    // nimaga bog'liqligini ko'rsatadi: u hech kimga bog'liq emas.
    BootstrapModule,

    // ─────── Umumiy (global) modullar ───────
    AuditModule,
    StorageModule,
    SettingsModule,
    RealtimeModule,

    // ─────── Domen modullari ───────
    AuthModule,
    UsersModule,
    GeoModule,
    CatalogsModule,
    BoilersModule,
    DevicesModule,
    AlertsModule,
    // ⚠️ `TelemetryModule` DAN OLDIN: telemetriya xona o'lchovlarini shu modulga uzatadi.
    RoomsModule,
    TelemetryModule,
    /*
     * ⚠️ OTA moduli `TelemetryModule` DAN KEYIN: u `DeviceThrottlerGuard`
     * ni shu moduldan oladi (xotirada sanoqchi — yagona nusxa bo'lishi
     * shart). Ro'yxatdagi tartib Nest uchun majburiy emas, lekin
     * bog'liqlik yo'nalishini ko'rsatadi.
     */
    OtaModule,
    DashboardModule,
    /*
     * ⚠️ XAVF qatlami — ogohlantirishlar (`AlertsModule`) USTIDA: jadval,
     * javobgarlar reyestri, hodisa jarayoni va eskalatsiya. U telemetriyaga
     * tegmaydi — faqat `AlertsService.changes$` ni tinglaydi.
     */
    MonitoringModule,
    ResponsiblesModule,
    IncidentsModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    /*
     * ⚠️ Tartib muhim: avval autentifikatsiya, keyin ruxsat, keyin limit.
     * Guard'lar GLOBAL — endpoint sukut bo'yicha YOPIQ bo'lishi kerak,
     * ochiqlari esa aniq `@Public()` bilan belgilanadi. Teskarisi bo'lsa,
     * yangi kontroller yozgan dasturchi uni jimgina ochiq qoldirib ketardi.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
