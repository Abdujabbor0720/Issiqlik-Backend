/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions --
 * ⚠️ supertest javob tanasi (`res.body`) — `any`: e2e test aynan HTTP
 * javobining shaklini tekshiradi, uni oldindan turlab qo'yish testni
 * ma'nosiz qilardi.
 */
/**
 * VILOYAT DARAJASI VA YANGI PROSHIVKALAR (kotyol v2.1.0, xona v1.1.0) — E2E.
 *
 * Spetsifikatsiyadagi «Avtomatik testlar» ro'yxati, haqiqiy HTTP orqali,
 * alohida bazada (`test/e2e-env.ts`): sxema har ishga tushishda noldan
 * migratsiyalar bilan yaratiladi.
 *
 *   npm run test:e2e
 */
import { rmSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppDataSource } from '../src/config/data-source';

const TELEMETRY = '/index.php/api/integrations/telemetry';
const OTA = '/ota/index.php';

const KOTYOL_ID = 'esp32-e2e0000000a1';
const KOTYOL_TOKEN = 'e2e-kotyol-token-0123456789';
const XONA_ID = 'esp32-e2e0000000b2';
const XONA_TOKEN = 'e2e-xona-token-0123456789';

/** ESP32 obraziga o'xshash `.bin`: 0xE9 + baytlar + `.rodata` dagi belgilar. */
function fakeFirmware(version: string, module: 'kotyol' | 'xona'): Buffer {
  return Buffer.concat([
    Buffer.from([0xe9, 0x03, 0x02, 0x20]),
    Buffer.alloc(2048, 0x5a),
    Buffer.from(`\0ANDIJON_FW_VERSION=${version};\0`, 'latin1'),
    Buffer.from(`\0ANDIJON_FW_MODULE=${module};\0`, 'latin1'),
    Buffer.alloc(1024, 0x11),
  ]);
}

/** Bazani noldan tayyorlash: yo'q bo'lsa yaratiladi, sxema tozalanadi. */
async function resetDatabase(): Promise<void> {
  const name = process.env.DB_NAME as string;
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !name.includes('e2e')) {
    throw new Error(
      `Xavfsizlik: e2e bazasi nomi «e2e» ni o'z ichiga olishi kerak (${name})`,
    );
  }
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  await AppDataSource.initialize();
  await AppDataSource.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  );
  await AppDataSource.runMigrations();
  await AppDataSource.destroy();
}

describe('Andijon viloyati — qurilma kontrakti va viloyat tuzilmasi (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let adminToken: string;
  const districts: Record<string, string> = {};
  let kotyolUuid: string;
  let xonaUuid: string;

  const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
  const telemetry = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    http
      .post(TELEMETRY)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(body);

  beforeAll(async () => {
    await resetDatabase();

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

    const login = await http
      .post('/api/v1/auth/login')
      .send({ login: 'e2e.admin', password: 'E2e-Admin-Pass-2026!' })
      .expect(200);
    adminToken = login.body.data.accessToken;

    const list = await http
      .get('/api/v1/geo/districts')
      .set(auth())
      .expect(200);
    for (const row of list.body.data as Array<{ id: string; key: string }>) {
      districts[row.key] = row.id;
    }

    const kotyol = await http
      .post('/api/v1/devices')
      .set(auth())
      .send({
        deviceId: KOTYOL_ID,
        apiKey: KOTYOL_TOKEN,
        deviceType: 'kotyol',
        districtId: districts.asaka,
      })
      .expect(201);
    kotyolUuid = kotyol.body.data.device.id;

    const xona = await http
      .post('/api/v1/devices')
      .set(auth())
      .send({
        deviceId: XONA_ID,
        apiKey: XONA_TOKEN,
        deviceType: 'xona',
        districtId: districts.asaka,
      })
      .expect(201);
    xonaUuid = xona.body.data.device.id;
  });

  afterAll(async () => {
    await app?.close();
    rmSync(process.env.FIRMWARE_DIR as string, {
      recursive: true,
      force: true,
    });
  });

  it('MFY katalogi andijon-tumanlar-mfylar.json dan: 878 ta, tuman kalitlariga moslangan', async () => {
    const all = await http
      .get('/api/v1/catalogs/mahallas?limit=1')
      .set(auth())
      .expect(200);
    expect(all.body.meta.total).toBe(878);

    const expected: Record<string, number> = {
      'andijon-sh': 91,
      'xonobod-sh': 15,
      boz: 25,
      asaka: 76,
      qorgontepa: 61,
    };
    for (const [key, count] of Object.entries(expected)) {
      const res = await http
        .get(`/api/v1/catalogs/mahallas?districtKey=${key}&limit=1`)
        .set(auth())
        .expect(200);
      expect(res.body.meta.total).toBe(count);
    }
  });

  it('tumanlar katalogi: 16 ta kalit proshivkadagi bilan aynan bir xil', () => {
    expect(Object.keys(districts).sort()).toEqual(
      [
        'andijon-sh',
        'xonobod-sh',
        'andijon',
        'asaka',
        'baliqchi',
        'boz',
        'buloqboshi',
        'izboskan',
        'jalaquduq',
        'xojaobod',
        'qorgontepa',
        'marhamat',
        'oltinkol',
        'paxtaobod',
        'shahrixon',
        'ulugnor',
      ].sort(),
    );
  });

  it('tokensiz so‘rov — 401', async () => {
    await telemetry(
      { device_id: KOTYOL_ID, temperature_c: 60 },
      { 'X-Device-Id': KOTYOL_ID },
    ).expect(401);
  });

  it('noto‘g‘ri token — 401', async () => {
    await telemetry(
      { device_id: KOTYOL_ID, temperature_c: 60 },
      { 'X-Device-Id': KOTYOL_ID, 'X-Device-Token': 'xato-token' },
    ).expect(401);
  });

  it('begona device_id — 403 va «Yangi qurilmalar» ro‘yxatida paydo bo‘ladi', async () => {
    const stranger = 'esp32-e2e0000000ff';
    await telemetry(
      {
        device_id: stranger,
        district: 'boz',
        object_type: 'kindergarten',
        institution_name: "Bo'ston 3-bog'cha",
        room_temperature_c: 20.5,
      },
      {
        'X-Device-Id': stranger,
        'X-Device-Token': 'begona-token-123456',
        'X-Firmware-Version': '1.1.0',
      },
    ).expect(403);

    const pending = await http
      .get('/api/v1/devices/pending')
      .set(auth())
      .expect(200);
    const row = (pending.body.data as Array<Record<string, any>>).find(
      (item) => item.deviceId === stranger,
    );
    expect(row).toMatchObject({
      deviceType: 'xona',
      district: { key: 'boz' },
      objectType: { code: 'kindergarten' },
      institutionName: "Bo'ston 3-bog'cha",
      firmwareVersion: '1.1.0',
      tokenKind: 'personal',
    });
    expect(row?.lastIpAddress).toBeTruthy();
    expect(row?.lastSeenAt).toBeTruthy();

    // ⚠️ Bir bosishda ro'yxatga olish: qurilmaning o'z tokeni qabul qilinadi.
    const registered = await http
      .post(`/api/v1/devices/pending/${row?.id}/register`)
      .set(auth())
      .send({})
      .expect(201);
    expect(registered.body.data.tokenSource).toBe('adopted');
    expect(registered.body.data.device.location).toMatchObject({
      district: { key: 'boz' },
      objectType: { code: 'kindergarten' },
      institution: { name: "Bo'ston 3-bog'cha" },
    });
    await telemetry(
      { device_id: stranger, room_temperature_c: 20.5 },
      { 'X-Device-Id': stranger, 'X-Device-Token': 'begona-token-123456' },
    ).expect(201);
  });

  it('§7 curl: yakka probe, noma‘lum maydon, X-Device-Type — 201', async () => {
    const res = await telemetry(
      {
        device_id: KOTYOL_ID,
        district: 'asaka',
        object_type: 'school',
        institution_name: '12-maktab',
        temperature_c: 60.5,
        probe: 'outlet',
        extra: 1,
      },
      {
        'X-Device-Token': KOTYOL_TOKEN,
        'X-Device-Id': KOTYOL_ID,
        'X-Firmware-Version': '2.1.0',
        'X-Device-Type': 'kotyol',
      },
    ).expect(201);
    expect(res.body).toMatchObject({ ok: true, probe: 'outlet' });
  });

  it('noma‘lum tuman yoki obyekt turi kaliti — 201 (maydon e‘tiborsiz)', async () => {
    await telemetry(
      {
        device_id: KOTYOL_ID,
        district: 'toshkent-sh',
        object_type: 'zavod',
        institution_name: '12-maktab',
        inlet_temperature_c: 45.12,
        outlet_temperature_c: 60.5,
        nested: { anything: [1, 2, 3] },
      },
      { 'X-Device-Token': KOTYOL_TOKEN, 'X-Device-Id': KOTYOL_ID },
    ).expect(201);

    const device = await http
      .get(`/api/v1/devices/${kotyolUuid}`)
      .set(auth())
      .expect(200);
    expect(device.body.data.reported.district).toBe('asaka');
    expect(device.body.data.reported.objectType).toBe('school');
  });

  it('eski format (institution_id, X-Device-Type siz) — 201', async () => {
    await telemetry(
      {
        institution_id: 'maktab-4',
        device_id: KOTYOL_ID,
        inlet_temperature_c: 44,
        outlet_temperature_c: 59,
      },
      { 'X-Device-Token': KOTYOL_TOKEN, 'X-Device-Id': KOTYOL_ID },
    ).expect(201);

    // Prefikssiz manzil ham ishlaydi.
    await http
      .post('/api/integrations/telemetry')
      .set({ 'X-Device-Token': KOTYOL_TOKEN, 'X-Device-Id': KOTYOL_ID })
      .send({ device_id: KOTYOL_ID, temperature_c: 58.2 })
      .expect(201);
  });

  it('measured_at e‘tiborsiz — o‘lchov server vaqti bilan yoziladi', async () => {
    const before = Date.now();
    await telemetry(
      {
        device_id: XONA_ID,
        room_temperature_c: 22,
        measured_at: '2001-01-01T00:00:00Z',
      },
      {
        'X-Device-Token': XONA_TOKEN,
        'X-Device-Id': XONA_ID,
        'X-Device-Type': 'xona',
      },
    ).expect(201);
    const series = await http
      .get(`/api/v1/telemetry/devices/${xonaUuid}/series?bucket=raw`)
      .set(auth())
      .expect(200);
    const last = series.body.data.points.at(-1);
    expect(new Date(last.t).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(last.room).toBe(22);
  });

  it('noto‘g‘ri harorat — 422 (kotyol -55…125, xona -40…80)', async () => {
    const kotyolHeaders = {
      'X-Device-Token': KOTYOL_TOKEN,
      'X-Device-Id': KOTYOL_ID,
    };
    await telemetry(
      { device_id: KOTYOL_ID, outlet_temperature_c: 125.5 },
      kotyolHeaders,
    ).expect(422);
    await telemetry(
      { device_id: KOTYOL_ID, temperature_c: -127, probe: 'inlet' },
      kotyolHeaders,
    ).expect(422);
    await telemetry({ device_id: KOTYOL_ID }, kotyolHeaders).expect(422);

    const xonaHeaders = {
      'X-Device-Token': XONA_TOKEN,
      'X-Device-Id': XONA_ID,
    };
    await telemetry(
      { device_id: XONA_ID, room_temperature_c: 85 },
      xonaHeaders,
    ).expect(422);
    await telemetry(
      { device_id: XONA_ID, room_temperature_c: -41 },
      xonaHeaders,
    ).expect(422);
    await telemetry(
      { device_id: XONA_ID, room_temperature_c: 80 },
      xonaHeaders,
    ).expect(201);
  });

  it('namlik qabul qilinadi va saqlanadi (0…100 %)', async () => {
    await telemetry(
      { device_id: XONA_ID, room_temperature_c: 21.4, humidity: 45.0 },
      {
        'X-Device-Token': XONA_TOKEN,
        'X-Device-Id': XONA_ID,
        'X-Device-Type': 'xona',
      },
    ).expect(201);
    const device = await http
      .get(`/api/v1/devices/${xonaUuid}`)
      .set(auth())
      .expect(200);
    expect(device.body.data.lastHumidity).toBe(45);
  });

  it('yakka probe o‘lchovi grafikda tegishli chiziqqa tushadi', async () => {
    await telemetry(
      { device_id: KOTYOL_ID, temperature_c: 41.5, probe: 'inlet' },
      { 'X-Device-Token': KOTYOL_TOKEN, 'X-Device-Id': KOTYOL_ID },
    ).expect(201);
    const series = await http
      .get(`/api/v1/telemetry/devices/${kotyolUuid}/series?bucket=raw`)
      .set(auth())
      .expect(200);
    expect(series.body.data.deviceType).toBe('kotyol');
    const last = series.body.data.points.at(-1);
    expect(last).toMatchObject({ inlet: 41.5, outlet: null });
    expect(series.body.data.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inlet: null, outlet: 60.5 }),
      ]),
    );
  });

  it('ANDIJON_FW_VERSION va ANDIJON_FW_MODULE belgili .bin — tur va versiya to‘g‘ri aniqlanadi', async () => {
    const kotyol = await http
      .post('/api/v1/firmware/releases')
      .set(auth())
      .attach('file', fakeFirmware('2.1.1', 'kotyol'), 'kotyol.bin')
      .expect(201);
    expect(kotyol.body.data).toMatchObject({
      version: '2.1.1',
      deviceType: 'kotyol',
      typeSource: 'marker',
      markerPrefix: 'ANDIJON',
    });
    expect(kotyol.body.data.sha256).toMatch(/^[0-9a-f]{64}$/);

    const xona = await http
      .post('/api/v1/firmware/releases')
      .set(auth())
      .attach('file', fakeFirmware('1.1.1', 'xona'), 'xona.bin')
      .expect(201);
    expect(xona.body.data).toMatchObject({
      version: '1.1.1',
      deviceType: 'xona',
    });

    // ⚠️ Bitta (tur, versiya) ikki marta yuklanmaydi.
    await http
      .post('/api/v1/firmware/releases')
      .set(auth())
      .attach('file', fakeFirmware('2.1.1', 'kotyol'), 'again.bin')
      .expect(409);
    // ⚠️ 0xE9 bilan boshlanmagan fayl rad etiladi.
    await http
      .post('/api/v1/firmware/releases')
      .set(auth())
      .attach('file', Buffer.from('ANDIJON_FW_VERSION=9.9.9;'), 'bad.bin')
      .expect(400);
  });

  it('type=xona qurilmaga kotyol versiyasi taklif qilinmaydi', async () => {
    const releases = await http
      .get('/api/v1/firmware/releases')
      .set(auth())
      .expect(200);
    const kotyolRelease = (
      releases.body.data as Array<Record<string, string>>
    ).find((item) => item.deviceType === 'kotyol' && item.version === '2.1.1');
    await http
      .post('/api/v1/firmware/rollouts')
      .set(auth())
      .send({
        releaseId: kotyolRelease?.id,
        targetType: 'all',
        maxDevices: 100,
      })
      .expect(201);

    const xonaCheck = await http
      .get(OTA)
      .query({
        a: 'check',
        device_id: XONA_ID,
        version: '1.1.0',
        type: 'xona',
        inst: "12'maktab",
      })
      .set({ 'X-Device-Token': XONA_TOKEN, 'X-Device-Id': XONA_ID })
      .expect(200);
    expect(xonaCheck.text).toBe('{"update":false}');

    // Eski xona proshivkasi (type siz) — tur bazadan olinadi, natija AYNI.
    const legacyCheck = await http
      .get(OTA)
      .query({ a: 'check', device_id: XONA_ID, version: '1.0.0' })
      .set({ 'X-Device-Token': XONA_TOKEN, 'X-Device-Id': XONA_ID })
      .expect(200);
    expect(legacyCheck.text).toBe('{"update":false}');

    const kotyolCheck = await http
      .get(OTA)
      .query({
        a: 'check',
        device_id: KOTYOL_ID,
        version: '2.1.0',
        type: 'kotyol',
        inst: '12-maktab',
      })
      .set({ 'X-Device-Token': KOTYOL_TOKEN, 'X-Device-Id': KOTYOL_ID })
      .expect(200);
    const offer = JSON.parse(kotyolCheck.text) as Record<string, unknown>;
    expect(offer).toMatchObject({ update: true, version: '2.1.1' });
    expect(String(offer.url)).toMatch(
      /^https:\/\/issiqlik-api\.yaxshihayot\.uz\//,
    );
    expect(String(offer.url)).not.toContain('@');
    expect(kotyolCheck.text).not.toMatch(/\\u|\\\//);

    // Yuklab berish: 200, octet-stream, Content-Length = size, gzip yo'q.
    const path = String(offer.url).replace(
      'https://issiqlik-api.yaxshihayot.uz',
      '',
    );
    const download = await http
      .get(path)
      .set({
        'X-Device-Token': KOTYOL_TOKEN,
        'X-Device-Id': KOTYOL_ID,
        'Accept-Encoding': 'gzip, deflate',
      })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(Number(download.headers['content-length'])).toBe(offer.size);
    expect(download.headers['transfer-encoding']).toBeUndefined();
    expect(download.headers['content-encoding'] ?? 'identity').toBe('identity');

    // Har so'rovda qurilma yozuvi yangilanadi.
    const device = await http
      .get(`/api/v1/devices/${xonaUuid}`)
      .set(auth())
      .expect(200);
    expect(device.body.data.deviceType).toBe('xona');
    expect(device.body.data.lastCheckAt).toBeTruthy();
  });

  it('3 marta failed yoki rolled_back — versiya shu qurilmaga boshqa taklif qilinmaydi', async () => {
    const headers = {
      'X-Device-Token': KOTYOL_TOKEN,
      'X-Device-Id': KOTYOL_ID,
    };
    const report = (status: string) =>
      http
        .post(`${OTA}?a=report`)
        .set(headers)
        .send({
          device_id: KOTYOL_ID,
          version: '2.1.0',
          institution_id: "12'maktab",
          status,
          target: '2.1.1',
          message: 'e2e',
        })
        .expect(200);
    for (let i = 0; i < 3; i += 1) await report('failed');

    const check = await http
      .get(OTA)
      .query({
        a: 'check',
        device_id: KOTYOL_ID,
        version: '2.1.0',
        type: 'kotyol',
      })
      .set(headers)
      .expect(200);
    expect(check.text).toBe('{"update":false}');

    const blocks = await http
      .get('/api/v1/firmware/blocks')
      .set(auth())
      .expect(200);
    const block = (blocks.body.data as Array<Record<string, unknown>>).find(
      (item) => item.deviceId === KOTYOL_ID,
    );
    expect(block).toMatchObject({ version: '2.1.1', isBlocked: true });

    // «Qayta urinish» — blok olib tashlanadi va taklif qaytadi.
    await http
      .delete(`/api/v1/firmware/blocks/${block?.id}`)
      .set(auth())
      .expect(200);
    const again = await http
      .get(OTA)
      .query({
        a: 'check',
        device_id: KOTYOL_ID,
        version: '2.1.0',
        type: 'kotyol',
      })
      .set(headers)
      .expect(200);
    expect(JSON.parse(again.text)).toMatchObject({ update: true });

    await report('rolled_back');
    const afterRollback = await http
      .get(OTA)
      .query({
        a: 'check',
        device_id: KOTYOL_ID,
        version: '2.1.0',
        type: 'kotyol',
      })
      .set(headers)
      .expect(200);
    expect(afterRollback.text).toBe('{"update":false}');
  });

  it('qurilmani tahrirlash: tuman saqlanadi, kotyolga ulash yoziladi', async () => {
    const renamed = await http
      .patch(`/api/v1/devices/${xonaUuid}`)
      .set(auth())
      .send({ name: '1-sinf' })
      .expect(200);
    expect(renamed.body.data).toMatchObject({
      name: '1-sinf',
      districtId: districts.asaka,
      location: { district: { key: 'asaka' } },
    });

    const boiler = await http
      .post('/api/v1/boilers')
      .set(auth())
      .send({ districtId: districts.asaka, boilerCount: 1 })
      .expect(201);
    const bound = await http
      .patch(`/api/v1/devices/${xonaUuid}`)
      .set(auth())
      .send({ boilerId: boiler.body.data.id })
      .expect(200);
    expect(bound.body.data).toMatchObject({
      boilerId: boiler.body.data.id,
      districtId: districts.asaka,
      location: { source: 'boiler', district: { key: 'asaka' } },
    });

    // ⚠️ Boshqa tumandagi kotyolga ulab bo'lmaydi.
    const foreign = await http
      .post('/api/v1/boilers')
      .set(auth())
      .send({ districtId: districts.baliqchi, boilerCount: 1 })
      .expect(201);
    await http
      .patch(`/api/v1/devices/${xonaUuid}`)
      .set(auth())
      .send({ boilerId: foreign.body.data.id })
      .expect(400);
  });

  it('tuman mas‘uli boshqa tuman qurilmasini API orqali ko‘ra olmaydi', async () => {
    await http
      .post('/api/v1/users')
      .set(auth())
      .send({
        login: 'e2e.baliqchi',
        password: 'E2e-Baliqchi-Pass-1!',
        fullName: 'Baliqchi tumani mas‘uli',
        role: 'operator',
        districtId: districts.baliqchi,
      })
      .expect(201);
    const login = await http
      .post('/api/v1/auth/login')
      .send({ login: 'e2e.baliqchi', password: 'E2e-Baliqchi-Pass-1!' })
      .expect(200);
    const operator = login.body.data.accessToken as string;

    await http
      .get(`/api/v1/devices/${kotyolUuid}`)
      .set(auth(operator))
      .expect(404);
    await http
      .get(`/api/v1/telemetry/devices/${kotyolUuid}/series`)
      .set(auth(operator))
      .expect(404);
    await http
      .patch(`/api/v1/devices/${kotyolUuid}`)
      .set(auth(operator))
      .send({ name: 'egallash' })
      .expect(404);

    const list = await http
      .get(`/api/v1/devices?districtId=${districts.asaka}`)
      .set(auth(operator))
      .expect(200);
    expect(list.body.meta.total).toBe(0);

    const summary = await http
      .get('/api/v1/dashboard/districts')
      .set(auth(operator))
      .expect(200);
    expect(
      (summary.body.data as Array<{ districtKey: string }>).map(
        (row) => row.districtKey,
      ),
    ).toEqual(['baliqchi']);

    // Admin esa ko'radi.
    await http.get(`/api/v1/devices/${kotyolUuid}`).set(auth()).expect(200);
  });

  it('dashboard: tumanlar kesimida onlayn/oflayn, me‘yordan past va ogohlantirishlar', async () => {
    const res = await http
      .get('/api/v1/dashboard/districts')
      .set(auth())
      .expect(200);
    const asaka = (res.body.data as Array<Record<string, unknown>>).find(
      (row) => row.districtKey === 'asaka',
    );
    expect(asaka).toMatchObject({
      devicesTotal: 2,
      devicesOnline: 2,
      devicesOffline: 0,
    });
    expect(asaka).toHaveProperty('belowNorm');
    expect(asaka).toHaveProperty('openAlerts');
  });
});
