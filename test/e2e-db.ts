import { Client } from 'pg';
import { AppDataSource } from '../src/config/data-source';

/**
 * E2E BAZASINI NOLDAN TAYYORLASH: yo'q bo'lsa yaratiladi, sxema tozalanib
 * barcha migratsiyalar qayta yuritiladi.
 *
 * ⚠️⚠️ Faqat nomida `e2e` bo'lgan bazaga tegadi (`test/e2e-env.ts`):
 * ishchi bazani tasodifan tozalab yuborish imkonsiz bo'lishi kerak.
 */
export async function resetE2eDatabase(): Promise<void> {
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
