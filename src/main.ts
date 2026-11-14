import {
  ClassSerializerInterceptor,
  Logger,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configurePgTypes } from './config/pg-types';

// ⚠️ Nest konteyneri yaratilishidan OLDIN: drayver turlari global sozlanadi.
configurePgTypes();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = config.getOrThrow<number>('port');
  const apiPrefix = config.getOrThrow<string>('apiPrefix');
  const corsOrigins = config.getOrThrow<string[]>('corsOrigins');
  const isProd = config.get<string>('env') === 'production';

  /*
   * ⚠️⚠️ `/api/data` GLOBAL PREFIKSDAN CHIQARIB YUBORILGAN.
   *
   * ESP32 proshivkasida manzil qotirib yozilgan:
   *   const char* API_URL = "http://localhost:3000/api/data";
   * va u dala sharoitida o'nlab qurilmada turibdi. Prefiks qo'shilsa,
   * HAR BIR qurilmani qaytadan proshivka qilish kerak bo'lardi —
   * aks holda ular jimgina 404 olib, telemetriya yo'qolib turardi.
   *
   * Yangi proshivkalar uchun `/{prefix}/telemetry/ingest` ham mavjud va
   * ikkalasi AYNI servisni chaqiradi.
   */
  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      { path: 'api/data', method: RequestMethod.POST },
      { path: 'api/data/health', method: RequestMethod.GET },

      /*
       * ⚠️⚠️ ESP32 v2.0.0 — MANZIL PROSHIVKADA QOTIRILGAN:
       *   #define SERVER_URL "https://" SERVER_HOST
       *                      "/index.php/api/integrations/telemetry"
       *   #define OTA_URL    "https://" SERVER_HOST "/ota/index.php"
       *
       * `/index.php/` bo'lagi — PHP hostingi izi (XUSS'da Apache
       * rewrite yoqilmagan). Bizda PHP yo'q, bu shunchaki yo'l
       * bo'lagi. Prefiks qo'shilsa, qurilmalar 404 olib, telemetriya
       * ham, masofadan yangilash ham butunlay to'xtardi.
       */
      {
        path: 'index.php/api/integrations/telemetry',
        method: RequestMethod.POST,
      },
      { path: 'api/integrations/telemetry', method: RequestMethod.POST },
      // ⚠️ `?a=check` va `?a=download` — ikkisi ham GET, bitta yo'lda.
      { path: 'ota/index.php', method: RequestMethod.GET },
      // ⚠️ `?a=report` — POST, AYNI yo'lda.
      { path: 'ota/index.php', method: RequestMethod.POST },
    ],
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );
  /*
   * ⚠️⚠️ PROSHIVKA FAYLI HECH QACHON SIQILMAYDI.
   *
   * Bu — eng jimgina buziladigan joy. `compression` paketi
   * `compressible('application/octet-stream')` ni `true` deb biladi
   * (tekshirilgan), ya'ni SUKUT bo'yicha `.bin` faylni ham gzip
   * qiladi. Natijada:
   *   • `Content-Length` sarlavhasi YO'QOLADI (chunked encoding);
   *   • qurilma esa uni `size` bilan AYNAN solishtiradi
   *     (`ota.cpp`: `if (len != size) return "hajm mos emas"`).
   * Ya'ni HAR BIR yangilanish 100% xato bilan tugardi va sabab
   * serverda emas, mijozda qidirilardi.
   *
   * Texnik topshiriq §6 ham aynan shuni talab qiladi: «Chunked
   * encoding, gzip yoki redirect bo'lmasin».
   *
   * ⚠️ Filtr YO'L bo'yicha ishlaydi, `Content-Type` bo'yicha EMAS:
   * `filter` javob sarlavhalari yozilishidan OLDIN ham chaqirilishi
   * mumkin va o'sha paytda tur hali ma'lum bo'lmaydi.
   */
  app.use(
    compression({
      filter: (req, res) => {
        if (req.path === '/ota/index.php') return false;
        if (req.path.endsWith('/firmware/download')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(cookieParser());

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept-Language',
      // ⚠️ Qurilma kaliti sarlavhalari: brauzerdan test qilinganda
      // (Swagger, Postman veb-versiyasi) preflight ularni so'raydi.
      'x-api-key',
      'api-key',
      'x-device-key',
    ],
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      /*
       * ⚠️ `whitelist` + `forbidNonWhitelisted`: DTO'da e'lon qilinmagan
       * maydon JIM o'tkazib yuborilmaydi, balki xato qaytaradi. Aks
       * holda mijoz `role: "super_admin"` kabi maydonni qo'shib
       * yuborishi va u `Object.assign` orqali bazaga tushib ketishi
       * mumkin edi.
       *
       * ⚠️ Telemetriya ingest'i bu qoidadan TASHQARIDA: u `@Body()` DTO
       * ishlatmaydi va yukni qo'lda tekshiradi (`ingest.controller.ts`
       * dagi izoh) — proshivkadagi qo'shimcha maydonlar (`rssi`,
       * `uptime`) xato bo'lib qaytmasligi uchun.
       */
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.enableShutdownHooks();

  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Issiqlik — qozonxonalarni monitoring qilish tizimi')
      .setDescription(
        'Hududlardagi kotyollarni (qozonxonalarni) ESP32 modullari orqali ' +
          'real vaqtda kuzatish API’si.\n\n' +
          'Barcha javoblar bitta konvertda: `{ success, data, meta?, timestamp }`.\n' +
          'Xatolar: `{ success: false, statusCode, error: { code, message, details? } }`.\n\n' +
          '**ESP32 uchun:** `POST /api/data` — `x-api-key` sarlavhasi bilan, ' +
          'yuk: `{ "deviceId": "modul1", "temperature": 54.5 }`.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
        'bearer',
      )
      .addApiKey(
        { type: 'apiKey', name: 'x-api-key', in: 'header' },
        'device-key',
      )
      .addServer(`http://localhost:${port}`)
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'Issiqlik — API',
    });
  }

  await app.listen(port, '0.0.0.0');

  logger.log(`Server ishga tushdi:  http://localhost:${port}/${apiPrefix}`);
  logger.log(`ESP32 endpoint:       http://localhost:${port}/api/data`);
  if (!isProd) {
    logger.log(
      `API hujjatlari:       http://localhost:${port}/${apiPrefix}/docs`,
    );
  }
  logger.log(`Muhit: ${config.get('env')} | CORS: ${corsOrigins.join(', ')}`);
}

void bootstrap();
