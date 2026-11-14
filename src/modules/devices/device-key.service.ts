import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * QURILMA KALITI — yagona manba.
 *
 * ⚠️ Hash SHA-256, bcrypt EMAS va bu ongli qaror. Kalit tekshiruvi HAR
 * SIGNALDA bo'ladi (2000 qurilma × har 30 soniya ≈ sekundiga 66 marta);
 * bcrypt esa ATAYLAB sekin (~100 ms) va shu yuk bilan serverni butunlay
 * band qilardi. Bcrypt sekinligi lug'at hujumidan himoya qiladi, bu
 * yerda esa kalit — 32 bayt TASODIF, ya'ni lug'at hujumi ma'nosiz.
 */
@Injectable()
export class DeviceKeyService {
  /** Yangi kalit: 32 bayt, hex — proshivkadagi kalit bilan bir formatda. */
  generate(): string {
    return randomBytes(16).toString('hex');
  }

  hash(key: string): string {
    return createHash('sha256').update(key.trim()).digest('hex');
  }

  /** Ro'yxatda ko'rinadigan qism: `…ded31b1`. */
  preview(key: string): string {
    const trimmed = key.trim();
    return trimmed.length <= 6 ? trimmed : trimmed.slice(-6);
  }

  /**
   * ⚠️ VAQT BO'YICHA DOIMIY taqqoslash. Oddiy `===` birinchi farq
   * qilgan baytda to'xtaydi va javob vaqtidan kalitni belgima-belgi
   * tanlab olish mumkin bo'lardi. Hash'lar uzunligi bir xil bo'lgani
   * uchun `timingSafeEqual` xavfsiz ishlaydi.
   */
  matches(rawKey: string, storedHash: string): boolean {
    const computed = Buffer.from(this.hash(rawKey), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  }
}
