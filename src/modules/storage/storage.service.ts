import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface StorageConfig {
  region: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface StoredObject {
  bucket: string;
  key: string;
  size: number;
}

/**
 * FAYL ARXIVI — DigitalOcean Spaces (S3 bilan mos API).
 *
 * ⚠️⚠️ HAMMA OBYEKT `private`: bucket'ning ommaviy manzili bo'lsa ham,
 * import fayllari (muassasalar ro'yxati, plata seriyalari) ochiq
 * havolada turmasligi kerak. O'qish kerak bo'lsa — vaqtinchalik imzoli
 * havola bilan, ommaviy URL bilan EMAS.
 *
 * ⚠️ Proshivka (.bin) BU YERGA YOZILMAYDI: ichida umumiy qurilma tokeni
 * bor va OTA yuklash manzili proshivkada qotirilgan — u avvalgidek
 * `FIRMWARE_DIR` dan API orqali beriladi.
 *
 * ⚠️ Kalitlar FAQAT `.env` da. Xato logida faqat xabar matni chiqadi —
 * SDK obyekti (so'rov sarlavhalari bilan) logga yozilmaydi.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const storage = config.get<StorageConfig>('storage');
    const ready = Boolean(
      storage?.endpoint &&
        storage.accessKey &&
        storage.secretKey &&
        storage.bucket,
    );
    this.bucket = storage?.bucket ?? '';
    this.client = ready
      ? new S3Client({
          region: storage!.region,
          endpoint: storage!.endpoint.startsWith('http')
            ? storage!.endpoint
            : `https://${storage!.endpoint}`,
          credentials: {
            accessKeyId: storage!.accessKey,
            secretAccessKey: storage!.secretKey,
          },
          // DO Spaces virtual-hosted uslubni qo'llaydi: <bucket>.<endpoint>
          forcePathStyle: false,
        })
      : null;
    if (!ready) {
      this.logger.warn(
        'Fayl arxivi (DO Spaces) sozlanmagan — import fayllari arxivlanmaydi',
      );
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Faylni YOPIQ holda saqlaydi. Kalit: `<prefix>/YYYY/MM/<vaqt>-<uuid>-<nom>`.
   * ⚠️ Nom faqat lotin/raqam qismi bilan (kirill nom kalitda emas — u
   * auditda saqlanadi): ba'zi vositalar UTF-8 kalitni buzib ko'rsatadi.
   */
  async putPrivate(
    prefix: string,
    fileName: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    if (!this.client) {
      throw new Error('Fayl arxivi sozlanmagan');
    }
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const safe =
      fileName
        .normalize('NFKD')
        .replace(/[^\w.-]+/g, '_')
        .replace(/_+/g, '_')
        // «jadval-_.xlsx» → «jadval.xlsx» (kirill qismi tushib qolganda)
        .replace(/[-_]+(?=\.[^.]+$)/, '')
        .slice(-60) || 'fayl';
    const key = `${prefix}/${now.getUTCFullYear()}/${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}/${stamp}-${randomUUID().slice(0, 8)}-${safe}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ACL: 'private',
        }),
      );
    } catch (error) {
      this.logger.error(
        `Arxivga yozilmadi (${key}): ${error instanceof Error ? error.message : 'nomaʼlum xato'}`,
      );
      throw new Error('Faylni arxivga saqlab bo‘lmadi');
    }
    return { bucket: this.bucket, key, size: body.length };
  }
}
