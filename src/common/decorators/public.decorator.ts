import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Endpoint autentifikatsiyasiz ochiq (login, health, ESP32 ingest).
 *
 * ⚠️ Guard'lar GLOBAL va endpoint sukut bo'yicha YOPIQ. Shuning uchun
 * ochiqlik HAR DOIM aniq yoziladi: yangi kontroller yozgan dasturchi uni
 * tasodifan ochiq qoldira olmaydi.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
