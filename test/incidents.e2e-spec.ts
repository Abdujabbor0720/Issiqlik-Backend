/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return --
 * ⚠️ supertest javob tanasi (`res.body`) — `any`: e2e test aynan HTTP
 * javobining shaklini tekshiradi.
 */
/**
 * XAVF QATLAMI — E2E (haqiqiy HTTP + alohida baza, `test/e2e-env.ts`).
 *
 *   npm run test:e2e
 *
 * Qamrov: jadval asosida aniqlash, yo'naltirish (tuman + tashkilot +
 * javobgar), `institution_id` ga ishonmaslik, dublikatsizlik, vakolat
 * chegarasi va shaxsiy ma'lumot niqobi, jarayon (NEW → CLOSED), avtomatik
 * bartaraf, qayta ochilish, eskalatsiya, audit, hisobotlar.
 */
import { rmSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { toTashkentMoment } from '../src/helpers/monitoring-window.helper';
import { IncidentEngineService } from '../src/modules/incidents/incident-engine.service';
import { resetE2eDatabase } from './e2e-db';

const TELEMETRY = '/index.php/api/integrations/telemetry';
const API = '/api/v1';

const XONA_ID = 'esp32-xavf000000b1';
const XONA_TOKEN = 'xavf-xona-token-0123456789';
const KOTYOL_ID = 'esp32-xavf000000a1';
const KOTYOL_TOKEN = 'xavf-kotyol-token-0123456789';
const PASSWORD = 'Xavf-Test-Pass-2026!';
const RESPONSIBLE_PHONE = '+998 90 123 45 67';

describe('XAVF — aniqlash, yo‘naltirish, jarayon va eskalatsiya (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let db: DataSource;
  let engine: IncidentEngineService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const districts: Record<string, string> = {};

  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  const xona = (temperature: number, extra: Record<string, unknown> = {}) =>
    http
      .post(TELEMETRY)
      .set({
        'X-Device-Id': XONA_ID,
        'X-Device-Token': XONA_TOKEN,
        'X-Device-Type': 'xona',
      })
      .send({ device_id: XONA_ID, room_temperature_c: temperature, ...extra })
      .expect(201);

  const kotyol = (outlet: number, inlet: number) =>
    http
      .post(TELEMETRY)
      .set({
        'X-Device-Id': KOTYOL_ID,
        'X-Device-Token': KOTYOL_TOKEN,
        'X-Device-Type': 'kotyol',
      })
      .send({
        device_id: KOTYOL_ID,
        outlet_temperature_c: outlet,
        inlet_temperature_c: inlet,
      })
      .expect(201);

  /** Shu obyektdagi XAVF lar (hamma holatda) — admin nomidan. */
  const incidentsOf = async (kind?: string, statuses?: string) => {
    const res = await http
      .get(`${API}/incidents`)
      .query({
        boilerId: ids.boiler,
        limit: 200,
        ...(kind ? { kinds: kind } : {}),
        statuses: statuses ?? 'new,acknowledged,in_progress,resolved,closed',
      })
      .set(as('admin'))
      .expect(200);
    return res.body.data as Array<Record<string, any>>;
  };

  const myNotifications = async (who: string) => {
    const res = await http
      .get(`${API}/incidents/notifications/my`)
      .query({ limit: 200 })
      .set(as(who))
      .expect(200);
    return {
      items: res.body.data as Array<Record<string, any>>,
      unread: res.body.meta.unread as number,
    };
  };

  const login = async (key: string, login: string, password = PASSWORD) => {
    const res = await http
      .post(`${API}/auth/login`)
      .send({ login, password })
      .expect(200);
    tokens[key] = res.body.data.accessToken;
  };

  const createUser = async (key: string, body: Record<string, unknown>) => {
    const res = await http
      .post(`${API}/users`)
      .set(as('admin'))
      .send({ password: PASSWORD, ...body })
      .expect(201);
    ids[`user:${key}`] = res.body.data.id;
    await login(key, body.login as string);
  };

  /** Bugungi kunni (Toshkent) chiqarib tashlagan jadval — «hozir oynadan tashqarida». */
  const outsideWindowSchedule = () => {
    const today = toTashkentMoment(new Date()).weekday;
    return {
      scopeType: 'boiler',
      scopeId: ids.boiler,
      mode: 'schedule',
      activeDays: [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== today),
      heatingStart: '00:00',
      heatingEnd: '00:00',
      monitorStart: '00:00',
      monitorEnd: '00:00',
      minRoomTemperature: 18,
    };
  };

  beforeAll(async () => {
    await resetE2eDatabase();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    const config = app.get(ConfigService);
    configureApp(app, {
      apiPrefix: config.getOrThrow<string>('apiPrefix'),
      corsOrigins: config.getOrThrow<string[]>('corsOrigins'),
      isProd: false,
    });
    await app.init();
    http = request(app.getHttpServer());
    db = app.get(DataSource);
    engine = app.get(IncidentEngineService);

    await login('admin', 'e2e.admin', 'E2e-Admin-Pass-2026!');

    const list = await http
      .get(`${API}/geo/districts`)
      .set(as('admin'))
      .expect(200);
    for (const row of list.body.data as Array<{ id: string; key: string }>) {
      districts[row.key] = row.id;
    }

    // ─── Tashkilot (boshqarma) va muassasa ───
    const agency = await http
      .post(`${API}/catalogs/agencies`)
      .set(as('admin'))
      .send({ name: 'Baliqchi tumani MMTB bo‘limi', districtKey: 'baliqchi' })
      .expect(201);
    ids.agency = agency.body.data.id;

    const types = await http
      .get(`${API}/catalogs/object-types`)
      .query({ limit: 50 })
      .set(as('admin'))
      .expect(200);
    const school = (types.body.data as Array<Record<string, string>>).find(
      (row) => row.code === 'school',
    );

    const organization = await http
      .post(`${API}/catalogs/organizations`)
      .set(as('admin'))
      .send({
        name: '4-sonli maktab',
        districtKey: 'baliqchi',
        objectTypeId: school?.id,
        agencyId: ids.agency,
      })
      .expect(201);
    ids.organization = organization.body.data.id;
    expect(organization.body.data.agencyId).toBe(ids.agency);

    const boiler = await http
      .post(`${API}/boilers`)
      .set(as('admin'))
      .send({
        districtId: districts.baliqchi,
        organizationId: ids.organization,
        lotNumber: 'XAVF-E2E-4',
      })
      .expect(201);
    ids.boiler = boiler.body.data.id;

    const xonaDevice = await http
      .post(`${API}/devices`)
      .set(as('admin'))
      .send({
        deviceId: XONA_ID,
        apiKey: XONA_TOKEN,
        name: 'Xona sensori №2',
        deviceType: 'xona',
        districtId: districts.baliqchi,
        boilerId: ids.boiler,
      })
      .expect(201);
    ids.xona = xonaDevice.body.data.device.id;

    const kotyolDevice = await http
      .post(`${API}/devices`)
      .set(as('admin'))
      .send({
        deviceId: KOTYOL_ID,
        apiKey: KOTYOL_TOKEN,
        deviceType: 'kotyol',
        districtId: districts.baliqchi,
        boilerId: ids.boiler,
      })
      .expect(201);
    ids.kotyol = kotyolDevice.body.data.device.id;

    // ─── Foydalanuvchilar ───
    await createUser('operator', {
      login: 'masul.baliqchi',
      fullName: 'Baliqchi mas‘uli',
      role: 'operator',
      districtId: districts.baliqchi,
    });
    await createUser('otherOperator', {
      login: 'masul.asaka',
      fullName: 'Asaka mas‘uli',
      role: 'operator',
      districtId: districts.asaka,
    });
    await createUser('agency', {
      login: 'mmtb.baliqchi',
      fullName: 'MMTB mas‘uli',
      role: 'agency_officer',
      agencyId: ids.agency,
    });
    await createUser('viewer', {
      login: 'kuzatuvchi',
      fullName: 'Kuzatuvchi',
      role: 'viewer',
    });
    await createUser('responsible', {
      login: 'xojalik.4maktab',
      fullName: 'Karimov Anvar',
      role: 'responsible',
    });

    // ─── Javobgar shaxs va biriktirish ───
    const person = await http
      .post(`${API}/responsibles`)
      .set(as('operator'))
      .send({
        fullName: 'Karimov Anvar Tohirovich',
        position: 'Xo‘jalik ishlari bo‘yicha mas‘ul',
        employer: '4-sonli maktab',
        phone: RESPONSIBLE_PHONE,
        email: 'anvar@maktab4.uz',
        userId: ids['user:responsible'],
      })
      .expect(201);
    ids.person = person.body.data.id;
    // ⚠️ Tuman mas'uli yaratgan shaxs MAJBURAN o'z tumaniga tushadi.
    expect(person.body.data.district.id).toBe(districts.baliqchi);

    await http
      .post(`${API}/responsibles/${ids.person}/assignments`)
      .set(as('operator'))
      .send({
        organizationId: ids.organization,
        responsibilityType: 'facilities',
        isPrimary: true,
      })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(process.env.FIRMWARE_DIR as string, {
      recursive: true,
      force: true,
    });
  });

  // ════════════════════════ Rollar va sozlamalar ════════════════════════

  describe('rollar, tashkilot va jadval qoidalari', () => {
    it('tashkilot mas‘uliga tashkilot majburiy, boshqa rolga — taqiqlangan', async () => {
      await http
        .post(`${API}/users`)
        .set(as('admin'))
        .send({
          login: 'tashkilotsiz',
          password: PASSWORD,
          fullName: 'X',
          role: 'agency_officer',
        })
        .expect(400);
      await http
        .post(`${API}/users`)
        .set(as('admin'))
        .send({
          login: 'operator.tashkilot',
          password: PASSWORD,
          fullName: 'X',
          role: 'operator',
          districtId: districts.asaka,
          agencyId: ids.agency,
        })
        .expect(400);
    });

    it('tashkilot mas‘uli eski (tuman kesimidagi) bo‘limlarga kira olmaydi, tumanlar ro‘yxatini oladi', async () => {
      await http.get(`${API}/boilers`).set(as('agency')).expect(403);
      await http.get(`${API}/alerts`).set(as('agency')).expect(403);
      const list = await http
        .get(`${API}/geo/districts`)
        .set(as('agency'))
        .expect(200);
      expect(list.body.data.length).toBe(16);
    });

    it('jadval validatsiyasi: global nishonsiz, jadval rejimida vaqt majburiy, global o‘chmaydi', async () => {
      await http
        .put(`${API}/monitoring/schedules`)
        .set(as('admin'))
        .send({ scopeType: 'global', scopeId: ids.boiler, mode: 'always' })
        .expect(400);
      await http
        .put(`${API}/monitoring/schedules`)
        .set(as('admin'))
        .send({
          scopeType: 'boiler',
          scopeId: ids.boiler,
          mode: 'schedule',
          activeDays: [1, 2, 3],
        })
        .expect(400);

      const all = await http
        .get(`${API}/monitoring/schedules`)
        .set(as('admin'))
        .expect(200);
      const global = (all.body.data as Array<Record<string, any>>).find(
        (row) => row.scopeType === 'global',
      );
      expect(global).toMatchObject({ mode: 'always' });
      await http
        .delete(`${API}/monitoring/schedules/${global?.id}`)
        .set(as('admin'))
        .expect(400);

      // ⚠️ Migratsiya maktab uchun boshlang'ich jadval yozgan: 07:00 dan.
      const school = (all.body.data as Array<Record<string, any>>).find(
        (row) => row.scopeLabel === 'Obyekt turi: Maktab',
      );
      expect(school).toMatchObject({
        mode: 'schedule',
        monitorStart: '07:00',
      });
    });

    it('jadvalni faqat administrator o‘zgartiradi; tuman mas‘uli faqat ko‘radi', async () => {
      await http
        .put(`${API}/monitoring/schedules`)
        .set(as('operator'))
        .send(outsideWindowSchedule())
        .expect(403);
      await http
        .get(`${API}/monitoring/schedules/effective`)
        .query({ boilerId: ids.boiler })
        .set(as('otherOperator'))
        .expect(403);
      const effective = await http
        .get(`${API}/monitoring/schedules/effective`)
        .query({ boilerId: ids.boiler })
        .set(as('operator'))
        .expect(200);
      expect(effective.body.data.source).toBe('object_type');
    });

    it('bayram kuni takroran qo‘shilmaydi', async () => {
      await http
        .post(`${API}/monitoring/holidays`)
        .set(as('admin'))
        .send({ day: '2027-01-01', name: 'Yangi yil' })
        .expect(409);
    });
  });

  // ════════════════════════ Javobgarlar reyestri ════════════════════════

  describe('javobgar shaxslar reyestri', () => {
    it('boshqa tuman mas‘uli bu tumanga shaxs qo‘sha olmaydi', async () => {
      await http
        .post(`${API}/responsibles`)
        .set(as('otherOperator'))
        .send({
          fullName: 'Begona',
          position: 'Direktor',
          phone: '+998 91 000 00 00',
          districtId: districts.baliqchi,
        })
        .expect(403);
    });

    it('panel hisobi faqat «Obyekt javobgari» rolida bog‘lanadi', async () => {
      await http
        .post(`${API}/responsibles`)
        .set(as('admin'))
        .send({
          fullName: 'Noto‘g‘ri bog‘lanish',
          position: 'Direktor',
          phone: '+998 91 111 11 11',
          userId: ids['user:viewer'],
        })
        .expect(400);
    });

    it('yangi asosiy javobgar eskisini qo‘shimchaga o‘tkazadi (bitta asosiy)', async () => {
      const director = await http
        .post(`${API}/responsibles`)
        .set(as('admin'))
        .send({
          fullName: 'Rahimova Dilnoza',
          position: 'Direktor',
          phone: '+998 93 222 33 44',
          districtId: districts.baliqchi,
        })
        .expect(201);
      ids.director = director.body.data.id;
      await http
        .post(`${API}/responsibles/${ids.director}/assignments`)
        .set(as('admin'))
        .send({
          organizationId: ids.organization,
          responsibilityType: 'director',
          isPrimary: true,
        })
        .expect(201);

      const anvar = await http
        .get(`${API}/responsibles/${ids.person}`)
        .set(as('admin'))
        .expect(200);
      expect(anvar.body.data.assignments[0].isPrimary).toBe(false);

      // Asosiyni qaytarish: Anvar yana asosiy (keyingi testlar shunga tayanadi).
      await http
        .patch(
          `${API}/responsibles/assignments/${anvar.body.data.assignments[0].id}`,
        )
        .set(as('admin'))
        .send({ isPrimary: true })
        .expect(200);
    });

    it('telefon — faqat `responsibles.contacts` bilan; kuzatuvchida niqoblangan', async () => {
      const masked = await http
        .get(`${API}/responsibles/${ids.person}`)
        .set(as('viewer'))
        .expect(200);
      expect(masked.body.data.phone).toBe('+998 ** *** ** 67');
      expect(masked.body.data.contactsMasked).toBe(true);

      const open = await http
        .get(`${API}/responsibles/${ids.person}`)
        .set(as('operator'))
        .expect(200);
      expect(open.body.data.phone).toBe(RESPONSIBLE_PHONE);
    });

    it('niqoblangan telefon qidiruv orqali tiklanmaydi', async () => {
      const viewer = await http
        .get(`${API}/responsibles`)
        .query({ search: '123 45' })
        .set(as('viewer'))
        .expect(200);
      expect(viewer.body.data).toHaveLength(0);
      const operator = await http
        .get(`${API}/responsibles`)
        .query({ search: '123 45' })
        .set(as('operator'))
        .expect(200);
      expect(operator.body.data).toHaveLength(1);
    });

    it('boshqa tumandagi biriktirishlar ko‘rinmaydi (shaxs ko‘rinsa ham)', async () => {
      const asakaOrg = await http
        .post(`${API}/catalogs/organizations`)
        .set(as('admin'))
        .send({ name: '7-sonli maktab', districtKey: 'asaka' })
        .expect(201);
      await http
        .post(`${API}/responsibles/${ids.person}/assignments`)
        .set(as('admin'))
        .send({
          organizationId: asakaOrg.body.data.id,
          responsibilityType: 'heating_technician',
        })
        .expect(201);

      const asaka = await http
        .get(`${API}/responsibles/${ids.person}`)
        .set(as('otherOperator'))
        .expect(200);
      expect(
        asaka.body.data.assignments.map((a: any) => a.organization?.name),
      ).toEqual(['7-sonli maktab']);

      const baliqchi = await http
        .get(`${API}/responsibles/${ids.person}`)
        .set(as('operator'))
        .expect(200);
      expect(
        baliqchi.body.data.assignments.map((a: any) => a.organization?.name),
      ).toEqual(['4-sonli maktab']);
    });

    it('qamrov hisoboti: muassasada asosiy javobgar bor', async () => {
      const res = await http
        .get(`${API}/responsibles/coverage`)
        .set(as('operator'))
        .expect(200);
      expect(res.body.data.missing).toEqual([]);
      expect(res.body.data.withPrimary).toBe(1);
    });
  });

  // ════════════════════════ Jadval asosida aniqlash ════════════════════════

  describe('monitoring vaqtidan tashqarida', () => {
    beforeAll(async () => {
      await http
        .put(`${API}/monitoring/schedules`)
        .set(as('admin'))
        .send(outsideWindowSchedule())
        .expect(200);
    });

    it('sovuq xona — XAVF yaratilmaydi, lekin texnik ogohlantirish (alerts) avvalgidek ochiladi', async () => {
      await xona(12);
      await engine.reconcileNow();
      expect(await incidentsOf('room_low_temperature')).toHaveLength(0);

      const alerts = await http
        .get(`${API}/alerts`)
        .query({ types: 'room_cold' })
        .set(as('admin'))
        .expect(200);
      expect(
        (alerts.body.data as Array<Record<string, any>>).some(
          (row) => row.boiler?.id === ids.boiler,
        ),
      ).toBe(true);
    });

    it('sovuq kotyol (isitish oynasidan tashqarida) — XAVF yaratilmaydi', async () => {
      await kotyol(30, 28);
      await engine.reconcileNow();
      expect(await incidentsOf('boiler_low_temperature')).toHaveLength(0);
    });

    it('muzlash xavfi (≤ 5 °C) — jadvaldan qat‘i nazar XAVF, isisa avtomatik bartaraf', async () => {
      await kotyol(4, 3);
      await engine.reconcileNow();
      const [freeze] = await incidentsOf('boiler_low_temperature');
      expect(freeze).toMatchObject({
        status: 'new',
        severity: 'critical',
        temperature: 4,
      });

      await kotyol(60, 45);
      await engine.reconcileNow();
      const [after] = await incidentsOf('boiler_low_temperature');
      expect(after).toMatchObject({ status: 'resolved', resolution: 'auto' });
    });

    it('ortiqcha qizish — jadvaldan qat‘i nazar XAVF (yashirilmaydi), tiklansa avtomatik bartaraf', async () => {
      await kotyol(97, 80);
      await engine.reconcileNow();
      const [overheat] = await incidentsOf('overheat');
      expect(overheat).toMatchObject({
        status: 'new',
        severity: 'critical',
        threshold: 95,
      });

      await kotyol(60, 45);
      await engine.reconcileNow();
      const [after] = await incidentsOf('overheat');
      expect(after).toMatchObject({ status: 'resolved', resolution: 'auto' });
    });

    it('qurilma uzilishi — jadvaldan qat‘i nazar XAVF, signal kelsa avtomatik bartaraf', async () => {
      await db.query(
        `UPDATE devices SET last_seen_at = now() - interval '2 hours' WHERE id = $1`,
        [ids.kotyol],
      );
      await engine.reconcileNow();
      const [offline] = await incidentsOf('device_offline');
      expect(offline).toMatchObject({
        status: 'new',
        severity: 'critical',
        device: { id: ids.kotyol },
      });

      await kotyol(61, 45);
      await engine.reconcileNow();
      const [after] = await incidentsOf('device_offline');
      expect(after.status).toBe('resolved');
    });
  });

  // ════════════════════════ Yaratish va yo'naltirish ════════════════════════

  describe('monitoring vaqtida: yaratish va yo‘naltirish', () => {
    let incident: Record<string, any>;

    beforeAll(async () => {
      await http
        .put(`${API}/monitoring/schedules`)
        .set(as('admin'))
        .send({
          scopeType: 'boiler',
          scopeId: ids.boiler,
          mode: 'always',
          minRoomTemperature: 18,
        })
        .expect(200);
      // ⚠️ Qurilma boshqa muassasani «aytadi» — XAVF baribir server biriktirgan obyektga.
      await xona(15.4, {
        institution_id: 'maktab-99',
        institution_name: 'Begona maktab',
      });
      await engine.reconcileNow();
      [incident] = await incidentsOf('room_low_temperature');
    });

    it('obyekt minimumi (18 °C) bo‘yicha — umumiy 15 °C dan yuqori bo‘lsa ham XAVF', () => {
      expect(incident).toMatchObject({
        status: 'new',
        statusLabel: 'Yangi xavf',
        severity: 'warning',
        threshold: 18,
        temperature: 15.4,
        currentTemperature: 15.4,
        // ⚠️ 12 °C jadvaldan TASHQARIDA o'lchangan — XAVF tarixiga kirmaydi.
        extremeTemperature: 15.4,
      });
      expect(incident.title).toContain('HARORAT ME‘YORDAN PAST');
    });

    it('karta: tuman, muassasa, qurilma, jadval, javobgar (F.I.Sh., lavozim, telefon)', async () => {
      const res = await http
        .get(`${API}/incidents/${incident.id}`)
        .set(as('operator'))
        .expect(200);
      const card = res.body.data;
      expect(card).toMatchObject({
        district: { id: districts.baliqchi },
        organization: { id: ids.organization, name: '4-sonli maktab' },
        agency: { id: ids.agency },
        device: { id: ids.xona, label: 'Xona sensori №2' },
        schedule: { mode: 'always', minRoomTemperature: 18 },
        primaryResponsible: {
          fullName: 'Karimov Anvar Tohirovich',
          position: 'Xo‘jalik ishlari bo‘yicha mas‘ul',
          phone: RESPONSIBLE_PHONE,
          isPrimary: true,
        },
      });
      expect(card.responsibles).toHaveLength(2);
      expect(card.timeline.map((e: any) => e.type)).toEqual(
        expect.arrayContaining(['created', 'notified']),
      );
    });

    it('institution_id ga ishonilmaydi: XAVF qurilma biriktirilgan muassasada', () => {
      expect(incident.organization.name).toBe('4-sonli maktab');
    });

    it('ogohlantirish: tuman mas‘uli, tashkilot mas‘uli va javobgar hisobiga — boshqa tumanga emas', async () => {
      for (const who of ['operator', 'agency', 'responsible']) {
        const { items } = await myNotifications(who);
        expect(
          items.filter((row) => row.incidentId === incident.id),
        ).toHaveLength(1);
      }
      const other = await myNotifications('otherOperator');
      expect(other.items).toHaveLength(0);
    });

    it('bir vaqtda kelgan telemetriya va parallel baholash — dublikat yo‘q', async () => {
      const raw = engine as unknown as {
        reconcile: (input: { now: Date }) => Promise<unknown>;
      };
      await Promise.all([
        ...Array.from({ length: 5 }, () => xona(15.1)),
        ...Array.from({ length: 5 }, () => raw.reconcile({ now: new Date() })),
        engine.reconcileNow(),
      ]);
      const active = await incidentsOf(
        'room_low_temperature',
        'new,acknowledged,in_progress',
      );
      expect(active).toHaveLength(1);
      const { items } = await myNotifications('operator');
      expect(
        items.filter((row) => row.incidentId === incident.id),
      ).toHaveLength(1);
    });
  });

  // ════════════════════════ Vakolat ════════════════════════

  describe('vakolat chegarasi', () => {
    let incidentId: string;

    beforeAll(async () => {
      [{ id: incidentId }] = await incidentsOf(
        'room_low_temperature',
        'new,acknowledged,in_progress',
      );
    });

    it('boshqa tuman mas‘uli ko‘rmaydi (ro‘yxatda yo‘q, karta — 404)', async () => {
      const list = await http
        .get(`${API}/incidents`)
        .set(as('otherOperator'))
        .expect(200);
      expect(list.body.data).toHaveLength(0);
      await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('otherOperator'))
        .expect(404);
      await http
        .post(`${API}/incidents/${incidentId}/acknowledge`)
        .set(as('otherOperator'))
        .send({})
        .expect(404);
    });

    it('tashkilot mas‘uli o‘z idorasining XAVF ini ko‘radi, tumanlar kesimi bilan', async () => {
      await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('agency'))
        .expect(200);
      const summary = await http
        .get(`${API}/incidents/summary`)
        .set(as('agency'))
        .expect(200);
      expect(summary.body.data.scope).toBe('agency');
      expect(summary.body.data.active).toBeGreaterThanOrEqual(1);
      expect(summary.body.data.byDistrict[0].districtId).toBe(
        districts.baliqchi,
      );
    });

    it('qabul qiluvchilar ismi/logini — faqat rahbarlarga; javobgarga faqat daraja va holat', async () => {
      const responsible = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('responsible'))
        .expect(200);
      expect(responsible.body.data.notifications.length).toBeGreaterThan(0);
      expect(
        responsible.body.data.notifications.every(
          (n: any) => n.recipient === null,
        ),
      ).toBe(true);
      const notified = responsible.body.data.timeline.find(
        (e: any) => e.type === 'notified',
      );
      expect(notified.payload.recipients).toBeUndefined();

      const operator = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('operator'))
        .expect(200);
      expect(operator.body.data.notifications[0].recipient).toEqual(
        expect.any(String),
      );
    });

    it('kuzatuvchi ko‘radi, lekin javobgar telefoni niqoblangan va amal qila olmaydi', async () => {
      const res = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('viewer'))
        .expect(200);
      expect(res.body.data.primaryResponsible.phone).toBe('+998 ** *** ** 67');
      expect(res.body.data.primaryResponsible.contactsMasked).toBe(true);
      await http
        .post(`${API}/incidents/${incidentId}/acknowledge`)
        .set(as('viewer'))
        .send({})
        .expect(403);
    });

    it('boshqa tuman mas‘uli uchun dashboard bo‘sh', async () => {
      const res = await http
        .get(`${API}/incidents/summary`)
        .set(as('otherOperator'))
        .expect(200);
      expect(res.body.data.active).toBe(0);
    });
  });

  // ════════════════════════ Jarayon ════════════════════════

  describe('jarayon: NEW → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED', () => {
    let incidentId: string;
    let incidentNumber: number;

    beforeAll(async () => {
      [{ id: incidentId, number: incidentNumber }] = await incidentsOf(
        'room_low_temperature',
        'new,acknowledged,in_progress',
      );
    });

    it('javobgar qabul qiladi; ikkinchi marta qabul — 409', async () => {
      const res = await http
        .post(`${API}/incidents/${incidentId}/acknowledge`)
        .set(as('responsible'))
        .send({ note: 'Ko‘rdim, boryapman' })
        .expect(200);
      expect(res.body.data.status).toBe('acknowledged');
      await http
        .post(`${API}/incidents/${incidentId}/acknowledge`)
        .set(as('responsible'))
        .send({})
        .expect(409);
    });

    it('chora — izohsiz rad etiladi, izoh bilan IN_PROGRESS', async () => {
      await http
        .post(`${API}/incidents/${incidentId}/start`)
        .set(as('responsible'))
        .send({})
        .expect(400);
      const res = await http
        .post(`${API}/incidents/${incidentId}/start`)
        .set(as('responsible'))
        .send({ note: 'Radiator ventili tekshirilmoqda' })
        .expect(200);
      expect(res.body.data.status).toBe('in_progress');
    });

    it('bajarilgan ish tarixga yoziladi', async () => {
      const res = await http
        .post(`${API}/incidents/${incidentId}/comments`)
        .set(as('responsible'))
        .send({ kind: 'action', note: 'Havo tiqini chiqarildi' })
        .expect(201);
      expect(
        res.body.data.timeline.some(
          (e: any) =>
            e.type === 'action' && e.note === 'Havo tiqini chiqarildi',
        ),
      ).toBe(true);
    });

    it('javobgar «bartaraf etildi» deydi, lekin YOPA OLMAYDI', async () => {
      const res = await http
        .post(`${API}/incidents/${incidentId}/resolve`)
        .set(as('responsible'))
        .send({ note: 'Ventil almashtirildi' })
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'resolved',
        resolution: 'manual',
        resolutionNote: 'Ventil almashtirildi',
      });
      await http
        .post(`${API}/incidents/${incidentId}/close`)
        .set(as('responsible'))
        .send({})
        .expect(403);
    });

    it('tuman mas‘uli tekshiruvdan o‘tkazmaydi — qayta ochadi, keyin yopadi', async () => {
      const reopened = await http
        .post(`${API}/incidents/${incidentId}/reopen`)
        .set(as('operator'))
        .send({ note: 'Xona hali sovuq' })
        .expect(200);
      expect(reopened.body.data.status).toBe('in_progress');

      await http
        .post(`${API}/incidents/${incidentId}/resolve`)
        .set(as('operator'))
        .send({ note: 'Qozonxona nasosi yoqildi' })
        .expect(200);
      const closed = await http
        .post(`${API}/incidents/${incidentId}/close`)
        .set(as('operator'))
        .send({ note: 'Joyida tekshirildi' })
        .expect(200);
      expect(closed.body.data.status).toBe('closed');
      await http
        .post(`${API}/incidents/${incidentId}/close`)
        .set(as('operator'))
        .send({})
        .expect(409);
      await http
        .post(`${API}/incidents/${incidentId}/comments`)
        .set(as('operator'))
        .send({ note: 'Kech izoh' })
        .expect(409);
    });

    it('hodisani o‘chirib bo‘lmaydi (endpoint yo‘q), tarix saqlangan', async () => {
      await http
        .delete(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(404);
      const res = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      const types = res.body.data.timeline.map((e: any) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'created',
          'notified',
          'status_changed',
          'action',
        ]),
      );
    });

    it('audit jurnali: yaratish, yuborish va holat o‘zgarishlari', async () => {
      const rows = await db.query<Array<{ action: string }>>(
        `SELECT DISTINCT action::text FROM audit_logs
          WHERE entity_name = 'Incident' AND entity_id = $1`,
        [incidentId],
      );
      expect(rows.map((row) => row.action)).toEqual(
        expect.arrayContaining(['create', 'notify', 'status_change']),
      );
    });

    it('yopilgan hodisa — yakuniy: muammo davom etsa YANGI XAVF ochiladi', async () => {
      await engine.reconcileNow();
      const active = await incidentsOf(
        'room_low_temperature',
        'new,acknowledged,in_progress',
      );
      expect(active).toHaveLength(1);
      expect(active[0].number).toBeGreaterThan(incidentNumber);
    });
  });

  // ════════════════════════ Avtomatik bartaraf va qayta ochilish ════════════════════════

  describe('harorat tiklanishi, sakrash va eskalatsiya', () => {
    let incidentId: string;

    beforeAll(async () => {
      [{ id: incidentId }] = await incidentsOf(
        'room_low_temperature',
        'new,acknowledged,in_progress',
      );
    });

    it('harorat me‘yorga qaytdi — avtomatik RESOLVED (yopilmaydi), tarix saqlanadi', async () => {
      await xona(19);
      await engine.reconcileNow();
      const res = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'resolved',
        resolution: 'auto',
      });
      expect(res.body.data.resolutionNote).toContain('me‘yorga qaytdi');
      expect(res.body.data.timeline.map((e: any) => e.type)).toContain(
        'auto_resolved',
      );
    });

    it('tez qaytgan sovuq — o‘sha hodisa QAYTA OCHILADI, yangi xabar yuborilmaydi', async () => {
      const before = await myNotifications('operator');
      await xona(17);
      await engine.reconcileNow();
      const res = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      expect(res.body.data).toMatchObject({ status: 'new', reopenCount: 1 });
      const after = await myNotifications('operator');
      expect(after.items.length).toBe(before.items.length);
    });

    it('gisterezis: 18.2 °C (minimum 18 + 0.5 dan past) — hodisa yopilmaydi', async () => {
      await xona(18.2);
      await engine.reconcileNow();
      const res = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      expect(res.body.data.status).toBe('new');
    });

    it('eskalatsiya: 30 daqiqada qabul qilinmadi → viloyat; har daraja bir marta', async () => {
      const minutes = (n: number) => new Date(Date.now() + n * 60_000);

      expect(await engine.escalateNow(minutes(29))).toBe(0);
      expect(await engine.escalateNow(minutes(31))).toBeGreaterThanOrEqual(1);
      // ⚠️ Takror — hech narsa (daraja faqat o'sadi).
      await engine.escalateNow(minutes(31));

      const admin = await myNotifications('admin');
      const escalations = admin.items.filter(
        (row) => row.incidentId === incidentId,
      );
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({ level: 1, audience: 'region' });

      await engine.escalateNow(minutes(241));
      const card = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      expect(card.body.data.escalationLevel).toBe(2);
      expect(card.body.data.escalations).toHaveLength(2);

      const escalated = await http
        .get(`${API}/incidents`)
        .query({ escalated: true })
        .set(as('admin'))
        .expect(200);
      expect(
        (escalated.body.data as Array<Record<string, any>>).some(
          (row) => row.id === incidentId,
        ),
      ).toBe(true);
    });

    it('eskalatsiya qoidalari: takror daraja va javobgarga «ko‘tarish» rad etiladi; faqat ruxsat egasi', async () => {
      const rule = {
        level: 1,
        condition: 'not_acknowledged',
        afterMinutes: 10,
        target: 'region',
      };
      await http
        .put(`${API}/incidents/escalation-rules`)
        .set(as('admin'))
        .send({ rules: [rule, rule] })
        .expect(400);
      await http
        .put(`${API}/incidents/escalation-rules`)
        .set(as('admin'))
        .send({ rules: [{ ...rule, target: 'responsible' }] })
        .expect(400);
      await http
        .put(`${API}/incidents/escalation-rules`)
        .set(as('operator'))
        .send({ rules: [rule] })
        .expect(403);
    });

    it('o‘qilgan deb belgilash — o‘qilmaganlar soni kamayadi', async () => {
      const before = await myNotifications('operator');
      expect(before.unread).toBeGreaterThan(0);
      await http
        .post(`${API}/incidents/notifications/read-all`)
        .set(as('operator'))
        .expect(200);
      const after = await myNotifications('operator');
      expect(after.unread).toBe(0);
    });
  });

  // ════════════════════════ Hisobotlar ════════════════════════

  describe('kech biriktirilgan tashkilot va yo‘qolgan xabar', () => {
    const K2_ID = 'esp32-xavf000000c3';
    const K2_TOKEN = 'xavf-kotyol2-token-0123456789';
    let incidentId: string;
    let orgId: string;

    beforeAll(async () => {
      const org = await http
        .post(`${API}/catalogs/organizations`)
        .set(as('admin'))
        .send({ name: '15-sonli bog‘cha', districtKey: 'baliqchi' })
        .expect(201);
      orgId = org.body.data.id;
      const boiler = await http
        .post(`${API}/boilers`)
        .set(as('admin'))
        .send({
          districtId: districts.baliqchi,
          organizationId: orgId,
          lotNumber: 'XAVF-E2E-15',
        })
        .expect(201);
      ids.boiler2 = boiler.body.data.id;
      await http
        .post(`${API}/devices`)
        .set(as('admin'))
        .send({
          deviceId: K2_ID,
          apiKey: K2_TOKEN,
          deviceType: 'kotyol',
          districtId: districts.baliqchi,
          boilerId: ids.boiler2,
        })
        .expect(201);
      await http
        .post(TELEMETRY)
        .set({ 'X-Device-Id': K2_ID, 'X-Device-Token': K2_TOKEN })
        .send({
          device_id: K2_ID,
          outlet_temperature_c: 97,
          inlet_temperature_c: 80,
        })
        .expect(201);
      await engine.reconcileNow();
      const res = await http
        .get(`${API}/incidents`)
        .query({ boilerId: ids.boiler2, kinds: 'overheat' })
        .set(as('admin'))
        .expect(200);
      incidentId = res.body.data[0].id;
    });

    it('tashkilotsiz muassasa: tashkilot mas‘uli ko‘rmaydi, bo‘shliq tarixda yozilgan', async () => {
      await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('agency'))
        .expect(404);
      const card = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('admin'))
        .expect(200);
      const notified = card.body.data.timeline.find(
        (e: any) => e.type === 'notified',
      );
      expect(notified.payload.gaps).toEqual(
        expect.arrayContaining([
          'muassasa hech qaysi tashkilot/boshqarmaga biriktirilmagan',
        ]),
      );
    });

    it('muassasa keyin tashkilotga biriktirilsa — FAOL hodisa ham unga yetib boradi', async () => {
      await http
        .patch(`${API}/catalogs/organizations/${orgId}`)
        .set(as('admin'))
        .send({ agencyId: ids.agency })
        .expect(200);
      await engine.reconcileNow();
      const card = await http
        .get(`${API}/incidents/${incidentId}`)
        .set(as('agency'))
        .expect(200);
      expect(card.body.data.agency.id).toBe(ids.agency);
      const { items } = await myNotifications('agency');
      expect(items.some((row) => row.incidentId === incidentId)).toBe(true);
    });

    it('xabar yuborilmay qolgan faol hodisa — qayta yuboriladi (takrorsiz)', async () => {
      // Jarayon xabar yuborishdan OLDIN to'xtagan holatni taqlid qilish (faqat e2e bazasi).
      await db.query(
        `DELETE FROM incident_notifications WHERE incident_id = $1`,
        [incidentId],
      );
      await db.query(
        `DELETE FROM incident_events WHERE incident_id = $1 AND type = 'notified'`,
        [incidentId],
      );
      await db.query(
        `UPDATE incidents SET created_at = now() - interval '5 minutes' WHERE id = $1`,
        [incidentId],
      );
      await engine.reconcileNow();
      await engine.reconcileNow();
      const { items } = await myNotifications('operator');
      expect(items.filter((row) => row.incidentId === incidentId)).toHaveLength(
        1,
      );
    });
  });

  describe('nazoratdan chiqarilgan xonaning moduli', () => {
    it('uzilgan xona moduli XAVF i, xona nazoratdan chiqarilsa avtomatik yopiladi', async () => {
      await db.query(
        `UPDATE devices SET last_seen_at = now() - interval '2 hours' WHERE id = $1`,
        [ids.xona],
      );
      await engine.reconcileNow();
      const [offline] = await incidentsOf(
        'device_offline',
        'new,acknowledged,in_progress',
      );
      expect(offline).toMatchObject({
        severity: 'warning',
        device: { id: ids.xona },
      });
      expect(offline.room).not.toBeNull();

      await db.query(`UPDATE rooms SET is_monitored = false WHERE id = $1`, [
        offline.room.id,
      ]);
      await engine.reconcileNow();
      const card = await http
        .get(`${API}/incidents/${offline.id}`)
        .set(as('admin'))
        .expect(200);
      expect(card.body.data).toMatchObject({
        status: 'resolved',
        resolution: 'auto',
        resolutionNote: 'Xona nazoratdan chiqarildi',
      });
    });
  });

  describe('hisobotlar', () => {
    it('takrorlanayotgan muammo: bir xonada ikki hodisa + qayta ochilish', async () => {
      const res = await http
        .get(`${API}/incidents/recurring`)
        .query({ days: 1, minCount: 2 })
        .set(as('operator'))
        .expect(200);
      const row = (res.body.data as Array<Record<string, any>>).find(
        (item) => item.kind === 'room_low_temperature',
      );
      expect(row).toMatchObject({
        incidents: 2,
        reopens: 1,
        occurrences: 3,
        organizationName: '4-sonli maktab',
      });
    });

    it('davr hisoboti tuman kesimida', async () => {
      const res = await http
        .get(`${API}/incidents/report`)
        .query({ groupBy: 'district' })
        .set(as('admin'))
        .expect(200);
      const baliqchi = (res.body.data.rows as Array<Record<string, any>>).find(
        (row) => row.key === districts.baliqchi,
      );
      expect(baliqchi?.total).toBeGreaterThanOrEqual(4);
      expect(baliqchi?.closed).toBeGreaterThanOrEqual(1);
      expect(baliqchi?.escalated).toBeGreaterThanOrEqual(1);
    });
  });
});
