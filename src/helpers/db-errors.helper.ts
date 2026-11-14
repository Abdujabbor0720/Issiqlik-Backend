/**
 * UNIQUE INDEKS BUZILISHI (PostgreSQL `23505`).
 *
 * ⚠️ Ko'p joyda bu NORMAL holat, xato emas: ikki so'rov bir vaqtda ayni
 * qatorni yaratishga urinadi (takrorlangan o'lchov, ayni qurilma, ayni
 * xona, ayni ochiq ogohlantirish) va ikkinchisi shu xatoni oladi.
 * Natija kerakli — qator bazada.
 *
 * ⚠️ Kod IKKI joydan o'qiladi: TypeORM asl `pg` xatosini `driverError`
 * ichiga o'raydi, lekin ayrim yo'llarda kod to'g'ridan-to'g'ri obyektda
 * bo'ladi. Faqat bittasi tekshirilsa, xato jimgina 500 bo'lib o'tardi.
 *
 * ⚠️ Ilgari bu funksiya ikki faylda NUSXA edi; uchinchi joy (xonalar)
 * qo'shilganda bitta manbaga chiqarildi.
 */
export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  return (
    candidate?.driverError?.code === '23505' || candidate?.code === '23505'
  );
}
