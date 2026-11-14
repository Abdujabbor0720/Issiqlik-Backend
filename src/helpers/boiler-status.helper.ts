import { BoilerStatus } from '../common/constants/enums';

/**
 * HOLAT CHEGARALARI — hisoblash uchun kerakli minimal to'plam.
 * ⚠️ `SystemSetting` entity'si EMAS: bu funksiyani test qilish uchun
 * baza qatori yasash shart bo'lmasligi kerak.
 */
export interface StatusThresholds {
  activeMinC: number;
  mediumMinC: number;
  criticalMinC: number;
  offlineAfterMinutes: number;
}

export interface StatusInput {
  temperature: number | null | undefined;
  /** Oxirgi o'lchov vaqti. `null` — hech qachon signal kelmagan. */
  lastReadingAt: Date | null | undefined;
  /** Hisoblash lahzasi — testda qotirib beriladi. */
  now?: Date;
}

/**
 * KOTYOL HOLATI — BUTUN TIZIMDAGI YAGONA formula.
 *
 * ⚠️⚠️ Bu funksiya UCH joydan chaqiriladi va UCHALASI ham AYNI javobni
 * berishi shart:
 *   1) telemetriya kelganda (`telemetry.service.ts`) — qator muhrlanadi;
 *   2) holat kuzatuvchisi cron'ida — signal kelmay qo'ysa holat
 *      o'z-o'zidan «aloqa yo'q» ga o'tadi;
 *   3) seed/demo generatorida.
 * Ikkinchi nusxa paydo bo'lsa, xaritadagi rang bilan kotyol kartasidagi
 * yozuv bir-biriga zid bo'lib qolardi — tizimning butun mohiyati esa
 * aynan bitta haqiqatni ko'rsatishda.
 *
 * QOIDA (foydalanuvchi bergan, °C bo'yicha):
 *   • signal yo'q yoki eskirgan            → `offline` (aloqa yo'q)
 *   • harorat < kritik (20)                → `offline` (kotyol sovuq)
 *   • kritik ≤ harorat < o'rta (20–40)     → `inactive` (ishlamayapti)
 *   • o'rta ≤ harorat < faol (40–50)       → `medium` (o'rta ishlayapti)
 *   • harorat ≥ faol (50)                  → `active` (faol ishlayapti)
 *
 * ⚠️ «Aloqa yo'q» va «sovuq» BITTA holatga (`offline`) tushadi: ikkalasida
 * ham kotyol isitmayapti va rahbar uchun natija bir xil. Farq kerak
 * bo'lganda `lastReadingAt` ning bor-yo'qligi aytadi — kotyol kartasida
 * aynan shu yoziladi.
 */
export function resolveBoilerStatus(
  input: StatusInput,
  thresholds: StatusThresholds,
): BoilerStatus {
  const now = input.now ?? new Date();

  // 1) Aloqa. ⚠️ HARORATDAN OLDIN tekshiriladi: eskirgan o'lchov issiq
  //    bo'lishi mumkin va u kotyolni abadiy «faol» qilib qo'yardi.
  if (!input.lastReadingAt) return BoilerStatus.OFFLINE;

  const ageMs = now.getTime() - new Date(input.lastReadingAt).getTime();
  if (ageMs > thresholds.offlineAfterMinutes * 60_000) {
    return BoilerStatus.OFFLINE;
  }

  // 2) Harorat yo'q (qurilma ulangan, lekin datchik qiymat bermayapti).
  const temp = input.temperature;
  if (temp === null || temp === undefined || Number.isNaN(temp)) {
    return BoilerStatus.OFFLINE;
  }

  if (temp >= thresholds.activeMinC) return BoilerStatus.ACTIVE;
  if (temp >= thresholds.mediumMinC) return BoilerStatus.MEDIUM;
  if (temp >= thresholds.criticalMinC) return BoilerStatus.INACTIVE;
  return BoilerStatus.OFFLINE;
}

/** Holatning o'zbekcha nomi — jurnal, eksport va ogohlantirish matnida. */
export const BOILER_STATUS_LABELS: Record<BoilerStatus, string> = {
  [BoilerStatus.ACTIVE]: 'Faol ishlayotgan',
  [BoilerStatus.MEDIUM]: 'O‘rta ishlayotgan',
  [BoilerStatus.INACTIVE]: 'Ishlamayotgan',
  [BoilerStatus.OFFLINE]: 'Aloqa yo‘q',
};

/**
 * «ISHLAYOTGAN» DEB SANALADIGAN HOLATLAR.
 *
 * ⚠️ Dashboard'dagi «Umumiy ishlayotgan kotyollar» kartasi aynan shu
 * ro'yxatdan hisoblanadi. Qiymat qotirib yozilmaydi: ertaga `medium`
 * ishlayotganlar qatoridan chiqarilsa, kartani ham, xaritani ham,
 * hisobotni ham qidirib yurish kerak bo'lardi.
 */
export const WORKING_STATUSES: BoilerStatus[] = [
  BoilerStatus.ACTIVE,
  BoilerStatus.MEDIUM,
];
