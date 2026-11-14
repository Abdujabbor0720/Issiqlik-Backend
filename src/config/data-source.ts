import { config as loadEnv } from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ENTITIES } from '../database/entities/entity-list';
import { configurePgTypes } from './pg-types';

// TypeORM CLI Nest konteynerisiz ishga tushadi — `.env` ni o'zimiz yuklaymiz.
loadEnv();
configurePgTypes();

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'issiqlik_db',
  entities: ENTITIES,
  migrations: [__dirname + '/../database/migrations/*.{ts,js}'],
  migrationsTableName: 'migrations',
  /*
   * ⚠️ `synchronize` HECH QACHON yoqilmaydi — hatto development'da ham.
   * Sxema faqat migratsiya orqali o'zgaradi: aks holda lokal baza bilan
   * prod baza jimgina ajralib ketadi va o'zgarish uchun migratsiya
   * yozilmay qoladi — deploy paytida esa ustun yo'qligi ma'lum bo'ladi.
   */
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true' ? ['query', 'error'] : ['error'],
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

/**
 * TypeORM CLI (`npm run migration:*`) AYNAN shu eksportni qidiradi.
 * ⚠️ Faylda `DataSource` ning FAQAT BITTA eksporti bo'lishi kerak —
 * `export default` ham qo'shilsa CLI «only one export» xatosi bilan yiqiladi.
 */
export const AppDataSource = new DataSource(dataSourceOptions);
