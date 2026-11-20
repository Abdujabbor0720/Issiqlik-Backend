import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { UserRole } from '../../common/constants/enums';
import { District } from '../entities/district.entity';
import { Region } from '../entities/region.entity';
import { User } from '../entities/user.entity';
import {
  applyMahallaPlan,
  buildMahallaPlan,
  readMahallaFile,
} from '../../modules/geo/import/mahalla-import.core';

interface DistrictFeature {
  properties: {
    /** Proshivka kaliti (`andijon-sh`). Eski faylda bo'lmasa `code` dan. */
    key?: string;
    code: string;
    name: string;
    shortName: string;
    soato?: string;
    kind: string;
    centerLng: number;
    centerLat: number;
  };
  geometry: Record<string, unknown>;
}

interface DistrictGeoFile {
  bbox: number[];
  features: DistrictFeature[];
}

/**
 * BO'SH BAZANI TAYYORLASH.
 *
 * ⚠️ Bu MIGRATSIYA emas: migratsiya SXEMANI o'zgartiradi, bu yerda esa
 * MA'LUMOT yoziladi (hududlar, birinchi administrator). Ikkalasi
 * aralashtirilsa, bir kuni hududlar ro'yxati migratsiya ichida qolib
 * ketardi va uni yangilash uchun yangi migratsiya yozish kerak bo'lardi.
 *
 * ⚠️ IDEMPOTENT: har ishga tushishda bajariladi va mavjud ma'lumotga
 * TEGMAYDI. Aks holda deploy har safar tuman nomlarini qayta yozib,
 * qo'lda kiritilgan tuzatishlarni o'chirib yuborardi.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(District)
    private readonly districts: Repository<District>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureGeo();
      await this.ensureMahallas();
      await this.ensureSuperAdmin();
    } catch (error) {
      /*
       * ⚠️ Xato serverni YIQITMAYDI. Bootstrap — qulaylik; baza vaqtincha
       * yetib bo'lmas holatda bo'lsa, server ko'tarilib, keyin o'ziga
       * kelishi kerak. Aks holda bitta tarmoq uzilishi butun xizmatni
       * qayta ishga tushirish siklida qoldirardi.
       */
      this.logger.error(
        'Boshlang‘ich ma’lumotlarni tayyorlab bo‘lmadi',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * MFYLAR — `andijon-tumanlar-mfylar.json` dan, FAQAT katalog bo'sh bo'lsa.
   *
   * ⚠️ Mavjud bazada MFYlarni `ImportMahallas` migratsiyasi yozadi. Yangi
   * bazada esa tumanlar migratsiyadan KEYIN (shu bootstrap'da) yaratiladi va
   * migratsiya bo'sh o'tadi — import shu yerda, AYNI yadro bilan.
   */
  private async ensureMahallas(): Promise<void> {
    const rows = await this.districts.query<
      Array<{ mahallas: number; districts: number }>
    >(
      `SELECT (SELECT COUNT(*) FROM "mahallas")::int AS mahallas,
              (SELECT COUNT(*) FROM "districts")::int AS districts`,
    );
    if (!rows[0] || rows[0].mahallas > 0 || rows[0].districts === 0) return;

    const entries = readMahallaFile();
    if (!entries) return;
    const plan = await buildMahallaPlan(this.districts.manager, entries);
    const inserted = await applyMahallaPlan(this.districts.manager, plan);
    this.logger.log(
      `MFYlar yozildi: ${inserted} ta` +
        (plan.unmatched.length
          ? ` (tanilmagan tumanlar: ${plan.unmatched.join(', ')})`
          : ''),
    );
  }

  /** Andijon viloyati va uning 16 tumani — geojson fayldan. */
  private async ensureGeo(): Promise<void> {
    const existing = await this.districts.count();
    if (existing > 0) return;

    const file = this.readGeoFile();
    if (!file) return;

    const region = await this.regions.save(
      this.regions.create({
        code: 'andijon',
        name: 'Andijon viloyati',
        soato: '1703',
        centerLat: 40.7821,
        centerLng: 72.3442,
        bbox: file.bbox,
      }),
    );

    const rows = file.features.map((feature) =>
      this.districts.create({
        code: feature.properties.code,
        key:
          feature.properties.key ?? feature.properties.code.replace(/_/g, '-'),
        name: feature.properties.name,
        shortName: feature.properties.shortName,
        soato: feature.properties.soato ?? null,
        kind: feature.properties.kind,
        regionId: region.id,
        centerLat: feature.properties.centerLat,
        centerLng: feature.properties.centerLng,
        geometry: feature.geometry,
      }),
    );

    await this.districts.save(rows);
    this.logger.log(
      `Hududlar yozildi: ${region.name}, ${rows.length} ta tuman/shahar`,
    );
  }

  /**
   * ⚠️ FAQAT bazada birorta superadmin YO'Q bo'lganda ishlaydi.
   * Mavjud hisobning paroli `.env` dan O'ZGARMAYDI: aks holda `.env`
   * fayliga teginish huquqi bor har kim istalgan hisobni egallab olardi.
   */
  private async ensureSuperAdmin(): Promise<void> {
    const exists = await this.users.count({
      where: { role: UserRole.SUPER_ADMIN },
    });
    if (exists > 0) return;

    const admin = this.config.get<{
      login: string;
      password: string;
      fullName: string;
    }>('admin');

    if (!admin?.login || !admin?.password) {
      this.logger.warn(
        'Bazada administrator yo‘q, lekin ADMIN_LOGIN / ADMIN_PASSWORD ' +
          'berilmagan — hisob yaratilmadi',
      );
      return;
    }

    await this.users.save(
      this.users.create({
        login: admin.login,
        passwordHash: await bcrypt.hash(admin.password, 10),
        fullName: admin.fullName || 'Tizim administratori',
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      }),
    );

    this.logger.log(`Bosh administrator yaratildi: ${admin.login}`);
  }

  /**
   * ⚠️ Fayl IKKI joydan qidiriladi: `src/…` (ts-node, development) va
   * `dist/…` (kompilyatsiyadan keyin). Faqat bittasi yozilsa, kod
   * lokalda ishlab, prod'da «fayl topilmadi» bilan yiqilardi.
   */
  private readGeoFile(): DistrictGeoFile | null {
    const candidates = [
      join(__dirname, '..', 'seeds', 'data', 'andijon-districts.geojson'),
      join(
        process.cwd(),
        'src',
        'database',
        'seeds',
        'data',
        'andijon-districts.geojson',
      ),
      join(
        process.cwd(),
        'dist',
        'database',
        'seeds',
        'data',
        'andijon-districts.geojson',
      ),
    ];

    for (const path of candidates) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as DistrictGeoFile;
      } catch {
        continue;
      }
    }

    this.logger.error(
      'andijon-districts.geojson topilmadi — tumanlar yozilmadi',
    );
    return null;
  }
}
