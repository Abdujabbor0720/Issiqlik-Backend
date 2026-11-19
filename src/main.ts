import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
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

  configureApp(app, { apiPrefix, corsOrigins, isProd });

  app.enableShutdownHooks();

  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Andijon viloyati issiqlik monitoring tizimi')
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
      customSiteTitle: 'Andijon viloyati issiqlik monitoring tizimi — API',
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
