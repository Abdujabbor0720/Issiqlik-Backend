/**
 * Noma'lum qiymatdan XAVFSIZ satr.
 *
 * ⚠️ Shablon satrida `${value}` yozish yetarli emas: `value` obyekt bo'lsa
 * `[object Object]` chiqadi va xato xabari ma'nosiz bo'lib qoladi.
 */
export function stableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
