/**
 * Qozonxonaning QISQA nomi — log, audit va ogohlantirish matnlari uchun.
 *
 * ⚠️ Lot raqami ixtiyoriy (migratsiya `OptionalLotNumber`): usiz
 * matnlar «Lot null: kotyol sovuq» bo'lib chiqardi. Lot bo'lmasa —
 * muassasa nomi, u ham bo'lmasa — umumiy «Lotsiz qozonxona».
 */
export function lotRef(
  lotNumber: string | null | undefined,
  organizationName?: string | null,
): string {
  if (lotNumber) return `Lot ${lotNumber}`;
  if (organizationName) return organizationName;
  return 'Lotsiz qozonxona';
}
