import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * XAVF QATLAMI: tashkilot/boshqarma, javobgar shaxslar reyestri, monitoring
 * jadvali, bayram kunlari, XAVF hodisalari, tarix, panel ogohlantirishlari
 * va eskalatsiya qoidalari.
 *
 * ⚠️⚠️ MAVJUD JADVALLARGA FAQAT USTUN QO'SHILADI (`organizations.agency_id`,
 * `users.agency_id`) va ikkita enum KENGAYTIRILADI. Telemetriya,
 * ogohlantirish (`alerts`) va rollarning hozirgi xulq-atvori o'zgarmaydi:
 * XAVF ular USTIGA quriladi.
 *
 * ⚠️ Sukut qiymatlari (jadval, eskalatsiya, bayramlar) — BOSHLANG'ICH
 * nuqta, biznes qarori emas: administrator ularni paneldan o'zgartiradi.
 */
export class IncidentManagement1764100000000 implements MigrationInterface {
  name = 'IncidentManagement1764100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── 1. Rollar va audit amallari ───
    /*
     * ⚠️ `ADD VALUE` tranzaksiya ichida ruxsat etilgan (PG ≥ 12), faqat
     * yangi qiymatni SHU tranzaksiyada ishlatib bo'lmaydi — bu migratsiya
     * ularni ishlatmaydi.
     */
    await queryRunner.query(
      `ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'agency_officer'`,
    );
    await queryRunner.query(
      `ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'responsible'`,
    );
    for (const action of ['notify', 'escalate', 'status_change']) {
      await queryRunner.query(
        `ALTER TYPE "audit_logs_action_enum" ADD VALUE IF NOT EXISTS '${action}'`,
      );
    }

    // ─── 2. Tashkilot / boshqarma ───
    await queryRunner.query(`
      CREATE TABLE "agencies" (
        "id"           uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        "name"         varchar(180) NOT NULL,
        "note"         varchar(500),
        "is_archived"  boolean      NOT NULL DEFAULT false,
        "district_key" varchar(32),
        "phone"        varchar(32),
        CONSTRAINT "PK_agencies" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agencies_name" UNIQUE ("name"),
        CONSTRAINT "FK_agencies_district" FOREIGN KEY ("district_key")
          REFERENCES "districts"("key") ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_agencies_district_key" ON "agencies" ("district_key")`,
    );

    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN "agency_id" uuid,
        ADD CONSTRAINT "FK_organizations_agency" FOREIGN KEY ("agency_id")
          REFERENCES "agencies"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_organizations_agency_id" ON "organizations" ("agency_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "agency_id" uuid,
        ADD CONSTRAINT "FK_users_agency" FOREIGN KEY ("agency_id")
          REFERENCES "agencies"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_users_agency_id" ON "users" ("agency_id")`,
    );

    // ─── 3. Javobgar shaxslar reyestri ───
    await queryRunner.query(`
      CREATE TABLE "responsible_persons" (
        "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        "updated_at"  timestamptz  NOT NULL DEFAULT now(),
        "full_name"   varchar(160) NOT NULL,
        "position"    varchar(160) NOT NULL,
        "employer"    varchar(200),
        "phone"       varchar(32)  NOT NULL,
        "email"       varchar(160),
        "district_id" uuid,
        "user_id"     uuid,
        "is_active"   boolean      NOT NULL DEFAULT true,
        "note"        varchar(500),
        CONSTRAINT "PK_responsible_persons" PRIMARY KEY ("id"),
        CONSTRAINT "FK_responsible_persons_district" FOREIGN KEY ("district_id")
          REFERENCES "districts"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_responsible_persons_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_responsible_persons_district_id" ON "responsible_persons" ("district_id")`,
    );
    // ⚠️ Bitta hisob — bitta javobgar: aks holda panel kimning obyektlarini ko'rsatishini bilmasdi.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_responsible_persons_user_id"
        ON "responsible_persons" ("user_id") WHERE "user_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "responsible_assignments" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        "updated_at"          timestamptz  NOT NULL DEFAULT now(),
        "responsible_id"      uuid         NOT NULL,
        "organization_id"     uuid,
        "boiler_id"           uuid,
        "responsibility_type" varchar(24)  NOT NULL DEFAULT 'other',
        "is_primary"          boolean      NOT NULL DEFAULT false,
        "note"                varchar(300),
        CONSTRAINT "PK_responsible_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_responsible_assignments_person" FOREIGN KEY ("responsible_id")
          REFERENCES "responsible_persons"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_responsible_assignments_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_responsible_assignments_boiler" FOREIGN KEY ("boiler_id")
          REFERENCES "boilers"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_responsible_assignments_target"
          CHECK (("organization_id" IS NULL) <> ("boiler_id" IS NULL)),
        CONSTRAINT "CHK_responsible_assignments_type"
          CHECK ("responsibility_type" IN ('director', 'facilities', 'heating_technician', 'other'))
      )
    `);
    for (const column of ['responsible_id', 'organization_id', 'boiler_id']) {
      await queryRunner.query(
        `CREATE INDEX "IDX_responsible_assignments_${column}" ON "responsible_assignments" ("${column}")`,
      );
    }
    /*
     * ⚠️ Bir shaxs bir nishonga BIR marta; bir nishonda BITTA asosiy.
     * Qisman indekslar: nishonning ikkinchi ustuni `NULL`.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_responsible_assignments_org"
        ON "responsible_assignments" ("responsible_id", "organization_id")
        WHERE "organization_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_responsible_assignments_boiler"
        ON "responsible_assignments" ("responsible_id", "boiler_id")
        WHERE "boiler_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_responsible_assignments_org_primary"
        ON "responsible_assignments" ("organization_id")
        WHERE "is_primary" AND "organization_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_responsible_assignments_boiler_primary"
        ON "responsible_assignments" ("boiler_id")
        WHERE "is_primary" AND "boiler_id" IS NOT NULL
    `);

    // ─── 4. Monitoring jadvali ───
    await queryRunner.query(`
      CREATE TABLE "monitoring_schedules" (
        "id"                   uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           timestamptz  NOT NULL DEFAULT now(),
        "updated_at"           timestamptz  NOT NULL DEFAULT now(),
        "scope_type"           varchar(16)  NOT NULL,
        "scope_id"             uuid,
        "mode"                 varchar(16)  NOT NULL DEFAULT 'always',
        "active_days"          smallint[]   NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
        "heating_start_min"    smallint     NOT NULL DEFAULT 0,
        "heating_end_min"      smallint     NOT NULL DEFAULT 0,
        "monitor_start_min"    smallint     NOT NULL DEFAULT 0,
        "monitor_end_min"      smallint     NOT NULL DEFAULT 0,
        "min_room_temperature" numeric(5,2),
        "observe_holidays"     boolean      NOT NULL DEFAULT true,
        "note"                 varchar(500),
        CONSTRAINT "PK_monitoring_schedules" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_monitoring_schedules_scope"
          CHECK ("scope_type" IN ('global', 'object_type', 'organization', 'boiler')
                 AND (("scope_type" = 'global') = ("scope_id" IS NULL))),
        CONSTRAINT "CHK_monitoring_schedules_mode" CHECK ("mode" IN ('always', 'schedule')),
        CONSTRAINT "CHK_monitoring_schedules_minutes" CHECK (
          "heating_start_min" BETWEEN 0 AND 1439 AND "heating_end_min" BETWEEN 0 AND 1439 AND
          "monitor_start_min" BETWEEN 0 AND 1439 AND "monitor_end_min" BETWEEN 0 AND 1439),
        CONSTRAINT "CHK_monitoring_schedules_days"
          CHECK ("active_days" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
                 AND ("mode" = 'always' OR cardinality("active_days") > 0)),
        CONSTRAINT "CHK_monitoring_schedules_min_temp"
          CHECK ("min_room_temperature" IS NULL OR "min_room_temperature" BETWEEN 0 AND 40)
      )
    `);
    // ⚠️ Bitta nishonda bitta jadval — aks holda «qaysi biri amalda» tasodifga qolardi.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_monitoring_schedules_scope"
        ON "monitoring_schedules"
        ("scope_type", COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid))
    `);

    /*
     * ⚠️⚠️ GLOBAL ZAXIRA — 24/7. Jadvali yo'q obyekt XAVF dan «yashirinib»
     * qolmasligi uchun sukut — eng qattiq rejim: noaniqlikda ortiqcha
     * ogohlantirish yo'qolgan ogohlantirishdan yaxshi.
     */
    await queryRunner.query(`
      INSERT INTO "monitoring_schedules" ("scope_type", "scope_id", "mode", "note")
      VALUES ('global', NULL, 'always', 'Umumiy zaxira: jadvali belgilanmagan obyektlar 24/7 nazoratda')
    `);
    /*
     * ⚠️ Obyekt turlari bo'yicha boshlang'ich jadval (texnik topshiriq §2):
     *   • maktab: Du–Sha, isitish 06:00–18:00, XAVF monitoringi 07:00–18:00;
     *   • bog'cha: Du–Ju, isitish 06:00–19:00, monitoring 07:00–19:00;
     *   • shifoxona va poliklinika: 24/7 (tibbiyot — uzluksiz isitish).
     * Tur katalogda yo'q bo'lsa (o'chirilgan) — qator yozilmaydi.
     */
    const defaults: Array<
      [string, string, number[], number, number, number, number]
    > = [
      ['school', 'schedule', [1, 2, 3, 4, 5, 6], 360, 1080, 420, 1080],
      ['kindergarten', 'schedule', [1, 2, 3, 4, 5], 360, 1140, 420, 1140],
      ['hospital', 'always', [1, 2, 3, 4, 5, 6, 7], 0, 0, 0, 0],
      ['clinic', 'always', [1, 2, 3, 4, 5, 6, 7], 0, 0, 0, 0],
    ];
    for (const [code, mode, days, hs, he, ms, me] of defaults) {
      await queryRunner.query(
        `INSERT INTO "monitoring_schedules"
           ("scope_type", "scope_id", "mode", "active_days",
            "heating_start_min", "heating_end_min", "monitor_start_min", "monitor_end_min",
            "observe_holidays", "note")
         SELECT 'object_type', t."id", $2, $3::smallint[], $4, $5, $6, $7, $8,
                'Boshlang‘ich jadval (migratsiya) — administrator o‘zgartiradi'
           FROM "object_types" t WHERE t."code" = $1`,
        [code, mode, days, hs, he, ms, me, mode === 'schedule'],
      );
    }

    await queryRunner.query(`
      CREATE TABLE "monitoring_holidays" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz  NOT NULL DEFAULT now(),
        "updated_at" timestamptz  NOT NULL DEFAULT now(),
        "day"        date         NOT NULL,
        "name"       varchar(160) NOT NULL,
        CONSTRAINT "PK_monitoring_holidays" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_monitoring_holidays_day" UNIQUE ("day")
      )
    `);
    // ⚠️ Faqat SANASI QAT'IY bayramlar; hayitlar har yili e'lon qilinadi — admin qo'shadi.
    await queryRunner.query(`
      INSERT INTO "monitoring_holidays" ("day", "name") VALUES
        ('2026-12-08', 'Konstitutsiya kuni'),
        ('2027-01-01', 'Yangi yil'),
        ('2027-03-08', 'Xalqaro xotin-qizlar kuni'),
        ('2027-03-21', 'Navro‘z bayrami')
    `);

    // ─── 5. XAVF hodisalari ───
    await queryRunner.query(`
      CREATE TABLE "incidents" (
        "id"                   uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           timestamptz   NOT NULL DEFAULT now(),
        "updated_at"           timestamptz   NOT NULL DEFAULT now(),
        "number"               bigint        GENERATED ALWAYS AS IDENTITY,
        "dedupe_key"           varchar(200)  NOT NULL,
        "kind"                 varchar(32)   NOT NULL,
        "severity"             varchar(16)   NOT NULL,
        "status"               varchar(16)   NOT NULL DEFAULT 'new',
        "title"                varchar(300)  NOT NULL,
        "boiler_id"            uuid          NOT NULL,
        "room_id"              uuid,
        "room_name"            varchar(120),
        "device_id"            uuid,
        "device_label"         varchar(160),
        "organization_id"      uuid,
        "organization_name"    varchar(180),
        "district_id"          uuid          NOT NULL,
        "agency_id"            uuid,
        "agency_name"          varchar(180),
        "source_alert_id"      uuid,
        "temperature"          numeric(6,2),
        "current_temperature"  numeric(6,2),
        "extreme_temperature"  numeric(6,2),
        "threshold"            numeric(6,2),
        "detected_at"          timestamptz   NOT NULL,
        "opened_at"            timestamptz   NOT NULL,
        "last_seen_at"         timestamptz   NOT NULL,
        "schedule_snapshot"    jsonb,
        "responsible_snapshot" jsonb         NOT NULL DEFAULT '[]',
        "acknowledged_at"      timestamptz,
        "acknowledged_by_id"   uuid,
        "in_progress_at"       timestamptz,
        "resolved_at"          timestamptz,
        "resolved_by_id"       uuid,
        "resolution"           varchar(8),
        "resolution_note"      varchar(2000),
        "closed_at"            timestamptz,
        "closed_by_id"         uuid,
        "close_note"           varchar(2000),
        "escalation_level"     smallint      NOT NULL DEFAULT 0,
        "last_escalated_at"    timestamptz,
        "reopen_count"         integer       NOT NULL DEFAULT 0,
        CONSTRAINT "PK_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_incidents_number" UNIQUE ("number"),
        CONSTRAINT "FK_incidents_boiler" FOREIGN KEY ("boiler_id")
          REFERENCES "boilers"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_incidents_room" FOREIGN KEY ("room_id")
          REFERENCES "rooms"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_device" FOREIGN KEY ("device_id")
          REFERENCES "devices"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_district" FOREIGN KEY ("district_id")
          REFERENCES "districts"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_incidents_agency" FOREIGN KEY ("agency_id")
          REFERENCES "agencies"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_source_alert" FOREIGN KEY ("source_alert_id")
          REFERENCES "alerts"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_ack_user" FOREIGN KEY ("acknowledged_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_resolved_user" FOREIGN KEY ("resolved_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_incidents_closed_user" FOREIGN KEY ("closed_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_incidents_kind" CHECK ("kind" IN
          ('room_low_temperature', 'boiler_low_temperature', 'device_offline',
           'sensor_fault', 'overheat', 'no_circulation')),
        CONSTRAINT "CHK_incidents_severity" CHECK ("severity" IN ('info', 'warning', 'critical')),
        CONSTRAINT "CHK_incidents_status" CHECK ("status" IN
          ('new', 'acknowledged', 'in_progress', 'resolved', 'closed')),
        CONSTRAINT "CHK_incidents_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('auto', 'manual')),
        CONSTRAINT "CHK_incidents_closed" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
        CONSTRAINT "CHK_incidents_escalation" CHECK ("escalation_level" >= 0)
      )
    `);
    /*
     * ⚠️⚠️ DUBLIKAT QO'RIQCHISI — bitta kalit bo'yicha BITTA faol hodisa.
     * Servis ham tekshiradi, lekin bir vaqtda kelgan ikki signal (yoki
     * cron + tezkor yo'l) ikkalasi ham «hodisa yo'q» deb ko'rishi mumkin.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_incidents_active_key" ON "incidents" ("dedupe_key")
        WHERE "status" IN ('new', 'acknowledged', 'in_progress')
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_incidents_status_detected" ON "incidents" ("status", "detected_at" DESC)`,
    );
    for (const column of [
      'boiler_id',
      'organization_id',
      'district_id',
      'agency_id',
    ]) {
      await queryRunner.query(
        `CREATE INDEX "IDX_incidents_${column}" ON "incidents" ("${column}")`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX "IDX_incidents_key_resolved" ON "incidents" ("dedupe_key", "resolved_at" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE "incident_events" (
        "id"          uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"  timestamptz   NOT NULL DEFAULT now(),
        "incident_id" uuid          NOT NULL,
        "type"        varchar(24)   NOT NULL,
        "from_status" varchar(16),
        "to_status"   varchar(16),
        "actor_id"    uuid,
        "actor_label" varchar(200)  NOT NULL,
        "note"        varchar(2000),
        "payload"     jsonb,
        CONSTRAINT "PK_incident_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_incident_events_incident" FOREIGN KEY ("incident_id")
          REFERENCES "incidents"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_incident_events_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_incident_events_incident_time" ON "incident_events" ("incident_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "incident_notifications" (
        "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz   NOT NULL DEFAULT now(),
        "incident_id"     uuid          NOT NULL,
        "user_id"         uuid,
        "recipient_label" varchar(200)  NOT NULL,
        "audience"        varchar(16)   NOT NULL,
        "level"           smallint      NOT NULL DEFAULT 0,
        "read_at"         timestamptz,
        CONSTRAINT "PK_incident_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_incident_notifications_incident" FOREIGN KEY ("incident_id")
          REFERENCES "incidents"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_incident_notifications_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_incident_notifications_audience"
          CHECK ("audience" IN ('responsible', 'district', 'agency', 'region'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_incident_notifications_once"
        ON "incident_notifications" ("incident_id", "user_id", "level")
        WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_incident_notifications_incident_id" ON "incident_notifications" ("incident_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_incident_notifications_user_read" ON "incident_notifications" ("user_id", "read_at")`,
    );

    // ─── 6. Eskalatsiya qoidalari ───
    await queryRunner.query(`
      CREATE TABLE "escalation_rules" (
        "id"            uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"    timestamptz  NOT NULL DEFAULT now(),
        "updated_at"    timestamptz  NOT NULL DEFAULT now(),
        "severity"      varchar(16),
        "level"         smallint     NOT NULL,
        "condition"     varchar(24)  NOT NULL,
        "after_minutes" integer      NOT NULL,
        "target"        varchar(16)  NOT NULL,
        "is_active"     boolean      NOT NULL DEFAULT true,
        CONSTRAINT "PK_escalation_rules" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_escalation_rules_severity"
          CHECK ("severity" IS NULL OR "severity" IN ('info', 'warning', 'critical')),
        CONSTRAINT "CHK_escalation_rules_level" CHECK ("level" BETWEEN 1 AND 9),
        CONSTRAINT "CHK_escalation_rules_condition"
          CHECK ("condition" IN ('not_acknowledged', 'not_resolved')),
        CONSTRAINT "CHK_escalation_rules_minutes" CHECK ("after_minutes" BETWEEN 1 AND 10080),
        CONSTRAINT "CHK_escalation_rules_target" CHECK ("target" IN ('district', 'agency', 'region'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_escalation_rules_level"
        ON "escalation_rules" (COALESCE("severity", '*'), "level")
    `);
    /*
     * ⚠️ Boshlang'ich qoidalar: kritik XAVF 15 daqiqada qabul qilinmasa yoki
     * 2 soatda hal qilinmasa — viloyatga; qolganlari 30 daqiqa / 4 soat.
     */
    await queryRunner.query(`
      INSERT INTO "escalation_rules" ("severity", "level", "condition", "after_minutes", "target") VALUES
        (NULL,       1, 'not_acknowledged', 30,  'region'),
        (NULL,       2, 'not_resolved',     240, 'region'),
        ('critical', 1, 'not_acknowledged', 15,  'region'),
        ('critical', 2, 'not_resolved',     120, 'region')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "escalation_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "incident_notifications"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "incident_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "incidents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "monitoring_holidays"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "monitoring_schedules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "responsible_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "responsible_persons"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_users_agency", DROP COLUMN IF EXISTS "agency_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "FK_organizations_agency", DROP COLUMN IF EXISTS "agency_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agencies"`);

    /*
     * ⚠️ Enum qiymatini olib tashlab bo'lmaydi — tur qayta yaratiladi.
     * Yangi rollardagi hisoblar `viewer` ga TUSHIRILADI va FAOLSIZLANTIRILADI
     * (o'chirilmaydi: audit jurnalida ularning izi bor).
     */
    await queryRunner.query(`
      UPDATE "users" SET "role" = 'viewer', "is_active" = false
       WHERE "role"::text IN ('agency_officer', 'responsible')
    `);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TYPE "users_role_enum" RENAME TO "users_role_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_role_enum" AS ENUM ('super_admin', 'admin', 'operator', 'viewer')`,
    );
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "role" TYPE "users_role_enum"
        USING "role"::text::"users_role_enum"
    `);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'viewer'`,
    );
    await queryRunner.query(`DROP TYPE "users_role_enum_old"`);

    await queryRunner.query(`
      UPDATE "audit_logs" SET "action" = 'update'
       WHERE "action"::text IN ('notify', 'escalate', 'status_change')
    `);
    await queryRunner.query(
      `ALTER TYPE "audit_logs_action_enum" RENAME TO "audit_logs_action_enum_old"`,
    );
    await queryRunner.query(`
      CREATE TYPE "audit_logs_action_enum" AS ENUM
        ('create', 'update', 'delete', 'login', 'login_failed', 'logout', 'export')
    `);
    await queryRunner.query(`
      ALTER TABLE "audit_logs" ALTER COLUMN "action" TYPE "audit_logs_action_enum"
        USING "action"::text::"audit_logs_action_enum"
    `);
    await queryRunner.query(`DROP TYPE "audit_logs_action_enum_old"`);
  }
}
