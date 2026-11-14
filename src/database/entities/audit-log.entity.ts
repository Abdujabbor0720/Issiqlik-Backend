import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { AuditAction } from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * AUDIT JURNALI — «kim, qachon, nimani o'zgartirdi».
 *
 * ⚠️ Jurnal QAT'IY append-only: yozuv tahrirlanmaydi ham, o'chirilmaydi
 * ham. Tahrirlanadigan audit — audit emas.
 *
 * ⚠️ `before`/`after` XOM obyekt sifatida saqlanadi: «qaysi maydon
 * o'zgardi» degan savol farqni hisoblash bilan javob topadi va buning
 * uchun ikkala holat ham kerak. Faqat farqni saqlash yetarli emas —
 * keyin yangi maydon qo'shilsa, eski yozuvlar uni ko'rsatmasdi.
 */
@Entity('audit_logs')
@Index('IDX_audit_entity', ['entityName', 'entityId'])
export class AuditLog extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  /** Kim bo'lgani MATN bilan ham yoziladi: foydalanuvchi o'chirilsa ham qoladi. */
  @Column({ type: 'varchar', length: 160, name: 'actor_label', nullable: true })
  actorLabel!: string | null;

  @Column({ type: 'enum', enum: AuditAction })
  action!: AuditAction;

  @Column({ type: 'varchar', length: 64, name: 'entity_name' })
  entityName!: string;

  @Column({ type: 'uuid', name: 'entity_id', nullable: true })
  entityId!: string | null;

  /** Inson o'qiydigan sarlavha: «Lot 2026-114, Jalaquduq». */
  @Column({ type: 'varchar', length: 300, nullable: true })
  summary!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, name: 'ip_address', nullable: true })
  ipAddress!: string | null;
}
