/**
 * E2E TEST MUHITI — test fayllari yuklanishidan OLDIN ishlaydi
 * (`jest-e2e.json` → `setupFiles`).
 *
 * ⚠️⚠️ ALOHIDA BAZA (`issiqlik_e2e`): testlar sxemani noldan yaratadi va
 * ishchi bazaga (`.env` dagi `DB_NAME`) HECH QACHON tegmaydi. Ulanish
 * parametrlari (host, port, foydalanuvchi, parol) `.env` dan olinadi.
 *
 * ⚠️ `dotenv` mavjud o'zgaruvchilarni bosib yozmaydi — shuning uchun bu
 * yerda qo'yilgan qiymatlar `.env` dagidan ustun.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.E2E_DB_NAME ?? 'issiqlik_e2e';
process.env.ADMIN_LOGIN = 'e2e.admin';
process.env.ADMIN_PASSWORD = 'E2e-Admin-Pass-2026!';
process.env.ADMIN_FULL_NAME = 'E2E administrator';
process.env.DEVICE_SHARED_TOKEN = '';
process.env.PUBLIC_BASE_URL = 'https://issiqlik-api.yaxshihayot.uz';
process.env.FIRMWARE_DIR = mkdtempSync(join(tmpdir(), 'issiqlik-e2e-fw-'));
process.env.DB_LOGGING = 'false';
process.env.THROTTLE_LIMIT = '10000';
