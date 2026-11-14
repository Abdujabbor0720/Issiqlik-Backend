import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOSHLANG'ICH SXEMA.
 *
 * ⚠️ Migratsiya QO'LDA yozilgan, `migration:generate` bilan emas, va u
 * XOM SQL ishlatadi. Sabab: generator qisman indekslarni (`WHERE ...`),
 * `LOWER()` bo'yicha indekslarni va `gen_random_uuid()` sukutini TypeORM
 * metama'lumotidan chiqara olmaydi — ular esa aynan telemetriya va
 * kotyol jadvallarining ishlashini hal qiladi.
 *
 * ⚠️ `gen_random_uuid()` — PostgreSQL 13+ YADROSIDA, `uuid-ossp`
 * kengaytmasi KERAK EMAS. `uuid_generate_v4()` ishlatilsa, deploy har
 * bir serverga kengaytma o'rnatishni talab qilardi va bu superuser
 * huquqini so'rardi.
 */
export class InitSchema1763000000000 implements MigrationInterface {
  name = 'InitSchema1763000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─────────────────── Enum turlari ───────────────────
    await queryRunner.query(`
      CREATE TYPE "users_role_enum" AS ENUM
        ('super_admin', 'admin', 'operator', 'viewer')
    `);
    await queryRunner.query(`
      CREATE TYPE "boilers_current_status_enum" AS ENUM
        ('active', 'medium', 'inactive', 'offline')
    `);
    await queryRunner.query(`
      CREATE TYPE "boilers_fuel_type_enum" AS ENUM
        ('gas', 'electric', 'coal', 'diesel', 'other')
    `);
    await queryRunner.query(`
      CREATE TYPE "telemetry_readings_status_enum" AS ENUM
        ('active', 'medium', 'inactive', 'offline')
    `);
    await queryRunner.query(`
      CREATE TYPE "alerts_type_enum" AS ENUM
        ('offline', 'low_temperature', 'critical_temperature', 'overheat')
    `);
    await queryRunner.query(`
      CREATE TYPE "alerts_severity_enum" AS ENUM ('info', 'warning', 'critical')
    `);
    await queryRunner.query(`
      CREATE TYPE "alerts_state_enum" AS ENUM ('open', 'acknowledged', 'resolved')
    `);
    await queryRunner.query(`
      CREATE TYPE "audit_logs_action_enum" AS ENUM
        ('create', 'update', 'delete', 'login', 'login_failed', 'logout', 'export')
    `);

    // ─────────────────── Hududlar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "regions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "code"        varchar(64)  NOT NULL,
        "name"        varchar(160) NOT NULL,
        "soato"       varchar(16),
        "center_lat"  double precision,
        "center_lng"  double precision,
        "bbox"        jsonb,
        CONSTRAINT "UQ_regions_code" UNIQUE ("code")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "districts" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "code"        varchar(64)  NOT NULL,
        "name"        varchar(160) NOT NULL,
        "short_name"  varchar(120) NOT NULL,
        "soato"       varchar(16),
        "kind"        varchar(24)  NOT NULL DEFAULT 'district',
        "region_id"   uuid NOT NULL,
        "center_lat"  double precision NOT NULL,
        "center_lng"  double precision NOT NULL,
        "geometry"    jsonb,
        CONSTRAINT "UQ_districts_code" UNIQUE ("code"),
        CONSTRAINT "FK_districts_region"
          FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_districts_region" ON "districts" ("region_id")`,
    );

    // ─────────────────── Foydalanuvchilar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "login"           varchar(64)  NOT NULL,
        "password_hash"   varchar(255) NOT NULL,
        "full_name"       varchar(160) NOT NULL,
        "email"           varchar(160),
        "phone"           varchar(32),
        "position"        varchar(120),
        "role"            "users_role_enum" NOT NULL DEFAULT 'viewer',
        "district_id"     uuid,
        "is_active"       boolean NOT NULL DEFAULT true,
        "last_login_at"   timestamptz,
        "failed_attempts" integer NOT NULL DEFAULT 0,
        "locked_until"    timestamptz,
        CONSTRAINT "UQ_users_login" UNIQUE ("login"),
        CONSTRAINT "FK_users_district"
          FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_users_district" ON "users" ("district_id")`,
    );
    /*
     * ⚠️ REGISTRGA BOG'LIQ BO'LMAGAN yagona indeks. Login `LOWER(...)`
     * bilan qidiriladi (`auth.service.ts`) va oddiy unique indeks
     * «Admin» bilan «admin» ni IKKI xil hisob deb o'tkazib yuborardi.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_login_lower" ON "users" (LOWER("login"))`,
    );

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "user_id"     uuid NOT NULL,
        "token_hash"  varchar(64) NOT NULL,
        "expires_at"  timestamptz NOT NULL,
        "revoked_at"  timestamptz,
        "user_agent"  varchar(255),
        "ip_address"  varchar(64),
        CONSTRAINT "UQ_refresh_tokens_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_refresh_tokens_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user" ON "refresh_tokens" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_expires" ON "refresh_tokens" ("expires_at")`,
    );

    // ─────────────────── Kataloglar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "boiler_brands" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "name"        varchar(180) NOT NULL,
        "note"        varchar(500),
        "is_archived" boolean NOT NULL DEFAULT false,
        "country"     varchar(80),
        CONSTRAINT "UQ_boiler_brands_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "firms" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        "name"          varchar(180) NOT NULL,
        "note"          varchar(500),
        "is_archived"   boolean NOT NULL DEFAULT false,
        "tin"           varchar(32),
        "phone"         varchar(32),
        "director_name" varchar(160),
        CONSTRAINT "UQ_firms_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "name"        varchar(180) NOT NULL,
        "note"        varchar(500),
        "is_archived" boolean NOT NULL DEFAULT false,
        "kind"        varchar(40) NOT NULL DEFAULT 'other',
        "phone"       varchar(32),
        CONSTRAINT "UQ_organizations_name" UNIQUE ("name")
      )
    `);

    // ─────────────────── Kotyollar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "boilers" (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        "district_id"            uuid NOT NULL,
        "address"                varchar(300),
        "lat"                    numeric(10,7),
        "lng"                    numeric(10,7),
        "lot_number"             varchar(64) NOT NULL,
        "firm_id"                uuid,
        "organization_id"        uuid,
        "brand_id"               uuid,
        "boiler_count"           integer NOT NULL DEFAULT 1,
        "norm_at_60"             numeric(12,2),
        "fuel_type"              "boilers_fuel_type_enum" NOT NULL DEFAULT 'gas',
        "capacity_kw"            numeric(10,2),
        "installed_year"         integer,
        "responsible_name"       varchar(160),
        "responsible_phone"      varchar(32),
        "note"                   varchar(1000),
        "current_status"         "boilers_current_status_enum" NOT NULL DEFAULT 'offline',
        "last_temperature"       numeric(6,2),
        "last_reading_at"        timestamptz,
        "status_changed_at"      timestamptz,
        "today_avg_temperature"  numeric(6,2),
        "is_archived"            boolean NOT NULL DEFAULT false,
        "archive_note"           varchar(500),
        CONSTRAINT "UQ_boilers_lot_number" UNIQUE ("lot_number"),
        CONSTRAINT "FK_boilers_district"
          FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_boilers_firm"
          FOREIGN KEY ("firm_id") REFERENCES "firms"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_boilers_organization"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_boilers_brand"
          FOREIGN KEY ("brand_id") REFERENCES "boiler_brands"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_district" ON "boilers" ("district_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_status" ON "boilers" ("current_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_district_status" ON "boilers" ("district_id", "current_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_firm" ON "boilers" ("firm_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_organization" ON "boilers" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_boilers_brand" ON "boilers" ("brand_id")`,
    );
    /*
     * ⚠️ QISMAN indeks: ro'yxatlarning deyarli hammasi
     * `is_archived = false` shartini qo'yadi. To'liq indeks arxivdagi
     * qatorlarni ham saqlab, bekorga kattalashib ketardi.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_boilers_active_only" ON "boilers" ("district_id", "current_status")
      WHERE "is_archived" = false
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_boilers_lot_lower" ON "boilers" (LOWER("lot_number"))`,
    );

    // ─────────────────── ESP32 qurilmalari ───────────────────
    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        "device_id"        varchar(64) NOT NULL,
        "name"             varchar(160),
        "api_key_hash"     varchar(64) NOT NULL,
        "api_key_preview"  varchar(12) NOT NULL,
        "boiler_id"        uuid,
        "is_active"        boolean NOT NULL DEFAULT true,
        "last_seen_at"     timestamptz,
        "last_ip_address"  varchar(45),
        "firmware_version" varchar(40),
        "readings_count"   bigint NOT NULL DEFAULT 0,
        "note"             varchar(500),
        CONSTRAINT "UQ_devices_device_id" UNIQUE ("device_id"),
        CONSTRAINT "FK_devices_boiler"
          FOREIGN KEY ("boiler_id") REFERENCES "boilers"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_devices_api_key_hash" ON "devices" ("api_key_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_devices_boiler" ON "devices" ("boiler_id")`,
    );
    /*
     * ⚠️ BITTA KOTYOLGA BITTA MODUL — baza darajasida. Servisda ham
     * tekshiriladi (`devices.service.ts`), lekin ikki parallel so'rov
     * tekshiruvdan birga o'tib, ikkalasi ham yozib yuborishi mumkin
     * edi. Qisman unique indeks buni STRUKTURAVIY imkonsiz qiladi.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_devices_one_per_boiler" ON "devices" ("boiler_id")
      WHERE "boiler_id" IS NOT NULL
    `);

    // ─────────────────── Telemetriya ───────────────────
    await queryRunner.query(`
      CREATE TABLE "telemetry_readings" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        "device_id"    uuid NOT NULL,
        "boiler_id"    uuid,
        "temperature"  numeric(6,2),
        "status"       "telemetry_readings_status_enum",
        "recorded_at"  timestamptz NOT NULL,
        "raw_payload"  jsonb,
        CONSTRAINT "FK_telemetry_device"
          FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_telemetry_boiler"
          FOREIGN KEY ("boiler_id") REFERENCES "boilers"("id") ON DELETE CASCADE
      )
    `);
    /*
     * ⚠️ ASOSIY indeks — `(boiler_id, recorded_at DESC)`. Barcha
     * so'rovlar bitta shaklda: «shu kotyolning oxirgi N o'lchovi» yoki
     * «falon oraliqdagi o'lchovlari». DESC tartib bilan «oxirgi qiymat»
     * so'rovi indeksning BOSHIDAN o'qiydi va saralash bosqichi umuman
     * bo'lmaydi.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_telemetry_boiler_time"
      ON "telemetry_readings" ("boiler_id", "recorded_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_telemetry_device_time"
      ON "telemetry_readings" ("device_id", "recorded_at" DESC)
    `);
    // ⚠️ Tungi tozalash uchun: usiz muddati o'tgan qatorlarni tanlash
    // butun jadvalni skanerlardi.
    await queryRunner.query(`
      CREATE INDEX "IDX_telemetry_recorded_at"
      ON "telemetry_readings" ("recorded_at")
    `);

    // ─────────────────── Ogohlantirishlar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "alerts" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        "boiler_id"           uuid NOT NULL,
        "type"                "alerts_type_enum" NOT NULL,
        "severity"            "alerts_severity_enum" NOT NULL DEFAULT 'warning',
        "state"               "alerts_state_enum" NOT NULL DEFAULT 'open',
        "message"             varchar(400) NOT NULL,
        "temperature"         numeric(6,2),
        "last_seen_at"        timestamptz NOT NULL,
        "resolved_at"         timestamptz,
        "acknowledged_at"     timestamptz,
        "acknowledged_by_id"  uuid,
        "ack_note"            varchar(500),
        CONSTRAINT "FK_alerts_boiler"
          FOREIGN KEY ("boiler_id") REFERENCES "boilers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_alerts_ack_user"
          FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_alerts_boiler" ON "alerts" ("boiler_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_alerts_state" ON "alerts" ("state")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_alerts_state_created" ON "alerts" ("state", "created_at" DESC)`,
    );
    /*
     * ⚠️ BITTA KOTYOLDA BITTA TURDAGI OCHIQ ogohlantirish — baza
     * darajasida. Servis buni tekshiradi, lekin telemetriya oqimida
     * ikki signal bir vaqtda kelib, ikkalasi ham «ochiq qator yo'q»
     * deb ko'rishi mumkin — natijada ro'yxatda ikkita bir xil qator
     * paydo bo'lardi.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_alerts_open_per_type"
      ON "alerts" ("boiler_id", "type")
      WHERE "state" IN ('open', 'acknowledged')
    `);

    // ─────────────────── Sozlamalar ───────────────────
    await queryRunner.query(`
      CREATE TABLE "system_settings" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"            timestamptz NOT NULL DEFAULT now(),
        "updated_at"            timestamptz NOT NULL DEFAULT now(),
        "scope"                 varchar(16) NOT NULL DEFAULT 'default',
        "active_min_c"          numeric(5,2) NOT NULL DEFAULT 50,
        "medium_min_c"          numeric(5,2) NOT NULL DEFAULT 40,
        "critical_min_c"        numeric(5,2) NOT NULL DEFAULT 20,
        "overheat_c"            numeric(5,2) NOT NULL DEFAULT 95,
        "offline_after_minutes" integer NOT NULL DEFAULT 15,
        "norm_temperature"      numeric(5,2) NOT NULL DEFAULT 60,
        "retention_days"        integer NOT NULL DEFAULT 90,
        "season_label"          varchar(40),
        CONSTRAINT "UQ_system_settings_scope" UNIQUE ("scope"),
        CONSTRAINT "CK_system_settings_thresholds"
          CHECK ("active_min_c" > "medium_min_c" AND "medium_min_c" > "critical_min_c")
      )
    `);

    // ─────────────────── Audit ───────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "user_id"     uuid,
        "actor_label" varchar(160),
        "action"      "audit_logs_action_enum" NOT NULL,
        "entity_name" varchar(64) NOT NULL,
        "entity_id"   uuid,
        "summary"     varchar(300),
        "before"      jsonb,
        "after"       jsonb,
        "ip_address"  varchar(45),
        CONSTRAINT "FK_audit_logs_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_user" ON "audit_logs" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_entity" ON "audit_logs" ("entity_name", "entity_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_created" ON "audit_logs" ("created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ Teskari tartibda: tashqi kalit bilan bog'langanlari avval.
    const tables = [
      'audit_logs',
      'system_settings',
      'alerts',
      'telemetry_readings',
      'devices',
      'boilers',
      'organizations',
      'firms',
      'boiler_brands',
      'refresh_tokens',
      'users',
      'districts',
      'regions',
    ];
    for (const table of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    const types = [
      'audit_logs_action_enum',
      'alerts_state_enum',
      'alerts_severity_enum',
      'alerts_type_enum',
      'telemetry_readings_status_enum',
      'boilers_fuel_type_enum',
      'boilers_current_status_enum',
      'users_role_enum',
    ];
    for (const type of types) {
      await queryRunner.query(`DROP TYPE IF EXISTS "${type}"`);
    }
  }
}
