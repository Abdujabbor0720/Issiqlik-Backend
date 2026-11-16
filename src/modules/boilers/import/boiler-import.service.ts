import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import { District } from '../../../database/entities/district.entity';
import { assertDistrictAccess } from '../../../helpers/scope.helper';
import {
  StorageService,
  type StoredObject,
} from '../../storage/storage.service';
import {
  ImportError,
  applyImportPlan,
  buildImportPlan,
  readBoilerSheet,
  readDevices,
  type ImportPlan,
  type ImportResult,
} from './boiler-import.core';

export interface UploadedXlsx {
  buffer: Buffer;
  size: number;
  originalname: string;
}

export interface ImportFiles {
  file?: UploadedXlsx[];
  devices?: UploadedXlsx[];
}

/** Excel fayl hajmi chegarasi — jadval 20–50 KB, 5 MB ortig'i bilan yetadi. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * SAYTDAN EXCEL IMPORT — «Kotyollar» → «Excel'dan import».
 *
 * ⚠️⚠️ IKKI QADAM, IKKALASI HAM FAYLNI QAYTA O'QIYDI: `preview` faqat
 * reja qaytaradi (bazaga yozmaydi), `apply` esa o'sha fayllarni QAYTA
 * tahlil qilib, rejani tranzaksiya ichida yangidan tekshiradi. Serverda
 * «oldingi preview» saqlanmaydi: oraliqda baza o'zgargan bo'lsa (boshqa
 * odam muassasa qo'shgan), eski reja ko'r-ko'rona yozilmaydi.
 *
 * ⚠️ Huquq — qozonxona yaratish bilan AYNI (`boilers.create`) va tuman
 * chegarasi: tuman mas'uli faqat o'z tumaniga import qiladi.
 */
@Injectable()
export class BoilerImportService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    private readonly storage: StorageService,
  ) {}

  preview(
    files: ImportFiles,
    districtId: string,
    actor: AuthUser,
  ): Promise<ImportPlan> {
    return this.plan(files, districtId, actor);
  }

  async apply(
    files: ImportFiles,
    districtId: string,
    actor: AuthUser,
  ): Promise<
    ImportPlan & { result: ImportResult; archived: StoredObject[] }
  > {
    const plan = await this.plan(files, districtId, actor);
    const archived = await this.archive(files, plan.district.code);
    const result = await applyImportPlan(
      this.dataSource,
      plan,
      {
        userId: actor.id,
        label: `${actor.fullName} (${actor.login})`,
      },
      {
        archived: archived.map((object) => ({
          bucket: object.bucket,
          key: object.key,
          size: object.size,
        })),
      },
    );
    return { ...plan, result, archived };
  }

  /**
   * ASL FAYLLARNI ARXIVLASH — bazaga yozishdan OLDIN.
   *
   * ⚠️ Arxiv sozlangan bo'lsa-yu saqlab bo'lmasa, import TO'XTAYDI (bazaga
   * hech narsa yozilmaydi): har bir importning manba fayli saqlangan
   * bo'lishi kerak — «bu 106 ta muassasa qaysi fayldan kelgan» degan
   * savolga javob shu. Arxiv umuman sozlanmagan bo'lsa (lokal) — o'tkazib
   * yuboriladi.
   */
  private async archive(
    files: ImportFiles,
    districtCode: string,
  ): Promise<StoredObject[]> {
    if (!this.storage.enabled) return [];
    const prefix = `issiqlik/imports/${districtCode}`;
    const type =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const stored: StoredObject[] = [];
    try {
      for (const [role, file] of [
        ['jadval', files.file?.[0]],
        ['qurilmalar', files.devices?.[0]],
      ] as const) {
        if (!file) continue;
        stored.push(
          await this.storage.putPrivate(
            prefix,
            `${role}-${displayName(file.originalname)}`,
            file.buffer,
            type,
          ),
        );
      }
    } catch {
      throw new ServiceUnavailableException(
        'Asl faylni arxivga (DO Spaces) saqlab bo‘lmadi — import to‘xtatildi, bazaga hech narsa yozilmadi',
      );
    }
    return stored;
  }

  private async plan(
    files: ImportFiles,
    districtId: string,
    actor: AuthUser,
  ): Promise<ImportPlan> {
    assertDistrictAccess(actor, districtId);
    const district = await this.districts.findOne({
      where: { id: districtId },
    });
    if (!district) throw new NotFoundException('Tuman topilmadi');

    const main = files.file?.[0];
    if (!main) {
      throw new BadRequestException(
        'Qozonxonalar jadvali (.xlsx) yuklanmagan',
      );
    }
    assertXlsx(main, 'Qozonxonalar jadvali');
    const devices = files.devices?.[0];
    if (devices) assertXlsx(devices, 'Qurilmalar fayli');

    try {
      const sheet = await readBoilerSheet(main.buffer);
      const serials = devices
        ? await readDevices(devices.buffer)
        : new Map<string, string>();
      return await buildImportPlan(this.dataSource.manager, {
        sheet,
        serials,
        district,
        fileName: displayName(main.originalname),
      });
    } catch (error) {
      if (error instanceof ImportError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

/**
 * ⚠️ Faqat .xlsx: kengaytma VA ichki imzo (ZIP — `PK`). Kengaytmaning
 * o'zi ishonchli emas — nomi o'zgartirilgan istalgan fayl kelishi mumkin.
 */
function assertXlsx(file: UploadedXlsx, label: string): void {
  const name = displayName(file.originalname).toLowerCase();
  const zip =
    file.buffer.length > 4 &&
    file.buffer[0] === 0x50 &&
    file.buffer[1] === 0x4b;
  if (!name.endsWith('.xlsx') || !zip) {
    throw new BadRequestException(
      `${label} .xlsx (Excel) formatida bo‘lishi kerak`,
    );
  }
  if (file.size > IMPORT_MAX_BYTES) {
    throw new BadRequestException(`${label} juda katta (5 MB dan oshmasin)`);
  }
}

/**
 * ⚠️ Multer fayl nomini LATIN1 deb o'qiydi: «Анд ш ММТБ.xlsx» kabi kirill
 * nom «Ð\x90Ð½Ð´…» bo'lib keladi va izohga shu axlat yozilardi. UTF-8 ga
 * qaytariladi; yo'l va boshqaruv belgilari olib tashlanadi.
 */
function displayName(original: string): string {
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  const name = /�/.test(decoded) ? original : decoded;
  return (
    name
      .replace(/[\\/]/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 120) || 'jadval.xlsx'
  );
}
