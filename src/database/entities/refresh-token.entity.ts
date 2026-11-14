import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * REFRESH TOKEN — bazada, HASH holida.
 *
 * ⚠️ Tokenning o'zi saqlanmaydi, faqat SHA-256 hash'i: baza nusxasi
 * sizib chiqsa, undagi qiymat bilan tizimga kirib bo'lmaydi.
 *
 * ⚠️ Nega umuman saqlanadi: JWT o'z-o'zidan bekor qilinmaydi. «Chiqish»
 * tugmasi yoki foydalanuvchini o'chirish faqat shu jadvaldagi qatorni
 * o'chirish orqali ishlaydi — aks holda o'chirilgan xodimning tokeni
 * muddati tugaguncha (30 kun) amal qilaverardi.
 */
@Entity('refresh_tokens')
export class RefreshToken extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 255, name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', length: 64, name: 'ip_address', nullable: true })
  ipAddress!: string | null;
}
