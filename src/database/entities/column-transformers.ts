import type { ValueTransformer } from 'typeorm';

/**
 * `numeric` → `number` — YAGONA joy.
 *
 * ⚠️ PostgreSQL `numeric` ustuni drayverdan SATR bo'lib qaytadi
 * (`"38.50"`). Sabab: `numeric` ixtiyoriy aniqlikda va `double` ga
 * aylantirilsa pul/harorat qiymati jim buziladi. Lekin harorat bu yerda
 * ikki kasrli va u bilan ARIFMETIKA qilinadi (o'rtacha, farq, foiz) —
 * satr bo'lsa `"38.50" + 1` → `"38.501"` degan jim xato chiqardi.
 *
 * Shuning uchun aylantirish ENTITY darajasida, bitta transformerda:
 * servislar har joyda `Number(...)` yozmaydi va bitta unutilgan joy
 * qolmaydi.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value ?? null,
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/** Majburiy (null bo'lmaydigan) `numeric` ustuni uchun. */
export const requiredNumericTransformer: ValueTransformer = {
  to: (value: number) => value,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
};
