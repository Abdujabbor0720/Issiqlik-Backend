import { types } from 'pg';

/**
 * DRAYVER TURLARI — Nest konteyneridan OLDIN sozlanadi.
 *
 * 1) `date` (OID 1082) STRING bo'lib qaytadi.
 *    ⚠️ Sukut bo'yicha `node-pg` uni JS `Date` ga aylantiradi va MAHALLIY
 *    yarim tun deb o'qiydi. Toshkentda (+5) `2026-11-13` qiymati
 *    `2026-11-13T00:00+05:00` bo'ladi, `toISOString()` esa uni `2026-11-12`
 *    ga suradi — sana BIR KUN orqaga ketadi.
 *
 * 2) `numeric` (OID 1700) ham STRING bo'lib qoladi (TypeORM sukuti).
 *    Harorat `38.50` satri bo'lib keladi va uni SONGA aylantirish
 *    entity'dagi `transformer` ning vazifasi — shunday qilib "qayerda
 *    aylantirilgan" degan savol bitta javobga ega bo'ladi.
 *
 * `timestamptz` (1184) TEGILMAYDI: u haqiqiy instant va `Date` bo'lib
 * qolishi kerak — telemetriya vaqti aynan shunday saqlanadi.
 */
export function configurePgTypes(): void {
  const DATE_OID = 1082;
  types.setTypeParser(DATE_OID, (value: string) => value);
}
