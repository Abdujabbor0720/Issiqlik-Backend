import type { TransformFnParams } from 'class-transformer';

/**
 * DTO uchun `@Transform()` yordamchilari — YAGONA joy.
 *
 * ⚠️ Har DTO faylida alohida `const trim = ...` yozilsa, o'n beshta biroz
 * boshqacha nusxa paydo bo'ladi. Bundan tashqari `TransformFnParams.value`
 * tipi `any` va inline callback tip xavfsizligini buzadi — bu yerdagi
 * funksiyalar `unknown` qaytarib, uni tiklaydi.
 */

/** Matnni tozalaydi, matn bo'lmasa tegmaydi. */
export const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : (value as unknown);

/** Tozalaydi va kichik harfga o'tkazadi (login, kod, email). */
export const trimLower = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown);

/** Bo'sh satr → `undefined`, aks holda son. */
export const toNumber = ({ value }: TransformFnParams): unknown =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

export const toNumberWithDefault =
  (fallback: number) =>
  ({ value }: TransformFnParams): unknown =>
    value === undefined || value === null || value === ''
      ? fallback
      : Number(value);

/** `'true' | '1' | true` → `true`; berilmagan bo'lsa `undefined`. */
export const toOptionalBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export const toBoolean = ({ value }: TransformFnParams): unknown =>
  value === true || value === 'true' || value === '1';

/**
 * `?status=active,medium` → `['active','medium']`.
 * ⚠️ Query'da massiv IKKI xil keladi (`a=1&a=2` yoki `a=1,2`) — brauzer,
 * axios va `URLSearchParams` har biri o'zicha yig'adi. Ikkalasi ham
 * qo'llab-quvvatlanadi, aks holda filtr frontend qanday yozilganiga
 * bog'liq bo'lib qolardi.
 */
export const toArray = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

export const toUpperCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toUpperCase() : (value as unknown);

/**
 * BO'SH QIYMAT → `null` (ya'ni «tozalash»).
 *
 * ⚠️⚠️ `undefined` bilan `null` ORASIDAGI FARQ shu yerda hal qilinadi
 * va u foydalanuvchi uchun KO'RINADIGAN farq:
 *   • maydon umuman yuborilmasa (`undefined`) — «tegilmasin»;
 *   • bo'sh satr yoki `null` yuborilsa — «TOZALANSIN».
 * Busiz kotyolga biriktirilgan firmani olib tashlab bo'lmasdi:
 * «Tanlanmagan» ni tanlagan odam bo'sh satr yuborardi, server uni
 * «tegilmasin» deb o'qirdi va eski firma joyida qolaverardi.
 */
export const toNullable = ({ value }: TransformFnParams): unknown => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return typeof value === 'string' ? value.trim() : (value as unknown);
};

/** Bo'sh qiymat → `null`, aks holda son. */
export const toNullableNumber = ({ value }: TransformFnParams): unknown => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return Number(value);
};
